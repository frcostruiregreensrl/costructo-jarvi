// Server web di Jarvis (Express 5): sicurezza, accesso, API e file dell'interfaccia.
import express, { type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
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
import { utenteEsiste, verificaAccesso, nomeUtente } from "./sicurezza/utente.js";
import { registra, leggiRegistro, dimenticaNelRegistro } from "./registro.js";
import { leggiImpostazioni, salvaImpostazioni, salvaSegreto, leggiSegreto, maschera } from "./impostazioni.js";
import { elencaMemorie, aggiungiMemoria, correggiMemoria, cancellaMemoria, esportaMemorie } from "./memorie.js";
import { impegniProssimiGiorni, aggiungiImpegno, cancellaImpegno, descriviImpegno } from "./agenda.js";
import { elencaConversazioni, ultimiMessaggi } from "./conversazioni.js";
import { riepilogoMese, LISTINO } from "./consumi.js";
import { creaClientCostructo, type ClientCostructo } from "./costructo.js";
import { controllaIndirizzo } from "./calendario.js";
import { creaBriefing } from "./briefing.js";
import { rispondi } from "./assistente.js";
import { rispondiConferma } from "./strumenti.js";
import { SchemaIscrizione, salvaIscrizione, togliIscrizione, inviaATutti, type Invia } from "./push.js";
import { oraMinuti } from "./tempo.js";

export interface OpzioniApp {
  config: Config;
  db: Db;
  cifratore: Cifratore;
  /** Sostituibile nei test con il cervello finto. */
  cervello?: () => Promise<Cervello>;
  fetchFn?: typeof fetch;
  invia?: Invia | null;
  cartellaPubblica?: string;
}

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

  app.get("/api/stato", (req, res) => {
    res.json({ accesso: autenticato(req), utentePresente: utenteEsiste(db) });
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
  const costructo = (): ClientCostructo | null => {
    const url = leggiSegreto(db, cifratore, "costructo_url") || config.costructoUrl;
    const token = leggiSegreto(db, cifratore, "costructo_token") || config.costructoToken;
    return url && token ? creaClientCostructo({ url, token, fetchFn: o.fetchFn }) : null;
  };
  const linkCalendario = () => leggiSegreto(db, cifratore, "calendario_ical");
  let cervelloCache: Promise<Cervello> | null = null;
  const cervello = o.cervello ?? (() => {
    cervelloCache ??= caricaCervelloAnthropic(config.anthropicApiKey).catch((e) => { cervelloCache = null; throw e; });
    return cervelloCache;
  });
  const dip = {
    db, fuso: config.fusoOrario, modelloPredefinito: config.modelloPredefinito, modelloApprofondito: config.modelloApprofondito,
    cervello, costructo, linkCalendario, fetchFn: o.fetchFn,
  };
  const prepara = (req: Request) => creaBriefing({ db, fuso: config.fusoOrario, costructo: costructo(), linkCalendario: linkCalendario(), fetchFn: o.fetchFn }).then((b) => b);

  // ------------------------------------------------------------ avvio, briefing, domanda
  app.get("/api/avvio", (_req, res) => {
    const imp = leggiImpostazioni(db);
    res.json({ nome: nomeUtente(db), impostazioni: imp, spesa: riepilogoMese(db, imp.tettoMensileUsd, config.fusoOrario), costructo: !!costructo()?.configurato, pushPronte: !!o.invia, chiavePush: config.vapidPubblica || null });
  });

  app.get("/api/briefing", async (req, res) => { res.json(await prepara(req)); });

  const SchemaDomanda = z.object({ messaggio: z.string().trim().min(1).max(2000), vista: VISTA, conversazione: z.string().uuid().optional() });
  app.post("/api/chiedi", async (req, res) => {
    const d = SchemaDomanda.safeParse(req.body);
    if (!d.success) return res.status(400).json({ errore: "Messaggio non valido." });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const emetti = (e: object) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    try {
      await rispondi(dip, d.data, emetti, ctrl.signal);
    } catch {
      emetti({ tipo: "delta", testo: "Si è verificato un problema tecnico. Puoi ripetere?" });
    }
    res.end();
  });

  app.post("/api/conferme/:id", (req, res) => {
    const s = z.object({ scelta: z.union([z.literal("conferma"), z.literal("annulla"), z.number().int().min(0).max(9)]) }).safeParse(req.body);
    if (!s.success) return res.status(400).json({ errore: "Scelta non valida." });
    res.json(rispondiConferma(db, String(req.params.id), s.data.scelta, config.fusoOrario));
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
    res.json({ ...riepilogoMese(db, imp.tettoMensileUsd, config.fusoOrario), listino: LISTINO, modelloPredefinito: config.modelloPredefinito, modelloApprofondito: config.modelloApprofondito });
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
    const url = leggiSegreto(db, cifratore, "costructo_url") || config.costructoUrl;
    const token = leggiSegreto(db, cifratore, "costructo_token") || config.costructoToken;
    return {
      costructoUrl: url,
      costructoToken: maschera(token),
      calendario: !!linkCalendario(),
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
    try {
      if (d.data.costructoUrl !== undefined) {
        const u = d.data.costructoUrl.trim().replace(/\/$/, "");
        if (u) {
          const p = new URL(u);
          if (p.protocol !== "https:" && config.produzione) throw new Error("L'indirizzo di Costructo deve essere https.");
          if (p.username || p.password) throw new Error("Indirizzo non valido.");
        }
        salvaSegreto(db, cifratore, "costructo_url", u);
      }
      if (d.data.costructoToken !== undefined) {
        const t = d.data.costructoToken.trim();
        if (t && !/^csa_[A-Za-z0-9_\-]{8,}$/.test(t)) throw new Error("Il token di Costructo deve iniziare con csa_.");
        salvaSegreto(db, cifratore, "costructo_token", t);
      }
      if (d.data.calendarioIcal !== undefined) {
        const l = d.data.calendarioIcal.trim();
        if (l) await controllaIndirizzo(l);
        salvaSegreto(db, cifratore, "calendario_ical", l);
      }
    } catch (e) {
      return res.status(400).json({ errore: (e as Error).message });
    }
    registra(db, "collegamenti.modifica", "fatto", "luigi", { campi: Object.keys(d.data) });
    res.json(statoCollegamenti());
  });
  app.post("/api/collegamenti/costructo/prova", async (_req, res) => {
    const c = costructo();
    if (!c) return res.json({ ok: false, messaggio: "Costructo non è collegato." });
    try {
      await c.io();
      registra(db, "costructo.leggi", "fatto", "luigi", { percorso: "/io" });
      res.json({ ok: true, messaggio: "Collegamento a Costructo riuscito." });
    } catch (e) {
      res.json({ ok: false, messaggio: (e as Error).message });
    }
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
  app.post("/api/push/prova", async (req, res) => {
    if (!o.invia) return res.json({ ok: false, messaggio: "Notifiche non configurate sul server (mancano le chiavi VAPID)." });
    const b = await prepara(req);
    const n = await inviaATutti(db, o.invia, "Prova di Jarvis", b.righe.slice(1, 3).map((r) => r.testo).join(" "));
    res.json({ ok: n > 0, messaggio: n ? "Notifica inviata." : "Nessun dispositivo iscritto." });
  });

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
