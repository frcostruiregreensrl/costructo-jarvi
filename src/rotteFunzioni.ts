// Rotte della Fase 3b (le 20 funzioni WhatsApp) per l'interfaccia: pagina Proposte, «Proponi in Costructo» dalla pagina
// WhatsApp, sezioni del briefing, ricerca unica, rubrica, operai, scontrini, impostazioni (trascrizione, invii automatici,
// chat private escluse), promemoria con i modelli di Meta (parte 2, spenti). Tutte sotto /api: valgono l'accesso, il
// controllo Origin, il JSON obbligatorio e il registro. Le chiavi della trascrizione non tornano mai al browser.
// Nessuna scrittura in Costructo senza {conferma: true} e l'impronta del testo completo che Luigi ha visto.
import type { Express, Response } from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import type { AziendaCollegata } from "./aziende.js";
import { registra } from "./registro.js";
import { leggiImpostazioni, salvaImpostazioni } from "./impostazioni.js";
import type { ServizioWhatsapp } from "./whatsapp/servizio.js";
import { leggiCollegamento, invioPronto } from "./whatsapp/collegamento.js";
import { mandaModello, controllaModello } from "./whatsapp/invio.js";
import { leggiContatto, nomeContatto } from "./whatsapp/archivio.js";
import { normalizzaTelefono, mascheraTelefono } from "./whatsapp/telefono.js";
import { ErroreWhatsapp, PRIVATO } from "./whatsapp/tipi.js";
import { improntaConferma, stessaImpronta } from "./sicurezza/testoConfermato.js";
import { correggiProposta, leggiProposta, proposteVisibili, scartaProposta, vistaProposta, allegatiDi } from "./proposte/archivio.js";
import { mandaProposte, aggiornaStatiProposte, nomeAziendaDi, MAX_LOTTO } from "./proposte/invio.js";
import { randomBytes } from "node:crypto";
import { CAMPI, ErroreProposte, NOMI_TIPI, TIPI_COSTRUCTO, tipoValido, vaACostructo } from "./proposte/tipi.js";
import { proponiDaMessaggio } from "./funzioni/analisi.js";
import { briefingFunzioni, chiudiPromessa } from "./funzioni/briefingFunzioni.js";
import { cercaOvunque } from "./funzioni/cerca.js";
import { rubrica, proponiContatto } from "./funzioni/rubrica.js";
import { preparaDiario } from "./funzioni/diario.js";
import { domandeOperaioAperte, rispondiOperaio, elencoOperaiContatti, dimenticaOperaio } from "./funzioni/operai.js";
import { cantieriDi, operaiDi } from "./funzioni/costructoLetture.js";
import { giornoDa } from "./funzioni/date.js";
import { LISTINO_TRASCRIZIONE, leggiChiavi, salvaChiave, spesaTrascrizioniMese, ErroreTrascrizione } from "./trascrizione/trascrizione.js";

export interface OpzioniRotteFunzioni { db: Db; whatsapp: ServizioWhatsapp; aziendeCostructo: () => AziendaCollegata[] }

const VISTA = z.enum(["privato", "lavoro", "tutto"]);
const vistaDa = (q: unknown) => (VISTA.safeParse(q).success ? (q as "privato" | "lavoro" | "tutto") : "tutto");

function errore(res: Response, e: unknown) {
  if (e instanceof ErroreProposte || e instanceof ErroreWhatsapp) return res.status(e.stato).json({ errore: e.message });
  if (e instanceof ErroreTrascrizione) return res.status(400).json({ errore: e.message });
  if (e instanceof Error && e.message) return res.status(400).json({ errore: e.message });
  return res.status(500).json({ errore: "Operazione non riuscita." });
}

export function montaRotteFunzioni(app: Express, o: OpzioniRotteFunzioni): void {
  const { db } = o;
  const dip = o.whatsapp.dip;
  const nome = nomeAziendaDi(dip);
  const oggi = () => giornoDa(Date.now(), 0, dip.fuso);
  const visibile = (aziendaId: string, vista: "privato" | "lavoro" | "tutto") => vista === "tutto" || (vista === "privato") === (aziendaId === PRIVATO);

  // ------------------------------------------------------------ pagina Proposte
  app.get("/api/proposte", (req, res) => {
    const vista = vistaDa(req.query.vista);
    const tutte = proposteVisibili(db, vista, undefined, 300).filter((p) => p.stato !== "scartata");
    res.json({
      vista, aziende: dip.aziende(), tipi: NOMI_TIPI,
      proposte: tutte.map((p) => vistaProposta(p, nome, oggi())),
    });
  });
  app.get("/api/proposte/:id/scelte", async (req, res) => {
    const p = leggiProposta(db, String(req.params.id));
    if (!p) return res.status(404).json({ errore: "Proposta non trovata." });
    const a = o.aziendeCostructo().find((x) => x.id === p.azienda_id && x.client.configurato);
    if (!a) return res.json({ cantieri: [], operai: [] });
    const [cantieri, operai] = await Promise.all([cantieriDi(db, a).catch(() => []), operaiDi(db, a).catch(() => [])]);
    res.json({ cantieri: cantieri.map((c) => ({ id: c.id, nome: c.nome })), operai: operai.filter((x) => x.attivo).map((x) => ({ id: x.id, nome: x.nome })) });
  });
  // I nomi di cantiere e operaio si prendono da Costructo QUI (mai dal browser), e l'id deve esistere per quell'azienda.
  const SchemaCorrezione = z.object({ dati: z.record(z.unknown()), nomi: z.unknown().optional() }).strict();
  app.patch("/api/proposte/:id", async (req, res) => {
    const d = SchemaCorrezione.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Dati non validi." });
    const p = leggiProposta(db, String(req.params.id));
    if (!p) return res.status(404).json({ errore: "Proposta non trovata." });
    const nomi: Record<string, string> = {};
    try {
      const campi = new Map((CAMPI[p.tipo] ?? []).map((c) => [c.chiave, c.tipo]));
      const a = o.aziendeCostructo().find((x) => x.id === p.azienda_id && x.client.configurato);
      for (const [k, v] of Object.entries(d.data.dati)) {
        const tipo = campi.get(k);
        if ((tipo !== "cantiere" && tipo !== "operaio") || v === null || v === "" || v === undefined) continue;
        if (!a) throw new ErroreProposte("Questa azienda non è collegata a Costructo.");
        const elenco = tipo === "cantiere" ? (await cantieriDi(db, a)).map((c) => ({ id: c.id, nome: c.nome })) : (await operaiDi(db, a)).filter((x) => x.attivo);
        const trovato = elenco.find((x) => x.id === String(v));
        if (!trovato) throw new ErroreProposte(`${tipo === "cantiere" ? "Cantiere" : "Operaio"} non trovato in Costructo per ${a.nome}.`);
        nomi[k] = trovato.nome;
      }
      res.json(vistaProposta(correggiProposta(db, p.id, d.data.dati, nomi), nome, oggi()));
    } catch (e) { errore(res, e); }
  });
  app.delete("/api/proposte/:id", (req, res) => { res.status(scartaProposta(db, String(req.params.id)) ? 200 : 404).json({ ok: true }); });
  // L'invio vero: solo con {conferma: true} e l'impronta del testo completo di OGNI proposta (pulsante «Sì, manda»).
  const SchemaManda = z.object({ conferma: z.literal(true), voci: z.array(z.object({ id: z.string().min(1).max(40), impronta: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(MAX_LOTTO) }).strict();
  app.post("/api/proposte/manda", async (req, res) => {
    const d = SchemaManda.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Serve la tua conferma, con le proposte che hai visto." });
    res.json(await mandaProposte(dip, d.data.voci, "luigi"));
  });
  app.post("/api/proposte/aggiorna-stati", async (_req, res) => {
    const n = await aggiornaStatiProposte(dip);
    res.json({ ok: true, messaggio: n ? `Aggiornate ${n} proposte da Costructo.` : "Nessuna novità da Costructo." });
  });
  // Allegato di una proposta, per vederlo prima di confermare (solo foto e PDF già salvati; pagina isolata).
  app.get("/api/proposte/:id/allegato/:n", (req, res) => {
    const p = leggiProposta(db, String(req.params.id));
    const a = p ? allegatiDi(p)[Number(req.params.n)] : undefined;
    const r = a ? db.prepare("SELECT dati, mime FROM wa_allegati WHERE id = ?").get(a.allegatoId) as { dati: Buffer; mime: string } | undefined : undefined;
    if (!r) return res.status(404).json({ errore: "Allegato non trovato." });
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'");
    res.setHeader("Content-Disposition", "inline");
    res.type(r.mime).send(r.dati);
  });
  app.post("/api/proposte/da-messaggio", async (req, res) => {
    const d = z.object({ messaggioId: z.string().min(1).max(40), tipo: z.string().max(40) }).strict().safeParse(req.body);
    if (!d.success || !tipoValido(d.data.tipo)) return res.status(400).json({ errore: "Scegli il tipo di proposta." });
    try {
      const id = await proponiDaMessaggio(dip, d.data.messaggioId, d.data.tipo);
      registra(db, "proposta.prepara", "fatto", "luigi", { proposta: id, tipo: d.data.tipo, da: "messaggio" });
      res.json(vistaProposta(leggiProposta(db, id)!, nome, oggi()));
    } catch (e) { errore(res, e); }
  });
  app.post("/api/proposte/diario", async (req, res) => {
    const d = z.object({ azienda: z.string().min(1).max(40), cantiereId: z.string().min(1).max(80), data: z.string().max(10).optional() }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scegli azienda e cantiere." });
    try {
      const id = await preparaDiario(db, o.aziendeCostructo(), d.data.azienda, d.data.cantiereId, d.data.data || giornoDa(Date.now(), 0, dip.fuso), dip.fuso);
      res.json(vistaProposta(leggiProposta(db, id)!, nome, oggi()));
    } catch (e) { errore(res, e); }
  });

  // ------------------------------------------------------------ briefing, promesse, ricerca, rubrica, scontrini
  app.get("/api/funzioni/briefing", async (req, res) => {
    res.json(await briefingFunzioni({ db, fuso: dip.fuso, vista: vistaDa(req.query.vista), aziende: dip.aziende(), collegate: o.aziendeCostructo() }));
  });
  app.post("/api/funzioni/promesse/:id/chiudi", (req, res) => {
    const ok = chiudiPromessa(db, String(req.params.id));
    if (ok) registra(db, "whatsapp.promessa", "fatto", "luigi", { promessa: String(req.params.id), operazione: "chiusa" });
    res.status(ok ? 200 : 404).json({ ok });
  });
  app.get("/api/funzioni/cerca", async (req, res) => {
    const q = String(req.query.q ?? "").slice(0, 200);
    const vista = vistaDa(req.query.vista);
    const r = await cercaOvunque({ db, vista, aziende: dip.aziende(), collegate: o.aziendeCostructo(), testo: q, azienda: String(req.query.azienda ?? ""), anchePrivato: req.query.privato === "1" });
    registra(db, "ricerca.leggi", "fatto", "luigi", { vista, privato: r.privatoIncluso, trovati: r.risultati.length });
    res.json(r);
  });
  app.get("/api/funzioni/rubrica", async (req, res) => {
    if (vistaDa(req.query.vista) === "privato") return res.json({ aziende: [] });
    res.json({ aziende: await rubrica(db, dip.aziende(), o.aziendeCostructo()) });
  });
  app.post("/api/funzioni/rubrica/:contatto/proponi", async (req, res) => {
    const d = z.object({ controparteId: z.string().min(1).max(80) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scegli la controparte." });
    try { const id = await proponiContatto(db, dip.aziende(), o.aziendeCostructo(), String(req.params.contatto), d.data.controparteId); res.json(vistaProposta(leggiProposta(db, id)!, nome, oggi())); } catch (e) { errore(res, e); }
  });
  app.get("/api/funzioni/scontrini", (req, res) => {
    const vista = vistaDa(req.query.vista);
    const righe = db.prepare("SELECT * FROM scontrini ORDER BY creato DESC LIMIT 100").all() as Array<{ id: string; contatto_id: string; spazio: string; descrizione: string; allegato_id: string; creato: number }>;
    res.json({
      nota: "Gli scontrini restano solo in Jarvis: la Prima Nota è esclusa finché Luigi non decide.",
      scontrini: righe.filter((s) => visibile(s.spazio, vista)).map((s) => {
        const c = leggiContatto(db, s.contatto_id);
        return { id: s.id, contatto: c ? nomeContatto(c) : "Contatto", nomeAzienda: nome(s.spazio), descrizione: s.descrizione, conFoto: !!s.allegato_id, creato: s.creato };
      }),
    });
  });

  // ------------------------------------------------------------ operai («Chi è questo contatto: operaio X?»)
  app.get("/api/funzioni/operai/domande", async (_req, res) => { res.json(await domandeOperaioAperte(db, dip.aziende(), o.aziendeCostructo())); });
  app.post("/api/funzioni/operai/domande/:id", async (req, res) => {
    const d = z.object({ operaioId: z.string().max(80) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scegli un operaio o «Non è un operaio»." });
    const q = db.prepare("SELECT * FROM wa_domande_operaio WHERE id = ? AND stato = 'aperta'").get(String(req.params.id)) as { contatto_id: string; azienda_id: string } | undefined;
    if (!q) return res.status(404).json({ errore: "Domanda non trovata." });
    if (leggiContatto(db, q.contatto_id)?.spazio !== q.azienda_id) return res.status(409).json({ errore: "Il contatto è passato a un'altra azienda: la domanda non vale più." });
    let operaio: { id: string; nome: string } | null = null;
    if (d.data.operaioId) {
      const a = o.aziendeCostructo().find((x) => x.id === q.azienda_id && x.client.configurato);
      const trovato = a ? (await operaiDi(db, a).catch(() => [])).find((x) => x.id === d.data.operaioId) : undefined;
      if (!trovato) return res.status(400).json({ errore: "Operaio non trovato in Costructo." });
      operaio = { id: trovato.id, nome: trovato.nome };
    }
    rispondiOperaio(db, q.contatto_id, q.azienda_id, operaio);
    res.json({ ok: true, messaggio: operaio ? `Fatto: è ${operaio.nome}. Me lo ricordo.` : "Fatto: non è un operaio. Me lo ricordo." });
  });
  app.get("/api/funzioni/operai", (_req, res) => { res.json(elencoOperaiContatti(db, dip.aziende())); });
  app.delete("/api/funzioni/operai/:contatto", (req, res) => {
    const azienda = typeof req.query.azienda === "string" && req.query.azienda ? req.query.azienda : undefined;
    res.status(dimenticaOperaio(db, String(req.params.contatto), azienda) ? 200 : 404).json({ ok: true });
  });

  // ------------------------------------------------------------ Impostazioni → funzioni WhatsApp
  const statoImpostazioni = () => {
    const imp = leggiImpostazioni(db);
    const chiavi = leggiChiavi(db, dip.cifratore);
    return {
      scaricaAllegati: imp.whatsappScaricaAllegati,
      trascrizione: {
        fornitore: imp.trascrizioneFornitore,
        // Le chiavi non tornano MAI: solo se ci sono.
        chiaveImpostata: { google: !!chiavi.google, openai: !!chiavi.openai },
        listino: LISTINO_TRASCRIZIONE,
        spesaMese: spesaTrascrizioniMese(db, dip.fuso),
      },
      proposteAutomatiche: imp.proposteAutomatiche,
      tipi: TIPI_COSTRUCTO.map((t) => ({ tipo: t, nome: NOMI_TIPI[t] })),
      chatEscluse: imp.chatPrivateEscluse.map((id) => { const c = leggiContatto(db, id); return { id, nome: c ? nomeContatto(c) : "Chat non più in Jarvis" }; }),
      giorniPreventiviInAttesa: imp.giorniPreventiviInAttesa,
      modelliAttivi: imp.whatsappModelliAttivi,
    };
  };
  app.get("/api/funzioni/impostazioni", (_req, res) => { res.json(statoImpostazioni()); });
  const SchemaImp = z.object({
    scaricaAllegati: z.boolean().optional(),
    trascrizioneFornitore: z.enum(["nessuno", "google", "openai"]).optional(),
    chiaveGoogle: z.string().max(400).optional(),
    chiaveOpenai: z.string().max(400).optional(),
    proposteAutomatiche: z.array(z.enum(TIPI_COSTRUCTO)).max(10).optional(),
    giorniPreventiviInAttesa: z.number().int().min(1).max(90).optional(),
    modelliAttivi: z.boolean().optional(),
  }).strict();
  app.put("/api/funzioni/impostazioni", (req, res) => {
    const d = SchemaImp.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Impostazioni non valide." });
    try {
      // Prima le chiavi (controllate), poi il resto: un errore non lascia modifiche a metà.
      if (d.data.chiaveGoogle) salvaChiave(db, dip.cifratore, "google", d.data.chiaveGoogle);
      if (d.data.chiaveOpenai) salvaChiave(db, dip.cifratore, "openai", d.data.chiaveOpenai);
      const m: Record<string, unknown> = {};
      if (d.data.scaricaAllegati !== undefined) m.whatsappScaricaAllegati = d.data.scaricaAllegati;
      if (d.data.trascrizioneFornitore !== undefined) m.trascrizioneFornitore = d.data.trascrizioneFornitore;
      if (d.data.proposteAutomatiche !== undefined) m.proposteAutomatiche = d.data.proposteAutomatiche;
      if (d.data.giorniPreventiviInAttesa !== undefined) m.giorniPreventiviInAttesa = d.data.giorniPreventiviInAttesa;
      if (d.data.modelliAttivi !== undefined) m.whatsappModelliAttivi = d.data.modelliAttivi;
      if (Object.keys(m).length) salvaImpostazioni(db, m);
      // Nel registro solo i nomi dei campi, mai le chiavi.
      registra(db, "impostazioni.modifica", "fatto", "luigi", { campi: Object.keys(d.data).map((k) => (k.startsWith("chiave") ? `${k} (impostata)` : k)) });
      res.json(statoImpostazioni());
    } catch (e) { errore(res, e); }
  });
  app.delete("/api/funzioni/impostazioni/chiave/:fornitore", (req, res) => {
    const f = String(req.params.fornitore);
    if (f !== "google" && f !== "openai") return res.status(404).json({ errore: "Non trovato." });
    salvaChiave(db, dip.cifratore, f, "");
    registra(db, "impostazioni.modifica", "fatto", "luigi", { campi: [`chiave ${f} tolta`] });
    res.json(statoImpostazioni());
  });
  app.put("/api/funzioni/chat-escluse/:contatto", (req, res) => {
    const d = z.object({ escludi: z.boolean() }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Dati non validi." });
    const id = String(req.params.contatto);
    const c = leggiContatto(db, id);
    if (d.data.escludi && (!c || c.spazio !== PRIVATO)) return res.status(400).json({ errore: "Si escludono solo le chat private." });
    const elenco = new Set(leggiImpostazioni(db).chatPrivateEscluse);
    if (d.data.escludi) elenco.add(id); else elenco.delete(id);
    salvaImpostazioni(db, { chatPrivateEscluse: [...elenco] });
    registra(db, "impostazioni.modifica", "fatto", "luigi", { campi: [d.data.escludi ? "chat privata esclusa" : "chat privata riammessa"], contatto: id });
    res.json(statoImpostazioni());
  });

  // ------------------------------------------------------------ promemoria con un modello di Meta (parte 2): mai automatico
  const SchemaModello = z.object({ telefono: z.string().min(6).max(30), nome: z.string().min(1).max(512), lingua: z.string().min(2).max(6), parametri: z.array(z.string().max(300)).max(10) }).strict();
  // Ogni «prepara» dà un id che vale UNA volta (si consuma all'invio, anche se fallisce): niente doppio messaggio.
  const preparati = new Map<string, { impronta: string; creato: number }>();
  const improntaModello = (d: z.infer<typeof SchemaModello>) => improntaConferma(`modello:${normalizzaTelefono(d.telefono)}`, JSON.stringify({ nome: d.nome, lingua: d.lingua, parametri: d.parametri }));
  app.post("/api/funzioni/modello/prepara", (req, res) => {
    const d = SchemaModello.safeParse(req.body);
    if (!d.success || !normalizzaTelefono(d.data.telefono)) return res.status(400).json({ errore: "Dati del modello non validi." });
    if (!leggiImpostazioni(db).whatsappModelliAttivi) return res.status(409).json({ errore: "I modelli di Meta sono spenti (parte 2): usa il link wa.me e mandalo tu dal telefono." });
    try { controllaModello({ nome: d.data.nome, lingua: d.data.lingua, parametri: d.data.parametri }); } catch (e) { return errore(res, e); }
    const id = randomBytes(12).toString("hex");
    const ora = Date.now();
    for (const [k, v] of preparati) if (ora - v.creato > 15 * 60_000) preparati.delete(k);
    preparati.set(id, { impronta: improntaModello(d.data), creato: ora });
    res.json({ id, anteprima: `Modello «${d.data.nome}» (${d.data.lingua}) al numero ${mascheraTelefono(d.data.telefono)}, con: ${d.data.parametri.join(" · ") || "nessun testo"}`, impronta: improntaModello(d.data) });
  });
  app.post("/api/funzioni/modello/invia", async (req, res) => {
    const d = SchemaModello.extend({ conferma: z.literal(true), id: z.string().regex(/^[0-9a-f]{24}$/), impronta: z.string().regex(/^[0-9a-f]{64}$/) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Serve la tua conferma per mandare il modello." });
    const { conferma: _c, impronta, id, ...m } = d.data;
    const preparato = preparati.get(id);
    if (!preparato || Date.now() - preparato.creato > 15 * 60_000) return res.status(409).json({ errore: "Questo promemoria è già stato usato o è scaduto: non ho mandato niente." });
    if (!leggiImpostazioni(db).whatsappModelliAttivi) return res.status(409).json({ errore: "I modelli di Meta sono spenti (parte 2): non ho mandato niente." });
    if (!stessaImpronta(impronta, improntaModello(m))) {
      registra(db, "whatsapp.modello", "negato", "sistema", { motivo: "dati diversi da quelli confermati", numero: mascheraTelefono(m.telefono) });
      return res.status(409).json({ errore: "Il modello è cambiato dopo la conferma: non ho mandato niente." });
    }
    if (!stessaImpronta(preparato.impronta, impronta)) return res.status(409).json({ errore: "Il modello è cambiato dopo la conferma: non ho mandato niente." });
    preparati.delete(id); // consumato: un secondo clic non manda un secondo messaggio
    const coll = leggiCollegamento(dip);
    if (!invioPronto(coll)) return res.status(409).json({ errore: "WhatsApp non è collegato (parte 2): non ho mandato niente." });
    try {
      const wamid = await mandaModello(coll, { waId: normalizzaTelefono(m.telefono)!, userId: "" }, { nome: m.nome, lingua: m.lingua, parametri: m.parametri }, {
        fetchFn: dip.fetchFn, attesa: dip.attesaRiprova, risolvi: dip.risolvi, contatore: { db, fuso: dip.fuso, tipo: "modello" },
      });
      registra(db, "whatsapp.modello", "fatto", "luigi", { numero: mascheraTelefono(m.telefono), modello: m.nome, wamid: wamid.slice(0, 60) });
      res.json({ ok: true, messaggio: "Promemoria mandato con il modello di Meta." });
    } catch (e) {
      registra(db, "whatsapp.modello", "errore", "luigi", { numero: mascheraTelefono(m.telefono), motivo: String((e as Error).message).slice(0, 120) });
      errore(res, e);
    }
  });

  // Tipi per la tendina «Proponi in Costructo» (WhatsApp): quelli che vanno a Costructo, più l'agenda privata.
  app.get("/api/proposte/tipi", (_req, res) => { res.json(Object.entries(NOMI_TIPI).map(([tipo, n]) => ({ tipo, nome: n, perCostructo: vaACostructo(tipo) }))); });
}
