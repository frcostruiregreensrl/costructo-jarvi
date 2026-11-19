// Webhook pubblico di WhatsApp: GET e POST /api/whatsapp/webhook.
// È fuori dall'accesso con password (lo chiama Meta) ma NON fuori dalla sicurezza:
//  - finché il collegamento non è configurato (segreto dell'app + parola di verifica) risponde 404, come se non esistesse;
//  - GET: verifica con hub.verify_token (confronto a tempo costante) → restituisce hub.challenge;
//  - POST, il controllo dipende dal fornitore scelto (mai uno al posto dell'altro):
//      meta      → firma X-Hub-Signature-256 = HMAC-SHA256 del corpo GREZZO con il segreto dell'app, OBBLIGATORIA;
//      360dialog → intestazione X-Jarvis-Segreto uguale al segreto che Jarvis ha scritto su 360dialog, OBBLIGATORIA
//                  (360dialog non firma con un segreto nostro); se arriva anche una firma di Meta e il segreto
//                  dell'app è impostato, deve essere giusta anche quella. Confronti a tempo costante.
//    Controllo mancante o sbagliato → 401; corpo al massimo 2 MB; JSON controllato con zod (tollerante);
//  - limite di richieste per indirizzo IP; dopo 20 firme sbagliate in 15 minuti quell'IP è bloccato 15 minuti;
//  - risponde 200 SUBITO e lavora dopo (Meta non deve aspettare); lo stesso messaggio non si salva due volte.
import express, { type Request, type Response, type Router } from "express";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import { registra } from "../registro.js";
import { bloccatoPer, registraErrore, type RegolaLimite } from "../sicurezza/limiti.js";
import { INTESTAZIONE_SEGRETO, leggiCollegamento, webhookAttivo } from "./collegamento.js";
import type { CollegamentoWa } from "./tipi.js";
import { SchemaWebhook } from "./schema.js";
import { MAX_CORPO_WEBHOOK } from "./tipi.js";
import type { ServizioWhatsapp } from "./servizio.js";

export const REGOLA_FIRME: RegolaLimite = { massimo: 20, finestraMs: 15 * 60_000, bloccoMs: 15 * 60_000 };
/** Richieste al minuto per IP (Meta manda a raffica durante l'importazione dello storico). */
export const RICHIESTE_AL_MINUTO = 600;

/** Confronto a tempo costante di due testi (anche di lunghezza diversa). */
export function ugualeCostante(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest(), hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Controlla la firma «sha256=<hex>» sul corpo grezzo. */
export function firmaValida(corpo: Buffer, intestazione: string | undefined, segreto: string): boolean {
  if (!segreto || !intestazione) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(intestazione.trim());
  if (!m) return false;
  const atteso = createHmac("sha256", segreto).update(corpo).digest();
  return timingSafeEqual(atteso, Buffer.from(m[1].toLowerCase(), "hex"));
}

const unaSola = (v: string | string[] | undefined) => (Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v);

/**
 * Il controllo del webhook secondo il fornitore. Restituisce il motivo del rifiuto, oppure "" se va bene.
 * `ora` serve per il segreto precedente di 360dialog (vale un'ora dopo il cambio).
 */
export function controllaWebhook(c: CollegamentoWa, corpo: Buffer, intestazioni: Record<string, string | string[] | undefined>, ora = Date.now()): string {
  const firma = unaSola(intestazioni["x-hub-signature-256"]);
  if (c.provider === "meta") {
    if (!firma) return "firma mancante";
    return firmaValida(corpo, firma, c.appSecret) ? "" : "firma non valida";
  }
  // 360dialog: l'intestazione segreta è obbligatoria (una firma di Meta da sola non basta).
  const segreto = unaSola(intestazioni[INTESTAZIONE_SEGRETO.toLowerCase()]);
  if (!segreto) return "intestazione segreta mancante";
  if (!c.webhookSecret) return "segreto del webhook non configurato";
  const giusto = ugualeCostante(segreto, c.webhookSecret)
    || (!!c.webhookSecretPrecedente && ora < c.precedenteFino && ugualeCostante(segreto, c.webhookSecretPrecedente));
  if (!giusto) return "intestazione segreta non valida";
  if (firma && c.appSecret && !firmaValida(corpo, firma, c.appSecret)) return "firma non valida";
  return "";
}

export interface OpzioniWebhook {
  db: Db;
  cifratore: Cifratore;
  servizio: ServizioWhatsapp;
  hostAmmessi: () => Set<string>;
}

export function creaRotteWebhook(o: OpzioniWebhook): Router {
  const r = express.Router();
  const finestre = new Map<string, { inizio: number; n: number }>();
  const ip = (req: Request) => req.ip || req.socket.remoteAddress || "?";

  // Sicurezza comune: Host ammesso, configurazione presente, limite per IP, IP non bloccato.
  r.use((req, res, next) => {
    if (!o.hostAmmessi().has(String(req.headers.host || ""))) return res.status(421).json({ errore: "Indirizzo non ammesso." });
    if (!webhookAttivo(leggiCollegamento(o))) return res.status(404).json({ errore: "Non trovato." });
    const chi = ip(req), ora = Date.now();
    const f = finestre.get(chi);
    if (!f || ora - f.inizio >= 60_000) finestre.set(chi, { inizio: ora, n: 1 });
    else if (++f.n > RICHIESTE_AL_MINUTO) return res.status(429).json({ errore: "Troppe richieste." });
    if (finestre.size > 10_000) finestre.clear();
    if (bloccatoPer(o.db, `whatsapp:firma:${chi}`) > 0) return res.status(429).json({ errore: "Troppe richieste non valide." });
    next();
  });

  r.get("/", (req: Request, res: Response) => {
    const coll = leggiCollegamento(o)!;
    const modo = String(req.query["hub.mode"] ?? ""), token = String(req.query["hub.verify_token"] ?? ""), sfida = String(req.query["hub.challenge"] ?? "");
    if (modo !== "subscribe" || !token || !ugualeCostante(token, coll.verifyToken) || !/^[A-Za-z0-9_-]{1,200}$/.test(sfida)) {
      registraErrore(o.db, `whatsapp:firma:${ip(req)}`, REGOLA_FIRME);
      registra(o.db, "whatsapp.webhook", "negato", "sistema", { motivo: "verifica non valida", ip: ip(req) });
      return res.status(403).json({ errore: "Verifica non valida." });
    }
    registra(o.db, "whatsapp.webhook", "fatto", "sistema", { operazione: "verifica di Meta" });
    res.type("text/plain").send(sfida);
  });

  r.post("/", express.raw({ type: () => true, limit: MAX_CORPO_WEBHOOK }), (req: Request, res: Response) => {
    const coll = leggiCollegamento(o)!;
    const corpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const motivo = controllaWebhook(coll, corpo, req.headers);
    if (motivo) {
      registraErrore(o.db, `whatsapp:firma:${ip(req)}`, REGOLA_FIRME);
      registra(o.db, "whatsapp.webhook", "negato", "sistema", { motivo, fornitore: coll.provider, ip: ip(req) });
      return res.status(401).json({ errore: "Richiesta non autorizzata." });
    }
    let json: unknown;
    try { json = JSON.parse(corpo.toString("utf8")); } catch {
      registra(o.db, "whatsapp.webhook", "errore", "sistema", { motivo: "JSON non leggibile" });
      return res.status(400).json({ errore: "JSON non valido." });
    }
    const d = SchemaWebhook.safeParse(json);
    // Firma giusta ma forma inattesa: si risponde 200 (Meta non deve riprovare all'infinito) e si scrive nel registro.
    res.status(200).json({ ok: true });
    if (!d.success) {
      registra(o.db, "whatsapp.webhook", "errore", "sistema", { motivo: "forma del webhook non riconosciuta" });
      return;
    }
    void o.servizio.ricevi(d.data);
  });
  return r;
}
