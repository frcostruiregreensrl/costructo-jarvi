// Rotte della Fase 2: caselle email, pagina Posta, bozze e calendario Apple.
// Tutte stanno sotto /api: valgono l'accesso (sessione), il controllo Origin, il JSON obbligatorio e il registro.
// Le password non tornano mai al browser e non finiscono mai nel registro; i testi delle mail nemmeno nel registro.
import type { Express, Response } from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { registra } from "./registro.js";
import { leggiImpostazioni } from "./impostazioni.js";
import type { ServizioPosta } from "./posta/servizio.js";
import { ErrorePosta, type DipendenzePosta, type MessaggioPosta } from "./posta/tipi.js";
import {
  PRESET, SchemaNuovaCasella, SchemaModificaCasella, aggiungiCasella, modificaCasella, rimuoviCasella, caselleVisibili,
  provaAccesso, trovaCasella, leggiCaselle, nomeSpazio,
} from "./posta/caselle.js";
import { elencaMessaggi, leggiMessaggio, allegatiDi, segniDi } from "./posta/archivio.js";
import { creaBozza, proponiTestoBozza, bozzeDelMessaggio, MAX_TESTO_BOZZA, oggettoRisposta, destinatarioRisposta } from "./posta/bozze.js";
import { ErroreApple, appleVisibile, collegaApple, scegliCalendari, scollegaApple, leggiApple, scopriCalendari, type FonteApple } from "./calendarioApple.js";

export interface OpzioniRotte {
  db: Db;
  posta: ServizioPosta;
  apple: FonteApple;
}

function errore(res: Response, e: unknown) {
  if (e instanceof ErrorePosta || e instanceof ErroreApple) return res.status(e.stato).json({ errore: e.message });
  return res.status(500).json({ errore: "Operazione non riuscita." });
}

export function montaRotteFase2(app: Express, o: OpzioniRotte): void {
  const { db } = o;
  const dip: DipendenzePosta = o.posta.dip;
  const fonte = { db, cifratore: dip.cifratore };

  // ------------------------------------------------------------ caselle email (Impostazioni)
  const statoCaselle = () => ({
    caselle: caselleVisibili(fonte, dip.aziende()),
    aziende: dip.aziende(),
    preset: PRESET,
    confermeAutomaticheAttive: leggiImpostazioni(db).confermeAutomaticheAttive,
  });
  app.get("/api/posta/caselle", (_req, res) => { res.json(statoCaselle()); });
  app.post("/api/posta/caselle", async (req, res) => {
    const d = SchemaNuovaCasella.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Controlla i campi: nome, tipo, azienda o privato, indirizzo e password." });
    try {
      const c = await aggiungiCasella(dip, d.data);
      registra(db, "posta.caselle", "fatto", "luigi", { operazione: "aggiungi", casella: c.nome, tipo: c.tipo, id: c.id });
      res.json(statoCaselle());
    } catch (e) {
      registra(db, "posta.caselle", "errore", "luigi", { operazione: "aggiungi", tipo: d.data.tipo, motivo: e instanceof ErrorePosta ? e.message : "errore" });
      errore(res, e);
    }
  });
  app.patch("/api/posta/caselle/:id", async (req, res) => {
    const d = SchemaModificaCasella.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Modifica non valida." });
    try {
      const c = await modificaCasella(dip, String(req.params.id), d.data);
      registra(db, "posta.caselle", "fatto", "luigi", { operazione: "modifica", casella: c.nome, id: c.id, campi: Object.keys(d.data).filter((k) => k !== "password").concat(d.data.password ? ["password"] : []) });
      res.json(statoCaselle());
    } catch (e) {
      registra(db, "posta.caselle", "errore", "luigi", { operazione: "modifica", id: String(req.params.id), motivo: e instanceof ErrorePosta ? e.message : "errore" });
      errore(res, e);
    }
  });
  app.delete("/api/posta/caselle/:id", (req, res) => {
    try {
      const c = rimuoviCasella(fonte, String(req.params.id));
      registra(db, "posta.caselle", "fatto", "luigi", { operazione: "rimuovi", casella: c.nome, id: c.id });
      res.json(statoCaselle());
    } catch (e) { errore(res, e); }
  });
  app.post("/api/posta/caselle/:id/prova", async (req, res) => {
    const c = trovaCasella(fonte, String(req.params.id));
    if (!c) return res.status(404).json({ errore: "Casella non trovata." });
    try {
      await provaAccesso(dip, c);
      if (c.confermeAutomatiche) await dip.uscita.prova(c);
      registra(db, "posta.caselle", "fatto", "luigi", { operazione: "prova", casella: c.nome });
      res.json({ ok: true, messaggio: `${c.nome}: collegamento riuscito.` });
    } catch (e) {
      registra(db, "posta.caselle", "errore", "luigi", { operazione: "prova", casella: c.nome, motivo: (e as Error).message });
      res.json({ ok: false, messaggio: `${c.nome}: ${(e as Error).message}` });
    }
  });

  // ------------------------------------------------------------ pagina Posta
  app.post("/api/posta/aggiorna", async (_req, res) => {
    if (!leggiCaselle(fonte).length) return res.json({ ok: false, messaggio: "Nessuna casella collegata: aggiungila da Impostazioni → Caselle email." });
    const esito = await o.posta.controllaOra();
    const caselle = leggiCaselle(fonte);
    const nome = (id: string) => caselle.find((c) => c.id === id)?.nome ?? id;
    const errori = esito.caselle.filter((c) => c.errore);
    const nuove = esito.caselle.reduce((t, c) => t + c.nuove.length, 0);
    const parti = [nuove ? `${nuove} mail nuove.` : "Nessuna mail nuova."];
    if (errori.length) parti.push(errori.map((c) => `${nome(c.casella)}: ${c.errore}`).join(" · "));
    if (esito.classifica?.tetto) parti.push("Tetto di spesa raggiunto: alcune mail restano senza riassunto.");
    res.json({ ok: !errori.length, messaggio: parti.join(" "), nuove, tetto: !!esito.classifica?.tetto });
  });

  const vistaMail = (m: MessaggioPosta, conTesto = false) => {
    const c = trovaCasella(fonte, m.casella_id);
    const s = segniDi(m);
    return {
      id: m.id, casella: m.casella_id, casellaNome: c?.nome ?? "casella rimossa", tipo: c?.tipo ?? "", spazio: m.spazio, nomeSpazio: nomeSpazio(m.spazio, dip.aziende()),
      daNome: m.da_nome, daIndirizzo: m.da_indirizzo, oggetto: m.oggetto, data: m.data, riassunto: m.riassunto, stato: m.stato,
      urgente: !!m.urgente, motivo: m.motivo, tocca: !!m.tocca, pec: s.pec ?? null, automatica: !!(s.lista || s.automatico || s.noReply),
      confermaAutomatica: m.conferma_auto === "inviata",
      ...(conTesto ? { estratto: m.estratto, allegati: allegatiDi(m), a: m.a, rispondiA: destinatarioRisposta(m), oggettoRisposta: oggettoRisposta(m.oggetto), bozze: bozzeDelMessaggio(dip, m.id) } : {}),
    };
  };
  app.get("/api/posta/messaggi", (req, res) => {
    const caselle = leggiCaselle(fonte);
    const spazi = [...new Set(caselle.map((c) => c.spazio))];
    const giorni = Math.max(1, Math.min(30, Number(req.query.giorni) || 7));
    const lista = elencaMessaggi(db, {
      spazi: typeof req.query.spazio === "string" && req.query.spazio ? spazi.filter((s) => s === req.query.spazio) : spazi,
      caselle: typeof req.query.casella === "string" && req.query.casella ? [req.query.casella] : undefined,
      soloUrgenti: req.query.soloUrgenti === "1",
      giorni,
      limite: 200,
    });
    const tetto = (db.prepare("SELECT COUNT(*) n FROM posta_messaggi WHERE stato = 'tetto'").get() as { n: number }).n;
    res.json({
      messaggi: lista.map((m) => vistaMail(m)),
      caselle: caselleVisibili(fonte, dip.aziende()).map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, spazio: c.spazio, nomeSpazio: c.nomeSpazio, stato: c.stato })),
      senzaRiassuntoPerTetto: tetto,
      confermeAutomaticheAttive: leggiImpostazioni(db).confermeAutomaticheAttive,
    });
  });
  app.get("/api/posta/messaggi/:id", (req, res) => {
    const m = leggiMessaggio(db, String(req.params.id));
    if (!m) return res.status(404).json({ errore: "Mail non trovata (forse più vecchia di 30 giorni)." });
    res.json(vistaMail(m, true));
  });
  app.post("/api/posta/messaggi/:id/bozza/proponi", async (req, res) => {
    try {
      const testo = await proponiTestoBozza(dip, String(req.params.id));
      registra(db, "posta.bozza", "fatto", "luigi", { operazione: "testo proposto", mail: String(req.params.id) });
      res.json({ testo });
    } catch (e) { errore(res, e); }
  });
  app.post("/api/posta/messaggi/:id/bozza", async (req, res) => {
    const d = z.object({ testo: z.string().min(1).max(MAX_TESTO_BOZZA) }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi il testo della bozza." });
    try {
      // Il clic di Luigi su «Metti nelle Bozze» è la sua conferma. La bozza NON viene inviata.
      res.json(await creaBozza(dip, String(req.params.id), d.data.testo));
    } catch (e) { errore(res, e); }
  });

  // ------------------------------------------------------------ calendario Apple (iCloud, sola lettura)
  const statoApple = () => ({ ...appleVisibile(o.apple), aziende: dip.aziende() });
  app.get("/api/calendario-apple", (_req, res) => { res.json(statoApple()); });
  app.put("/api/calendario-apple", async (req, res) => {
    const d = z.object({ appleId: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi l'Apple ID e la password specifica per le app." });
    try {
      const imp = await collegaApple(o.apple, d.data.appleId, d.data.password);
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["calendarioApple"], calendari: imp.calendari.length });
      res.json(statoApple());
    } catch (e) {
      registra(db, "collegamenti.modifica", "errore", "luigi", { campi: ["calendarioApple"], motivo: e instanceof ErroreApple ? e.message : "errore" });
      errore(res, e);
    }
  });
  app.put("/api/calendario-apple/calendari", (req, res) => {
    const d = z.object({ calendari: z.array(z.object({ url: z.string().max(500), incluso: z.boolean(), spazio: z.string().min(1).max(40) })).max(50) }).strict().safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scelta non valida." });
    try {
      scegliCalendari(o.apple, d.data.calendari, dip.aziende().map((a) => a.id));
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["calendarioApple.calendari"] });
      res.json(statoApple());
    } catch (e) { errore(res, e); }
  });
  app.delete("/api/calendario-apple", (_req, res) => {
    scollegaApple(o.apple);
    registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["calendarioApple.rimuovi"] });
    res.json(statoApple());
  });
  app.post("/api/calendario-apple/prova", async (_req, res) => {
    const imp = leggiApple(o.apple);
    if (!imp) return res.json({ ok: false, messaggio: "Il calendario Apple non è collegato." });
    try {
      const c = await scopriCalendari(imp, o.apple.fetchFn ?? fetch);
      res.json({ ok: true, messaggio: `Calendario Apple collegato: ${c.length} calendari trovati.` });
    } catch (e) { res.json({ ok: false, messaggio: (e as Error).message }); }
  });
}
