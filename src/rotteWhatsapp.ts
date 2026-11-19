// Rotte della Fase 3 (WhatsApp) per l'interfaccia. Tutte sotto /api: valgono l'accesso (sessione), il controllo Origin,
// il JSON obbligatorio e il registro. I segreti del collegamento non tornano mai al browser (solo «impostato»).
// Il numero di telefono si mostra solo mascherato (ultime 3 cifre). Il webhook pubblico è in whatsapp/webhook.ts.
import type { Express, Response } from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { registra } from "./registro.js";
import { leggiImpostazioni } from "./impostazioni.js";
import type { ServizioWhatsapp } from "./whatsapp/servizio.js";
import { ErroreWhatsapp, MAX_TESTO_RISPOSTA, PRIVATO, type ContattoWa, type MessaggioWa, type RispostaWa } from "./whatsapp/tipi.js";
import { collegamentoVisibile, invioPronto, webhookAttivo, salvaCollegamento, scollega, SchemaModificaCollegamento } from "./whatsapp/collegamento.js";
import { dimenticaConnessione, leggiConnessione, leggiSync, assicuraConnessione, syncFatta, ultimaAttivita, ultimaEco } from "./whatsapp/connessione.js";
import { configuraWebhook360, provaCollegamento, sincronizzaChat } from "./whatsapp/fornitore.js";
import { riepilogoInviiWa } from "./whatsapp/contatore.js";
import { elencaChat, leggiContatto, leggiRisposta, mediaDi, nomeContatto, nomeSpazio, risposteAperte, statoChat, ultimiMessaggi } from "./whatsapp/archivio.js";
import { domandeAperte, rispondiDomanda } from "./whatsapp/attribuzione.js";
import { correggiRisposta, improntaRisposta, inviaRisposta, preparaRisposta, proponiTesto, scartaRisposta } from "./whatsapp/risposte.js";
import { spaziWhatsapp } from "./whatsapp/strumentiWhatsapp.js";
import { mascheraTelefono } from "./whatsapp/telefono.js";

export interface OpzioniRotteWa { db: Db; whatsapp: ServizioWhatsapp; origini: () => string[] }

function errore(res: Response, e: unknown) {
  if (e instanceof ErroreWhatsapp) return res.status(e.stato).json({ errore: e.message });
  return res.status(500).json({ errore: "Operazione non riuscita." });
}

const VISTA = z.enum(["privato", "lavoro", "tutto"]);

export function montaRotteWhatsapp(app: Express, o: OpzioniRotteWa): void {
  const { db } = o;
  const dip = o.whatsapp.dip;
  const fonte = { db, cifratore: dip.cifratore };

  const vistaContatto = (c: ContattoWa) => ({
    id: c.id, nome: nomeContatto(c), numero: mascheraTelefono(c.wa_id), gruppo: !!c.gruppo,
    spazio: c.spazio, nomeSpazio: nomeSpazio(c.spazio, dip.aziende()), sceltoDaLuigi: c.fonte_spazio === "luigi", trovatoInCostructo: c.fonte_spazio === "costructo",
  });
  const vistaMessaggio = (m: MessaggioWa) => {
    const x = mediaDi(m);
    return {
      id: m.id, direzione: m.direzione, tipo: m.tipo, quando: m.quando, testo: m.testo, storico: !!m.storico, automatico: !!m.automatico,
      allegato: x.tipo ? { tipo: x.tipo, mime: x.mime ?? "", nomeFile: x.nomeFile ?? "", didascalia: x.didascalia ?? "" } : null,
      statoInvio: m.stato_invio, erroreInvio: m.errore_invio, riassunto: m.riassunto, urgente: !!m.urgente, motivo: m.motivo, tocca: !!m.tocca, stato: m.stato,
      // Fase 3b: cosa ha visto Jarvis (cantiere, posizione vicina) e le proposte nate dal messaggio.
      ...funzioniMessaggio(m.id),
    };
  };
  const funzioniMessaggio = (id: string) => {
    const a = db.prepare("SELECT cantiere_nome, esito FROM wa_analisi WHERE messaggio_id = ?").get(id) as { cantiere_nome: string; esito: string } | undefined;
    const proposte = (db.prepare("SELECT id, tipo, stato FROM proposte WHERE messaggio_id = ? AND stato <> 'scartata'").all(id) as Array<{ id: string; tipo: string; stato: string }>);
    let esito: Record<string, unknown> = {};
    try { esito = a ? JSON.parse(a.esito) : {}; } catch { /* */ }
    return { cantiere: a?.cantiere_nome ?? "", vicino: typeof esito.vicino === "string" ? { cantiere: esito.vicino, metri: Number(esito.metri) || 0 } : null, proposte };
  };
  // «impronta»: contatto + testo esatto. Il browser la rimanda con la conferma: parte solo il testo mostrato.
  const vistaRisposta = (r: RispostaWa) => ({ id: r.id, tipo: r.tipo, testo: r.testo, creata: r.creata, stato: r.stato, esito: r.esito, impronta: improntaRisposta(r) });

  // ------------------------------------------------------------ Impostazioni → WhatsApp
  const opzFornitore = () => ({ ...fonte, fetchFn: dip.fetchFn, risolvi: dip.risolvi, ora: dip.ora });
  const statoImpostazioni = () => {
    const conn = leggiConnessione(db);
    const sync = leggiSync(db);
    return {
      ...collegamentoVisibile(fonte, o.origini()),
      confermeAutomatiche: leggiImpostazioni(db).whatsappConfermeAutomatiche,
      nascondiContenuto: leggiImpostazioni(db).whatsappNascondiContenuto,
      // Parte 2: stato del collegamento (eventi di Meta), sincronizzazione una tantum, messaggi mandati da Jarvis nel mese.
      connessione: conn ? { stato: conn.stato, evento: conn.evento, quando: conn.quando, collegatoIl: conn.collegatoIl, ultimaAttivita: ultimaAttivita(db), ultimaEco: ultimaEco(db), coesistenza: conn.coesistenza } : null,
      sync: { ...sync, fatta: syncFatta(sync) },
      invii: riepilogoInviiWa(db, dip.fuso, dip.ora?.()),
    };
  };
  app.get("/api/whatsapp/collegamento", (_req, res) => { res.json(statoImpostazioni()); });
  app.put("/api/whatsapp/collegamento", async (req, res) => {
    const d = SchemaModificaCollegamento.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Dati non validi." });
    try {
      const c = await salvaCollegamento({ ...fonte, risolvi: dip.risolvi }, d.data);
      // Da qui partono le 24 ore della sincronizzazione e il controllo dei 14 giorni (nuovo fornitore = da capo).
      if (invioPronto(c) || webhookAttivo(c)) assicuraConnessione(db, c.provider, c.phoneNumberId, dip.ora?.() ?? Date.now());
      // Nel registro solo i nomi dei campi cambiati, mai i valori.
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["whatsapp", ...Object.keys(d.data).filter((k) => (d.data as Record<string, unknown>)[k] !== "")] });
      res.json(statoImpostazioni());
    } catch (e) {
      registra(db, "collegamenti.modifica", "errore", "luigi", { campi: ["whatsapp"], motivo: e instanceof ErroreWhatsapp ? e.message : "errore" });
      errore(res, e);
    }
  });
  app.delete("/api/whatsapp/collegamento", (_req, res) => {
    scollega(fonte);
    dimenticaConnessione(db);
    registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["whatsapp.rimuovi"] });
    res.json(statoImpostazioni());
  });
  // Parte 2 — solo con un pulsante di Luigi. Nessun segreto nelle risposte né nel registro.
  app.post("/api/whatsapp/360dialog/webhook", async (_req, res) => {
    try {
      const e = await configuraWebhook360(opzFornitore(), o.origini());
      res.status(e.ok ? 200 : 502).json({ ...e, stato: statoImpostazioni() });
    } catch (e) { errore(res, e); }
  });
  app.post("/api/whatsapp/prova", async (_req, res) => {
    const e = await provaCollegamento(opzFornitore());
    registra(db, "whatsapp.prova", e.ok ? "fatto" : "errore", "luigi", { esito: e.ok ? "ok" : e.messaggio.slice(0, 120) });
    res.json(e);
  });
  app.post("/api/whatsapp/sincronizza", async (req, res) => {
    const d = z.object({ conferma: z.literal(true) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Serve la tua conferma: la sincronizzazione si fa una volta sola." });
    try {
      const e = await sincronizzaChat(opzFornitore());
      res.status(e.ok ? 200 : 502).json({ ...e, stato: statoImpostazioni() });
    } catch (e) { errore(res, e); }
  });

  // ------------------------------------------------------------ pagina WhatsApp
  app.get("/api/whatsapp/chat", (req, res) => {
    const vista = VISTA.safeParse(req.query.vista).success ? (req.query.vista as "privato" | "lavoro" | "tutto") : "tutto";
    const giorni = Math.max(1, Math.min(30, Number(req.query.giorni) || 7));
    const spazi = spaziWhatsapp(db, vista, dip.aziende());
    const chat = elencaChat(db, { spazi, giorni, soloUrgenti: req.query.soloUrgenti === "1", limite: 150 });
    const aziende = dip.aziende();
    // Le domande «di quale azienda è?» si vedono nella scheda Tutto (il contatto non è ancora né privato né di lavoro).
    res.json({
      vista,
      collegamento: collegamentoVisibile(fonte, o.origini()),
      aziende: aziende.map((a) => ({ id: a.id, nome: a.nome })),
      gruppi: [...new Set(spazi)].map((s) => ({ spazio: s, nome: nomeSpazio(s, aziende) })),
      domande: vista === "tutto" ? domandeAperte(db, aziende) : [],
      chat: chat.map((r) => ({
        contatto: vistaContatto(r.contatto), ultimo: vistaMessaggio(r.ultimo), urgenti: r.urgenti, senzaRisposta: r.stato.senzaRisposta,
        dentroFinestra: r.stato.dentroFinestra, soloStorico: r.storico,
        proposte: risposteAperte(db, r.contatto.id).filter((x) => x.stato === "proposta").length,
      })),
    });
  });
  app.get("/api/whatsapp/chat/:id", (req, res) => {
    const c = leggiContatto(db, String(req.params.id));
    if (!c) return res.status(404).json({ errore: "Chat non trovata (forse più vecchia di 30 giorni)." });
    const s = statoChat(db, c.id);
    res.json({
      contatto: vistaContatto(c), senzaRisposta: s.senzaRisposta, dentroFinestra: s.dentroFinestra && !c.gruppo,
      esclusa: leggiImpostazioni(db).chatPrivateEscluse.includes(c.id),
      messaggi: ultimiMessaggi(db, c.id, 40).map(vistaMessaggio), risposte: risposteAperte(db, c.id).map(vistaRisposta),
    });
  });
  app.post("/api/whatsapp/chat/:id/proponi", async (req, res) => {
    try {
      const testo = await proponiTesto(dip, String(req.params.id));
      registra(db, "whatsapp.risposta", "fatto", "luigi", { operazione: "testo proposto", contatto: String(req.params.id) });
      res.json({ testo });
    } catch (e) { errore(res, e); }
  });
  app.post("/api/whatsapp/chat/:id/risposte", (req, res) => {
    const d = z.object({ testo: z.string().min(1).max(MAX_TESTO_RISPOSTA) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi il testo della risposta." });
    try { res.json(vistaRisposta(preparaRisposta(dip, String(req.params.id), d.data.testo, "risposta", "bozza", "luigi"))); } catch (e) { errore(res, e); }
  });
  // Luigi corregge il testo: il server lo salva pulito e restituisce testo e impronta da mostrare nella conferma.
  app.patch("/api/whatsapp/risposte/:id", (req, res) => {
    const d = z.object({ testo: z.string().min(1).max(MAX_TESTO_RISPOSTA) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi il testo della risposta." });
    try { res.json(vistaRisposta(correggiRisposta(dip, String(req.params.id), d.data.testo))); } catch (e) { errore(res, e); }
  });
  // L'invio vero: solo con {conferma: true} e l'impronta del testo mostrato nella conferma (pulsante «Sì, manda»).
  app.post("/api/whatsapp/risposte/:id/invia", async (req, res) => {
    const d = z.object({ conferma: z.literal(true), impronta: z.string().regex(/^[0-9a-f]{64}$/) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Serve la tua conferma per mandare il messaggio." });
    const r = leggiRisposta(db, String(req.params.id));
    if (!r) return res.status(404).json({ errore: "Risposta non trovata." });
    try { res.json(await inviaRisposta(dip, r.id, d.data.impronta)); } catch (e) { errore(res, e); }
  });
  app.delete("/api/whatsapp/risposte/:id", (req, res) => {
    res.status(scartaRisposta(dip, String(req.params.id)) ? 200 : 404).json({ ok: true });
  });

  // ------------------------------------------------------------ «Di quale azienda è?»
  const SchemaSpazio = z.object({ spazio: z.string().min(1).max(40) }).strict();
  const assegna = (contattoId: string, spazio: string, res: Response) => {
    const c = leggiContatto(db, contattoId);
    if (!c) return res.status(404).json({ errore: "Contatto non trovato." });
    if (spazio !== PRIVATO && !dip.aziende().some((a) => a.id === spazio)) return res.status(400).json({ errore: "Azienda non trovata." });
    const nome = rispondiDomanda(dip, c.id, spazio);
    res.json({ ok: true, messaggio: `${nomeContatto(c)}: ${nome}. Me lo ricordo.` });
  };
  app.post("/api/whatsapp/domande/:id", (req, res) => {
    const d = SchemaSpazio.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scegli un'azienda o «Privato»." });
    const q = db.prepare("SELECT contatto_id FROM wa_domande WHERE id = ?").get(String(req.params.id)) as { contatto_id: string } | undefined;
    if (!q) return res.status(404).json({ errore: "Domanda non trovata." });
    assegna(q.contatto_id, d.data.spazio, res);
  });
  app.put("/api/whatsapp/chat/:id/azienda", (req, res) => {
    const d = SchemaSpazio.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scegli un'azienda o «Privato»." });
    assegna(String(req.params.id), d.data.spazio, res);
  });
  app.post("/api/whatsapp/aggiorna", async (_req, res) => {
    const e = await o.whatsapp.giroOra();
    res.json({ ok: true, messaggio: e.classifica?.tetto ? "Tetto di spesa raggiunto: alcuni messaggi restano senza riassunto." : "Aggiornato." });
  });
}
