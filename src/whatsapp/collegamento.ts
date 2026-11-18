// Il collegamento a WhatsApp (per la parte 2): fornitore, numero, token, segreto dell'app, parola di verifica.
// Tutto sta nel segreto cifrato «whatsapp» (AES-256-GCM). Al browser non torna MAI un segreto, nemmeno in parte:
// solo «impostato sì/no». Cambiare fornitore o indirizzo richiede di riscrivere il token (così il token salvato
// non può essere mandato a un altro server).
import { z } from "zod";
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import { leggiSegreto, salvaSegreto } from "../impostazioni.js";
import { ErroreWhatsapp, type CollegamentoWa } from "./tipi.js";

export const BASE_META = "https://graph.facebook.com";
export const VERSIONE_PREDEFINITA = "v27.0";
export const INTESTAZIONE_PREDEFINITA = "D360-API-KEY";
export const PERCORSO_WEBHOOK = "/api/whatsapp/webhook";

interface Fonte { db: Db; cifratore: Cifratore }

const SchemaSalvato = z.object({
  provider: z.enum(["meta", "bsp"]).catch("meta"),
  baseUrl: z.string().max(300).catch(""),
  versione: z.string().max(10).catch(VERSIONE_PREDEFINITA),
  phoneNumberId: z.string().max(40).catch(""),
  token: z.string().max(1000).catch(""),
  intestazione: z.string().max(40).catch(INTESTAZIONE_PREDEFINITA),
  appSecret: z.string().max(200).catch(""),
  verifyToken: z.string().max(200).catch(""),
});

export function leggiCollegamento(f: Fonte): CollegamentoWa | null {
  const grezzo = leggiSegreto(f.db, f.cifratore, "whatsapp");
  if (!grezzo) return null;
  try {
    const ok = SchemaSalvato.safeParse(JSON.parse(grezzo));
    return ok.success ? ok.data : null;
  } catch { return null; }
}

/** Il webhook risponde solo se c'è il segreto dell'app (per la firma) e la parola di verifica. */
export const webhookAttivo = (c: CollegamentoWa | null): c is CollegamentoWa => !!c && !!c.appSecret && !!c.verifyToken;
/** Si può inviare solo con numero (o indirizzo del fornitore) e token. */
export const invioPronto = (c: CollegamentoWa | null): c is CollegamentoWa =>
  !!c && !!c.token && (c.provider === "meta" ? !!c.phoneNumberId : !!c.baseUrl);

/** Indirizzo del webhook da dare a Meta: il primo indirizzo https di JARVIS_ORIGINE (o il primo) + il percorso. */
export function indirizzoWebhook(origini: string[]): string {
  const base = origini.find((o) => o.startsWith("https://")) ?? origini[0] ?? "";
  return base ? `${base}${PERCORSO_WEBHOOK}` : PERCORSO_WEBHOOK;
}

export interface CollegamentoVisibile {
  provider: "meta" | "bsp";
  baseUrl: string;
  versione: string;
  phoneNumberId: string;
  intestazione: string;
  tokenImpostato: boolean;
  appSecretImpostato: boolean;
  verifyTokenImpostato: boolean;
  webhookAttivo: boolean;
  invioPronto: boolean;
  urlWebhook: string;
  /** In parole semplici. */
  stato: string;
}

export function collegamentoVisibile(f: Fonte, origini: string[]): CollegamentoVisibile {
  const c = leggiCollegamento(f);
  const w = webhookAttivo(c), i = invioPronto(c);
  return {
    provider: c?.provider ?? "meta",
    baseUrl: c?.provider === "bsp" ? c.baseUrl : "",
    versione: c?.versione || VERSIONE_PREDEFINITA,
    phoneNumberId: c?.phoneNumberId ?? "",
    intestazione: c?.intestazione || INTESTAZIONE_PREDEFINITA,
    tokenImpostato: !!c?.token,
    appSecretImpostato: !!c?.appSecret,
    verifyTokenImpostato: !!c?.verifyToken,
    webhookAttivo: w,
    invioPronto: i,
    urlWebhook: indirizzoWebhook(origini),
    stato: !c ? "Non collegato" : w && i ? "Pronto a ricevere e a inviare (dopo la tua conferma)" : w ? "Pronto a ricevere; per inviare mancano dei dati" : "Non collegato: mancano dei dati",
  };
}

export const SchemaModificaCollegamento = z.object({
  provider: z.enum(["meta", "bsp"]).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  versione: z.string().trim().max(10).optional(),
  phoneNumberId: z.string().trim().max(40).optional(),
  /** Vuoto = non cambiare. */
  token: z.string().trim().max(1000).optional(),
  intestazione: z.string().trim().max(40).optional(),
  appSecret: z.string().trim().max(200).optional(),
  verifyToken: z.string().trim().max(200).optional(),
}).strict();

/** Indirizzo di un fornitore: solo https, porta 443, niente credenziali, niente indirizzi numerici o interni. */
export function controllaBaseUrl(u: string): string {
  let p: URL;
  try { p = new URL(u); } catch { throw new ErroreWhatsapp("Indirizzo del fornitore non valido."); }
  if (p.protocol !== "https:") throw new ErroreWhatsapp("L'indirizzo del fornitore deve iniziare con https://.");
  if (p.username || p.password) throw new ErroreWhatsapp("Niente nome utente o password nell'indirizzo.");
  if (p.port && p.port !== "443") throw new ErroreWhatsapp("Il fornitore deve usare la porta normale di https (443).");
  if (p.search || p.hash) throw new ErroreWhatsapp("Scrivi solo l'indirizzo di base, senza parametri.");
  const h = p.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[") || h === "localhost" || !h.includes(".") || /\.(local|lan|internal|home|corp|localhost)$/.test(h)) {
    throw new ErroreWhatsapp("Il fornitore deve avere un nome pubblico (per esempio waba-v2.360dialog.io).");
  }
  return `${p.origin}${p.pathname.replace(/\/+$/, "")}`;
}

/** Salva le modifiche (prima controlla tutto, poi scrive). Restituisce il collegamento salvato. */
export function salvaCollegamento(f: Fonte, m: z.infer<typeof SchemaModificaCollegamento>): CollegamentoWa {
  const prima = leggiCollegamento(f);
  const provider = m.provider ?? prima?.provider ?? "meta";
  let baseUrl = provider === "bsp" ? (m.baseUrl !== undefined ? m.baseUrl : prima?.baseUrl ?? "") : "";
  if (provider === "bsp" && baseUrl) baseUrl = controllaBaseUrl(baseUrl);
  const versione = m.versione !== undefined ? (m.versione || VERSIONE_PREDEFINITA) : prima?.versione || VERSIONE_PREDEFINITA;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(versione)) throw new ErroreWhatsapp("La versione della Graph API si scrive come v27.0.");
  const phoneNumberId = m.phoneNumberId !== undefined ? m.phoneNumberId : prima?.phoneNumberId ?? "";
  if (phoneNumberId && !/^\d{5,30}$/.test(phoneNumberId)) throw new ErroreWhatsapp("L'id del numero (phone_number_id) è fatto solo di cifre.");
  const intestazione = m.intestazione !== undefined ? (m.intestazione || INTESTAZIONE_PREDEFINITA) : prima?.intestazione || INTESTAZIONE_PREDEFINITA;
  if (!/^[A-Za-z0-9-]{2,40}$/.test(intestazione) || /^(host|cookie|content-length|content-type|transfer-encoding|connection)$/i.test(intestazione)) {
    throw new ErroreWhatsapp("Nome dell'intestazione non valido.");
  }
  // Il token salvato resta valido solo se non cambiano fornitore e indirizzo.
  const cambiaDestinazione = !!prima && (prima.provider !== provider || (provider === "bsp" && prima.baseUrl !== baseUrl));
  const token = m.token ? m.token : prima?.token ?? "";
  if (cambiaDestinazione && !m.token && token) throw new ErroreWhatsapp("Hai cambiato fornitore o indirizzo: riscrivi il token o la chiave API.");
  if (token && /[\s\u0000-\u001f]/.test(token)) throw new ErroreWhatsapp("Il token non deve contenere spazi.");
  const appSecret = m.appSecret ? m.appSecret : prima?.appSecret ?? "";
  const verifyToken = m.verifyToken ? m.verifyToken : prima?.verifyToken ?? "";
  if (m.verifyToken && m.verifyToken.length < 12) throw new ErroreWhatsapp("La parola di verifica deve avere almeno 12 caratteri.");
  if (m.appSecret && !/^[A-Za-z0-9]{16,200}$/.test(m.appSecret)) throw new ErroreWhatsapp("Il segreto dell'app di Meta è fatto di lettere e cifre (almeno 16).");
  const c: CollegamentoWa = { provider, baseUrl, versione, phoneNumberId, token, intestazione, appSecret, verifyToken };
  salvaSegreto(f.db, f.cifratore, "whatsapp", JSON.stringify(c));
  return c;
}

export function scollega(f: Fonte): void {
  salvaSegreto(f.db, f.cifratore, "whatsapp", "");
}
