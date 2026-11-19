// Server web di Jarvis (Express 5): sicurezza, accesso, API e file dell'interfaccia.
import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Cifratore } from "./sicurezza/cifra.js";
import type { Cervello } from "./cervello/tipi.js";
import { caricaCervelloAnthropic } from "./cervello/carica.js";
import { creaSessione, sessioneValida, chiudiSessione, nomeCookie, intestazioneCookie, leggiCookie, DURATA_SESSIONE_MS } from "./sicurezza/sessioni.js";
import { bloccatoPer, registraErrore, azzera, ritardoAccesso, REGOLA_ACCESSO_IP, REGOLA_ACCESSO_GLOBALE, CHIAVE_GLOBALE } from "./sicurezza/limiti.js";
import { utenteEsiste, verificaAccesso, nomeUtente, creaUtente } from "./sicurezza/utente.js";
import { uriOtpauth } from "./sicurezza/totp.js";
import { registra, leggiRegistro, dimenticaNelRegistro } from "./registro.js";
import { leggiImpostazioni, salvaImpostazioni, salvaSegreto, leggiSegreto } from "./impostazioni.js";
import { elencaMemorie, aggiungiMemoria, correggiMemoria, cancellaMemoria, esportaMemorie } from "./memorie.js";
import { impegniProssimiGiorni, aggiungiImpegno, cancellaImpegno, descriviImpegno } from "./agenda.js";
import { elencaConversazioni, ultimiMessaggi } from "./conversazioni.js";
import { riepilogoMese, LISTINO } from "./consumi.js";
import { aziendeCollegate, aziendeVisibili, aggiungiAzienda, rimuoviAzienda, rinominaAzienda, salvaTokenPrincipale, controllaTokenPrincipale, provaAziende, urlCostructo, leggiAziende, ErroreAziende, type FonteAziende } from "./aziende.js";
import { controllaIndirizzo } from "./calendario.js";
import { creaBriefing, notificheDelMattino } from "./briefing.js";
import { rispondi } from "./assistente.js";
import { rispondiConferma } from "./strumenti.js";
import { SchemaIscrizione, salvaIscrizione, togliIscrizione, inviaATutti, type Invia } from "./push.js";
import { oraMinuti } from "./tempo.js";
import type { RisolviNome } from "./calendario.js";
import type { ApriImap, PostaInUscita, DipendenzePosta } from "./posta/tipi.js";
import { creaApriImap } from "./posta/imap.js";
import { creaPostaInUscita } from "./posta/uscita.js";
import { creaServizioPosta, type ServizioPosta } from "./posta/servizio.js";
import { leggiCaselle } from "./posta/caselle.js";
import { leggiApple, eventiApple, type FonteApple } from "./calendarioApple.js";
import { montaRotteFase2 } from "./rotteFase2.js";
import { creaServizioWhatsapp, type ServizioWhatsapp } from "./whatsapp/servizio.js";
import { creaRotteWebhook } from "./whatsapp/webhook.js";
import { PERCORSO_WEBHOOK, collegamentoVisibile } from "./whatsapp/collegamento.js";
import type { DipendenzeWhatsapp } from "./whatsapp/tipi.js";
import { montaRotteWhatsapp } from "./rotteWhatsapp.js";
import { riepilogoInviiWa } from "./whatsapp/contatore.js";
import { montaRotteFunzioni } from "./rotteFunzioni.js";

export interface OpzioniApp {
  config: Config;
  db: Db;
  cifratore: Cifratore;
  /** Sostituibile nei test con il cervello finto. */
  cervello?: () => Promise<Cervello>;
  fetchFn?: typeof fetch;
  invia?: Invia | null;
  cartellaPubblica?: string;
  /** Fase 2, solo per i test: IMAP e SMTP finti, risoluzione dei nomi finta, fetch verso un iCloud finto. */
  apriImap?: ApriImap;
  uscita?: PostaInUscita;
  risolvi?: RisolviNome;
  fetchApple?: typeof fetch;
  /** Fase 3, solo per i test: fetch verso un Meta (o fornitore) finto per l'invio dei messaggi. */
  fetchWhatsapp?: typeof fetch;
  /** Fase 3b, solo per i test: fetch verso un fornitore di trascrizione finto. */
  fetchTrascrizione?: typeof fetch;
}

/** Servizi delle Fasi 2 e 3, raggiungibili da server.ts (giro della posta ogni 5 minuti, giro di WhatsApp ogni minuto). */
export interface ServiziApp { posta: ServizioPosta; apple: FonteApple; whatsapp: ServizioWhatsapp }

const qui = fileURLToPath(new URL(".", import.meta.url));
const VISTA = z.enum(["privato", "lavoro", "tutto"]);
const SPAZIO = z.enum(["privato", "lavoro"]);

export function creaApp(o: OpzioniApp) {
  const { config, db, cifratore } = o;
  const app = express();
  app.disable("x-powered-by");
  // Dietro Railway: ci si fida di UN solo proxy (quello di Railway) per leggere l'IP vero del visitatore.
  if (config.fidatiProxy) app.set("trust proxy", 1);
  const pubblica = o.cartellaPubblica ?? resolve(qui, existsSync(resolve(qui, "../public")) ? "../public" : "public");
  const cookie = nomeCookie(config.produzione);
  const hostAmmessi = () => new Set(config.origineAmmessa.map((u) => new URL(u).host));

  // Hash dell'importmap della modalità Classic, per permetterla nella Content-Security-Policy.
  let hashImportmap = "";
  try {
    const html = readFileSync(join(pubblica, "classic.html"), "utf8");
    const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    if (m) hashImportmap = `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`;
  } catch { /* pagina assente nei test */ }

  // ------------------------------------------------------------ intestazioni di sicurezza
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'", `script-src 'self'${hashImportmap ? ` ${hashImportmap}` : ""}`, "style-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'", "font-src 'self'",
      "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
    ].join("; "));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=()");
    if (config.produzione) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ------------------------------------------------------------ Fase 3: webhook pubblico di WhatsApp
  // Prima del controllo Origin e del JSON (lo chiama Meta, con il corpo grezzo da firmare), ma con le sue regole:
  // Host ammesso, 404 finché non è configurato, firma HMAC obbligatoria, limite di dimensione e di richieste.
  let rotteWebhook: Router | null = null;
  app.use(PERCORSO_WEBHOOK, (req, res, next) => (rotteWebhook ? rotteWebhook(req, res, next) : res.status(404).json({ errore: "Non trovato." })));

  // ------------------------------------------------------------ Host (contro il DNS rebinding) e CSRF (controllo Origin)
  app.use((req, res, next) => {
    if (!hostAmmessi().has(String(req.headers.host || ""))) return res.status(421).json({ errore: "Indirizzo non ammesso." });
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin ? !config.origineAmmessa.includes(origin) : req.headers["sec-fetch-site"] !== "same-origin") {
      registra(db, "sicurezza.csrf", "negato", "sistema", { percorso: req.path, origin: origin || "(assente)" });
      return res.status(403).json({ errore: "Richiesta rifiutata: provenienza non ammessa." });
    }
    if (req.path.startsWith("/api/") && req.headers["content-length"] !== "0" && !req.is("application/json") && req.method !== "DELETE") {
      return res.status(415).json({ errore: "Serve JSON." });
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  // ------------------------------------------------------------ accesso
  const autenticato = (req: Request) => sessioneValida(db, leggiCookie(req.headers.cookie, cookie));
  const ip = (req: Request) => req.ip || req.socket.remoteAddress || "?";

  const primoAccessoAperto = () => !!config.codicePrimoAccesso && !utenteEsiste(db);
  app.get("/api/stato", (req, res) => {
    res.json({ accesso: autenticato(req), utentePresente: utenteEsiste(db), primoAccesso: primoAccessoAperto() });
  });

  // Primo accesso (solo se il database non ha ancora l'utente E il server ha JARVIS_CODICE_PRIMO_ACCESSO):
  // crea l'utente dal browser. Dopo la creazione la rotta non esiste più.
  const SchemaPrimo = z.object({
    codice: z.string().min(1).max(200),
    nome: z.string().trim().min(1).max(60),
    password: z.string().min(12).max(200),
  });
  const impronta = (s: string) => createHash("sha256").update(s).digest();
  app.post("/api/primo-accesso", (req, res) => {
    if (!primoAccessoAperto()) return res.status(404).json({ errore: "Non trovato." });
    const chiaveIp = `primo:ip:${ip(req)}`;
    const attesa = bloccatoPer(db, chiaveIp);
    if (attesa > 0) return res.status(429).json({ errore: `Troppi tentativi. Riprova tra ${Math.ceil(attesa / 60_000)} minuti.` });
    const dati = SchemaPrimo.safeParse(req.body);
    if (!dati.success) return res.status(400).json({ errore: "Controlla i campi: la password deve avere almeno 12 caratteri." });
    if (!timingSafeEqual(impronta(dati.data.codice), impronta(config.codicePrimoAccesso))) {
      registraErrore(db, chiaveIp, REGOLA_ACCESSO_IP);
      registra(db, "primo-accesso", "negato", "sistema", { ip: ip(req) });
      return res.status(401).json({ errore: "Codice di primo accesso non corretto." });
    }
    const segreto = creaUtente(db, cifratore, dati.data.nome, dati.data.password);
    azzera(db, chiaveIp);
    registra(db, "primo-accesso", "fatto", "luigi", { ip: ip(req) });
    res.json({ ok: true, segreto, link: uriOtpauth(segreto, dati.data.nome) });
  });

  const SchemaAccesso = z.object({ password: z.string().min(1).max(200), codice: z.string().regex(/^\d{6}$/) });
  app.post("/api/accesso", async (req, res) => {
    const chiaveIp = `accesso:ip:${ip(req)}`;
    const attesa = bloccatoPer(db, chiaveIp);
    if (attesa > 0) {
      registra(db, "accesso", "negato", "sistema", { motivo: "troppi tentativi", ip: ip(req) });
      return res.status(429).json({ errore: `Troppi tentativi. Riprova tra ${Math.ceil(attesa / 60_000)} minuti.` });
    }
    // Molti errori in totale: si rallenta ogni tentativo, ma non si blocca nessuno.
    const ritardo = ritardoAccesso(db);
    if (ritardo > 0) await new Promise((r) => setTimeout(r, ritardo));
    const dati = SchemaAccesso.safeParse(req.body);
    if (!dati.success || !verificaAccesso(db, cifratore, dati.data.password, dati.data.codice)) {
      registraErrore(db, chiaveIp, REGOLA_ACCESSO_IP);
      registraErrore(db, CHIAVE_GLOBALE, REGOLA_ACCESSO_GLOBALE);
      registra(db, "accesso", "negato", "sistema", { motivo: "credenziali errate", ip: ip(req) });
      return res.status(401).json({ errore: "Password o codice non corretti." });
    }
    azzera(db, chiaveIp);
    const token = creaSessione(db, String(req.headers["user-agent"] || ""));
    res.setHeader("Set-Cookie", intestazioneCookie(cookie, token, config.produzione, DURATA_SESSIONE_MS / 1000));
    registra(db, "accesso", "fatto", "luigi", { ip: ip(req) });
    res.json({ ok: true });
  });

  app.post("/api/uscita", (req, res) => {
    chiudiSessione(db, leggiCookie(req.headers.cookie, cookie));
    res.setHeader("Set-Cookie", intestazioneCookie(cookie, "", config.produzione, 0));
    res.json({ ok: true });
  });

  // Tutto il resto di /api richiede l'accesso.
  app.use("/api", (req, res, next) => {
    if (!autenticato(req)) return res.status(401).json({ errore: "Serve l'accesso." });
    next();
  });

  // ------------------------------------------------------------ dipendenze
  // Aziende di Costructo: una per token. I token restano sul server, cifrati.
  const fonte: FonteAziende = { db, cifratore, urlAmbiente: config.costructoUrl, tokenAmbiente: config.costructoToken, fetchFn: o.fetchFn };
  const aziende = () => aziendeCollegate(fonte);
  const linkCalendario = () => leggiSegreto(db, cifratore, "calendario_ical");
  let cervelloCache: Promise<Cervello> | null = null;
  const cervello = o.cervello ?? (() => {
    cervelloCache ??= caricaCervelloAnthropic(config.anthropicApiKey).catch((e) => { cervelloCache = null; throw e; });
    return cervelloCache;
  });
  // Fase 2: posta e calendario Apple. Le caselle appartengono alle aziende dell'elenco (anche senza indirizzo di Costructo).
  const aziendePosta = () => leggiAziende(fonte).map((a) => ({ id: a.id, nome: a.nome }));
  const dipPosta: DipendenzePosta = {
    db, cifratore, fuso: config.fusoOrario,
    apriImap: o.apriImap ?? creaApriImap({ risolvi: o.risolvi }),
    uscita: o.uscita ?? creaPostaInUscita({ risolvi: o.risolvi }),
    cervello, modello: config.modelloPredefinito, aziende: aziendePosta, invia: o.invia ?? null, risolvi: o.risolvi,
  };
  const servizioPosta = creaServizioPosta(dipPosta);
  const fonteApple: FonteApple = { db, cifratore, fetchFn: o.fetchApple };
  /** Eventi dei calendari Apple scelti; undefined se il calendario Apple non è collegato. */
  const calendarioApple = () => (leggiApple(fonteApple) ? (da: number, a: number) => eventiApple(fonteApple, da, a, config.fusoOrario) : undefined);
  // Fase 3: WhatsApp. Le aziende sono quelle dell'elenco (anche senza indirizzo di Costructo); per cercare i numeri
  // tra le controparti servono quelle collegate.
  const dipWhatsapp: DipendenzeWhatsapp = {
    db, cifratore, fuso: config.fusoOrario, cervello, modello: config.modelloPredefinito, aziende: aziendePosta,
    aziendeCostructo: aziende, invia: o.invia ?? null, fetchFn: o.fetchWhatsapp, risolvi: o.risolvi, fetchTrascrizione: o.fetchTrascrizione,
  };
  const servizioWhatsapp = creaServizioWhatsapp(dipWhatsapp);
  rotteWebhook = creaRotteWebhook({ db, cifratore, servizio: servizioWhatsapp, hostAmmessi });
  app.locals.servizi = { posta: servizioPosta, apple: fonteApple, whatsapp: servizioWhatsapp } satisfies ServiziApp;

  const dip = {
    db, fuso: config.fusoOrario, modelloPredefinito: config.modelloPredefinito, modelloApprofondito: config.modelloApprofondito,
    cervello, aziende, linkCalendario, fetchFn: o.fetchFn, posta: dipPosta, whatsapp: dipWhatsapp,
  };
  const prepara = () => creaBriefing({ db, fuso: config.fusoOrario, aziende: aziende(), linkCalendario: linkCalendario(), fetchFn: o.fetchFn, calendarioApple: calendarioApple() });

  // ------------------------------------------------------------ avvio, briefing, domanda
  app.get("/api/avvio", (_req, res) => {
    const imp = leggiImpostazioni(db);
    res.json({ nome: nomeUtente(db), impostazioni: imp, spesa: riepilogoMese(db, imp.tettoMensileUsd, config.fusoOrario), costructo: aziende().length > 0, aziende: aziende().map((a) => a.nome), pushPronte: !!o.invia, chiavePush: config.vapidPubblica || null });
  });

  app.get("/api/briefing", async (_req, res) => { res.json(await prepara()); });

  const SchemaDomanda = z.object({ messaggio: z.string().trim().min(1).max(2000), vista: VISTA, conversazione: z.string().uuid().optional() });
  app.post("/api/chiedi", async (req, res) => {
    const d = SchemaDomanda.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Messaggio non valido." });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const emetti = (e: object) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    try {
      await rispondi({ ...dip, calendarioApple: calendarioApple() }, d.data, emetti, ctrl.signal);
    } catch {
      emetti({ tipo: "delta", testo: "Si è verificato un problema tecnico. Puoi ripetere?" });
    }
    res.end();
  });

  app.post("/api/conferme/:id", async (req, res) => {
    const s = z.object({ scelta: z.union([z.literal("conferma"), z.literal("annulla"), z.number().int().min(0).max(9)]) }).safeParse(req.body);
    if (!s.success) return res.status(400).json({ errore: "Scelta non valida." });
    res.json(await rispondiConferma(db, String(req.params.id), s.data.scelta, config.fusoOrario, Date.now(), dipPosta, dipWhatsapp));
  });

  // ------------------------------------------------------------ memoria («Cosa sa di me»)
  app.get("/api/memorie", (req, res) => {
    const v = VISTA.safeParse(req.query.vista ?? "tutto");
    res.json(elencaMemorie(db, v.success ? v.data : "tutto"));
  });
  app.get("/api/memorie/esporta", (_req, res) => {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="JARVIS-MEMORIA.md"');
    res.send(esportaMemorie(db));
  });
  app.post("/api/memorie", (req, res) => {
    const d = z.object({ spazio: SPAZIO, testo: z.string().min(1).max(500) }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Ricordo non valido." });
    const m = aggiungiMemoria(db, d.data.spazio, d.data.testo, "luigi");
    registra(db, "memoria.salva", "fatto", "luigi", { id: m.id, spazio: m.spazio });
    res.json(m);
  });
  app.patch("/api/memorie/:id", (req, res) => {
    const d = z.object({ testo: z.string().min(1).max(500).optional(), spazio: SPAZIO.optional() }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Modifica non valida." });
    const m = correggiMemoria(db, String(req.params.id), d.data);
    if (!m) return res.status(404).json({ errore: "Ricordo non trovato." });
    registra(db, "memoria.correggi", "fatto", "luigi", { id: m.id, spazio: m.spazio });
    res.json(m);
  });
  app.delete("/api/memorie/:id", (req, res) => {
    const prima = elencaMemorie(db, "tutto").find((m) => m.id === String(req.params.id));
    const ok = cancellaMemoria(db, String(req.params.id));
    if (ok && prima) dimenticaNelRegistro(db, prima.testo);
    registra(db, "memoria.cancella", ok ? "fatto" : "errore", "luigi", { id: req.params.id });
    res.status(ok ? 200 : 404).json({ ok });
  });

  // ------------------------------------------------------------ agenda privata
  app.get("/api/agenda", (req, res) => {
    const giorni = Math.max(1, Math.min(60, Number(req.query.giorni) || 7));
    res.json(impegniProssimiGiorni(db, giorni, config.fusoOrario).map((i) => ({ id: i.id, titolo: i.titolo, inizio: i.inizio, ora: i.tutto_il_giorno ? "" : oraMinuti(i.inizio, config.fusoOrario), descrizione: descriviImpegno(i, config.fusoOrario) })));
  });
  app.post("/api/agenda", (req, res) => {
    const d = z.object({ titolo: z.string().min(1).max(140), data: z.string(), ora: z.string().max(5), minuti: z.number().int().min(5).max(1440).optional() }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Impegno non valido." });
    try {
      const i = aggiungiImpegno(db, d.data, config.fusoOrario);
      registra(db, "agenda.aggiungi", "fatto", "luigi", { id: i.id });
      res.json(i);
    } catch (e) { res.status(400).json({ errore: (e as Error).message }); }
  });
  app.delete("/api/agenda/:id", (req, res) => {
    const i = cancellaImpegno(db, String(req.params.id));
    if (i) dimenticaNelRegistro(db, i.titolo);
    registra(db, "agenda.cancella", i ? "fatto" : "errore", "luigi", { id: req.params.id });
    res.status(i ? 200 : 404).json({ ok: !!i });
  });

  // ------------------------------------------------------------ conversazioni, registro, spesa
  app.get("/api/conversazioni", (req, res) => {
    const v = VISTA.safeParse(req.query.vista ?? "tutto");
    res.json(elencaConversazioni(db, v.success ? v.data : "tutto"));
  });
  app.get("/api/conversazioni/:id", (req, res) => { res.json(ultimiMessaggi(db, String(req.params.id), 100)); });
  app.get("/api/registro", (req, res) => {
    const prima = Number(req.query.prima) || undefined;
    res.json(leggiRegistro(db, 100, prima));
  });
  app.get("/api/spesa", (_req, res) => {
    const imp = leggiImpostazioni(db);
    res.json({
      ...riepilogoMese(db, imp.tettoMensileUsd, config.fusoOrario), listino: LISTINO, modelloPredefinito: config.modelloPredefinito, modelloApprofondito: config.modelloApprofondito,
      // Fase 3 parte 2: messaggi mandati da Jarvis con la API di WhatsApp (stima in euro, separata dalla spesa dell'AI).
      whatsapp: riepilogoInviiWa(db, config.fusoOrario),
    });
  });

  // ------------------------------------------------------------ impostazioni e collegamenti (i segreti non tornano mai al browser)
  app.get("/api/impostazioni", (_req, res) => { res.json({ impostazioni: leggiImpostazioni(db), collegamenti: statoCollegamenti() }); });
  app.put("/api/impostazioni", (req, res) => {
    try {
      const imp = salvaImpostazioni(db, req.body);
      registra(db, "impostazioni.modifica", "fatto", "luigi", { campi: Object.keys(req.body || {}) });
      res.json({ impostazioni: imp });
    } catch { res.status(400).json({ errore: "Impostazioni non valide." }); }
  });
  function statoCollegamenti() {
    const elenco = aziendeVisibili(fonte);
    return {
      costructoUrl: urlCostructo(fonte),
      /** Compatibilità: le ultime cifre del primo token. L'elenco completo è in `aziende`. */
      costructoToken: elenco[0]?.token ?? "",
      aziende: elenco,
      calendario: !!linkCalendario(),
      calendarioApple: !!leggiApple(fonteApple),
      caselleEmail: leggiCaselle({ db, cifratore }).length,
      whatsapp: collegamentoVisibile({ db, cifratore }, config.origineAmmessa).webhookAttivo,
      anthropic: !!config.anthropicApiKey,
      elevenLabs: false,
    };
  }
  const SchemaCollegamenti = z.object({
    costructoUrl: z.string().max(300).optional(),
    costructoToken: z.string().max(300).optional(),
    calendarioIcal: z.string().max(2000).optional(),
  });
  app.put("/api/collegamenti", async (req, res) => {
    const d = SchemaCollegamenti.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Dati non validi." });
    // Prima si controlla tutto, poi si salva: un errore non lascia mai una modifica a metà.
    try {
      const u = d.data.costructoUrl?.trim().replace(/\/$/, "");
      if (u) {
        let p: URL;
        try { p = new URL(u); } catch { throw new Error("Indirizzo di Costructo non valido."); }
        if (p.protocol !== "https:" && config.produzione) throw new Error("L'indirizzo di Costructo deve essere https.");
        if (p.username || p.password) throw new Error("Indirizzo non valido.");
      }
      // Vecchio campo «token unico»: vale solo se non ci sono già aziende nell'elenco (poi si usa «Aggiungi»).
      if (d.data.costructoToken !== undefined) controllaTokenPrincipale(fonte, d.data.costructoToken);
      const l = d.data.calendarioIcal?.trim();
      if (l) await controllaIndirizzo(l);

      if (u !== undefined) salvaSegreto(db, cifratore, "costructo_url", u);
      if (d.data.costructoToken !== undefined) salvaTokenPrincipale(fonte, d.data.costructoToken);
      if (l !== undefined) salvaSegreto(db, cifratore, "calendario_ical", l);
    } catch (e) {
      return res.status(400).json({ errore: (e as Error).message });
    }
    registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: Object.keys(d.data) });
    res.json(statoCollegamenti());
  });
  // ------------------------------------------------------------ aziende di Costructo (un token per azienda)
  const erroreAziende = (res: Response, e: unknown) => {
    const err = e instanceof ErroreAziende ? e : new ErroreAziende("Operazione non riuscita.");
    return res.status(err.stato).json({ errore: err.message, ...(err.codice ? { codice: err.codice } : {}) });
  };
  app.get("/api/collegamenti/aziende", (_req, res) => { res.json(aziendeVisibili(fonte)); });
  app.post("/api/collegamenti/aziende", async (req, res) => {
    const d = z.object({ token: z.string().min(1).max(300), nome: z.string().max(60).optional() }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi il token (inizia con csa_)." });
    try {
      const a = await aggiungiAzienda(fonte, d.data);
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["azienda.aggiungi"], azienda: a.nome, id: a.id });
      res.json(statoCollegamenti());
    } catch (e) {
      registra(db, "collegamenti.modifica", "errore", "luigi", { campi: ["azienda.aggiungi"], motivo: e instanceof ErroreAziende ? e.message : "errore" });
      erroreAziende(res, e);
    }
  });
  app.patch("/api/collegamenti/aziende/:id", async (req, res) => {
    const d = z.object({ nome: z.string().min(1).max(60) }).safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Scrivi un nome." });
    try {
      const a = await rinominaAzienda(fonte, String(req.params.id), d.data.nome);
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["azienda.rinomina"], azienda: a.nome, id: a.id });
      res.json(statoCollegamenti());
    } catch (e) { erroreAziende(res, e); }
  });
  app.delete("/api/collegamenti/aziende/:id", async (req, res) => {
    try {
      const a = await rimuoviAzienda(fonte, String(req.params.id));
      registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: ["azienda.rimuovi"], azienda: a.nome, id: a.id });
      res.json(statoCollegamenti());
    } catch (e) { erroreAziende(res, e); }
  });
  app.post("/api/collegamenti/costructo/prova", async (_req, res) => {
    if (!leggiAziende(fonte).length) return res.json({ ok: false, messaggio: "Costructo non è collegato.", aziende: [] });
    const esiti = await provaAziende(fonte);
    for (const e of esiti) if (e.ok) registra(db, "costructo.leggi", "fatto", "luigi", { percorso: "/io", azienda: e.nome });
    const ok = esiti.every((e) => e.ok);
    const messaggio = esiti.length === 1
      ? (ok ? "Collegamento a Costructo riuscito." : esiti[0].messaggio)
      : esiti.map((e) => `${e.nome}: ${e.ok ? "collegata" : e.messaggio}`).join(" · ");
    res.json({ ok, messaggio, aziende: esiti });
  });

  // ------------------------------------------------------------ notifiche push
  app.get("/api/push/chiave", (_req, res) => { res.json({ chiave: config.vapidPubblica || null }); });
  app.post("/api/push/iscrivi", (req, res) => {
    const d = SchemaIscrizione.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Iscrizione non valida." });
    salvaIscrizione(db, d.data);
    registra(db, "notifica.iscrizione", "fatto", "luigi", {});
    res.json({ ok: true });
  });
  app.post("/api/push/disiscrivi", (req, res) => {
    const d = z.object({ endpoint: z.string().max(1000) }).safeParse(req.body);
    if (d.success) togliIscrizione(db, d.data.endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/prova", async (_req, res) => {
    if (!o.invia) return res.json({ ok: false, messaggio: "Notifiche non configurate sul server (mancano le chiavi VAPID)." });
    const b = await prepara();
    // Una sola notifica di prova; con più aziende dice quante ne arriveranno al mattino.
    const mattino = notificheDelMattino(b);
    const testo = mattino.length > 1
      ? `Al mattino arriveranno ${mattino.length} notifiche, una per azienda${mattino.length > b.aziende.length ? " più una per la parte privata" : ""}. ${mattino[0].testo}`
      : b.righe.slice(1, 3).map((r) => r.testo).join(" ");
    const n = await inviaATutti(db, o.invia, "Prova di Jarvis", testo.slice(0, 200));
    res.json({ ok: n > 0, messaggio: n ? "Notifica inviata." : "Nessun dispositivo iscritto." });
  });

  // ------------------------------------------------------------ Fase 2: caselle email, Posta, bozze, calendario Apple
  montaRotteFase2(app, { db, posta: servizioPosta, apple: fonteApple });
  // ------------------------------------------------------------ Fase 3: pagina WhatsApp e impostazioni (il webhook pubblico è sopra)
  montaRotteWhatsapp(app, { db, whatsapp: servizioWhatsapp, origini: () => config.origineAmmessa });
  // ------------------------------------------------------------ Fase 3b: le 20 funzioni WhatsApp (proposte per Costructo, briefing, ricerca…)
  montaRotteFunzioni(app, { db, whatsapp: servizioWhatsapp, aziendeCostructo: aziende });

  app.use("/api", (_req, res) => { res.status(404).json({ errore: "Non trovato." }); });

  // ------------------------------------------------------------ three.js per la modalità Classic (solo se installato)
  const cartellaThree = resolve(process.cwd(), "node_modules/three");
  app.use("/vendor/three", (req, res, next) => {
    if (!/^\/(build\/three\.module(\.min)?\.js|build\/three\.core(\.min)?\.js|examples\/jsm\/[\w/.-]+\.js)$/.test(req.path) || req.path.includes("..")) return res.status(404).end();
    next();
  }, express.static(cartellaThree, { fallthrough: false, index: false }));

  // ------------------------------------------------------------ interfaccia (PWA)
  app.use(express.static(pubblica, {
    index: "index.html",
    setHeaders(res, percorso) {
      if (percorso.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
      if (percorso.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
    },
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const stato = (err as { status?: number }).status;
    if (stato === 404) return res.status(404).end();
    if (stato === 413) return res.status(413).json({ errore: "Richiesta troppo grande." });
    if (stato === 400) return res.status(400).json({ errore: "Richiesta non valida." });
    registra(db, "server.errore", "errore", "sistema", { messaggio: String((err as Error)?.message || err).slice(0, 300) });
    res.status(500).json({ errore: "Errore interno." });
  });

  return app;
}
