// Il collegamento a WhatsApp: fornitore (Meta diretto o 360dialog), numero, token o chiave API, segreti del webhook.
// Tutto sta nel segreto cifrato «whatsapp» (AES-256-GCM). Al browser non torna MAI un segreto, nemmeno in parte:
// solo «impostato sì/no». Cambiare fornitore o indirizzo richiede di riscrivere il token (così il token salvato
// non può essere mandato a un altro server) e cancella il segreto del webhook di 360dialog (va riconfigurato).
//
// Come si controlla il webhook, fornitore per fornitore (parte 2):
//   meta      → firma X-Hub-Signature-256 OBBLIGATORIA (segreto dell'app + parola di verifica).
//   360dialog → intestazione segreta X-Jarvis-Segreto OBBLIGATORIA (la sceglie Jarvis e la scrive lui su 360dialog).
//               Un'eventuale firma di Meta si ignora del tutto: conta solo l'intestazione.
// Cambiando fornitore si cancellano anche segreto dell'app e parola di verifica di Meta (vanno riscritti se si torna a Meta).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import { leggiSegreto, salvaSegreto } from "../impostazioni.js";
import type { RisolviNome } from "../calendario.js";
import { controllaNomeServer, indirizziServer } from "../posta/rete.js";
import { ErroreWhatsapp, type CollegamentoWa, type Provider } from "./tipi.js";

export const BASE_META = "https://graph.facebook.com";
export const VERSIONE_PREDEFINITA = "v27.0";
/** 360dialog: indirizzo di base della API v2 (alcuni documenti vecchi usano waba.360dialog.io). */
export const BASE_360 = "https://waba-v2.360dialog.io";
/** 360dialog: intestazione con la chiave API (una chiave per numero). */
export const INTESTAZIONE_360 = "D360-API-KEY";
/** Intestazione segreta che 360dialog rimanda in ogni webhook (la sceglie Jarvis). In minuscolo per Express. */
export const INTESTAZIONE_SEGRETO = "X-Jarvis-Segreto";
/** [non verificato] Percorsi di 360dialog per la prova e per la sincronizzazione: si possono cambiare. */
export const PERCORSO_SALUTE_360 = "/health_status";
export const PERCORSO_SYNC_360 = "/smb_app_data";
export const PERCORSO_WEBHOOK = "/api/whatsapp/webhook";
/** Dopo un cambio di segreto con esito INCERTO, il vecchio vale ancora un'ora (al massimo 2 vecchi insieme). */
export const DURATA_PRECEDENTE_MS = 3600_000;
export const MAX_PRECEDENTI = 2;

interface Fonte { db: Db; cifratore: Cifratore }

const SchemaSalvato = z.object({
  // Parte 1: «bsp» (fornitore generico). Dalla parte 2 è 360dialog.
  provider: z.preprocess((v) => (v === "bsp" ? "360dialog" : v), z.enum(["meta", "360dialog"])).catch("meta"),
  baseUrl: z.string().max(300).catch(""),
  versione: z.string().max(10).catch(VERSIONE_PREDEFINITA),
  phoneNumberId: z.string().max(40).catch(""),
  token: z.string().max(1000).catch(""),
  appSecret: z.string().max(200).catch(""),
  verifyToken: z.string().max(200).catch(""),
  webhookSecret: z.string().max(200).catch(""),
  segretiPrecedenti: z.array(z.object({ segreto: z.string().min(1).max(200), fino: z.number() })).max(MAX_PRECEDENTI).catch([]),
  webhookConfigurato: z.number().catch(0),
  percorsoSalute: z.string().max(120).catch(PERCORSO_SALUTE_360),
  percorsoSync: z.string().max(120).catch(PERCORSO_SYNC_360),
});

export function leggiCollegamento(f: Fonte): CollegamentoWa | null {
  const grezzo = leggiSegreto(f.db, f.cifratore, "whatsapp");
  if (!grezzo) return null;
  try {
    const ok = SchemaSalvato.safeParse(JSON.parse(grezzo));
    return ok.success ? ok.data : null;
  } catch { return null; }
}

/**
 * Il webhook risponde solo quando il suo controllo è pronto, secondo il fornitore:
 *  meta → segreto dell'app (per la firma) e parola di verifica; 360dialog → segreto dell'intestazione.
 * Cambiare fornitore NON apre mai il webhook: senza il controllo giusto resta spento (404).
 */
export const webhookAttivo = (c: CollegamentoWa | null): c is CollegamentoWa =>
  !!c && (c.provider === "meta" ? !!c.appSecret && !!c.verifyToken : !!c.webhookSecret);
/** Si può inviare solo con numero (o indirizzo di 360dialog) e token. */
export const invioPronto = (c: CollegamentoWa | null): c is CollegamentoWa =>
  !!c && !!c.token && (c.provider === "meta" ? !!c.phoneNumberId : !!c.baseUrl);

/** Indirizzo del webhook: il primo indirizzo https di JARVIS_ORIGINE (o il primo) + il percorso. */
export function indirizzoWebhook(origini: string[]): string {
  const base = origini.find((o) => o.startsWith("https://")) ?? origini[0] ?? "";
  return base ? `${base}${PERCORSO_WEBHOOK}` : PERCORSO_WEBHOOK;
}

/**
 * Regole di 360dialog per l'indirizzo del webhook [da verificare al primo uso vero]: https, niente trattino basso «_»
 * (in nessun punto), niente porta scritta. In più: niente credenziali né parametri.
 */
export function controllaUrlWebhook(u: string): string {
  let p: URL;
  try { p = new URL(u); } catch { throw new ErroreWhatsapp("L'indirizzo di Jarvis (JARVIS_ORIGINE) non è valido: non posso configurare il webhook."); }
  if (p.protocol !== "https:") throw new ErroreWhatsapp("Per 360dialog l'indirizzo di Jarvis deve essere https (JARVIS_ORIGINE).");
  if (u.includes("_")) throw new ErroreWhatsapp("360dialog non accetta indirizzi con il trattino basso «_»: serve un indirizzo di Jarvis senza «_».");
  if (p.port || /^https:\/\/[^/]+:\d+/i.test(u)) throw new ErroreWhatsapp("360dialog non accetta indirizzi con la porta scritta (per esempio :8443).");
  if (p.username || p.password || p.search || p.hash) throw new ErroreWhatsapp("L'indirizzo del webhook non deve avere credenziali o parametri.");
  return p.href;
}

export interface CollegamentoVisibile {
  provider: Provider;
  baseUrl: string;
  versione: string;
  phoneNumberId: string;
  tokenImpostato: boolean;
  appSecretImpostato: boolean;
  verifyTokenImpostato: boolean;
  /** 360dialog: il segreto del webhook c'è (mai il valore). */
  segretoWebhookImpostato: boolean;
  /** 360dialog: quando Jarvis ha configurato il webhook (0 = mai). */
  webhookConfigurato: number;
  percorsoSalute: string;
  percorsoSync: string;
  webhookAttivo: boolean;
  invioPronto: boolean;
  urlWebhook: string;
  /** Come si controlla ogni messaggio in arrivo, in parole semplici. */
  controlloWebhook: string;
  /** In parole semplici. */
  stato: string;
}

export function collegamentoVisibile(f: Fonte, origini: string[]): CollegamentoVisibile {
  const c = leggiCollegamento(f);
  const w = webhookAttivo(c), i = invioPronto(c);
  // Senza collegamento si propone 360dialog (la scelta di Luigi per la coesistenza).
  const provider = c?.provider ?? "360dialog";
  return {
    provider,
    baseUrl: provider === "360dialog" ? c?.baseUrl || BASE_360 : "",
    versione: c?.versione || VERSIONE_PREDEFINITA,
    phoneNumberId: c?.phoneNumberId ?? "",
    tokenImpostato: !!c?.token,
    appSecretImpostato: !!c?.appSecret,
    verifyTokenImpostato: !!c?.verifyToken,
    segretoWebhookImpostato: !!c?.webhookSecret,
    webhookConfigurato: c?.webhookConfigurato ?? 0,
    percorsoSalute: c?.percorsoSalute || PERCORSO_SALUTE_360,
    percorsoSync: c?.percorsoSync || PERCORSO_SYNC_360,
    webhookAttivo: w,
    invioPronto: i,
    urlWebhook: indirizzoWebhook(origini),
    controlloWebhook: provider === "meta"
      ? "Ogni messaggio deve avere la firma di Meta (segreto dell'app)."
      : "Ogni messaggio deve avere l'intestazione segreta che Jarvis ha scritto su 360dialog.",
    stato: !c ? "Non collegato"
      : w && i ? "Pronto a ricevere e a inviare (dopo la tua conferma)"
        : w ? "Pronto a ricevere; per inviare mancano dei dati"
          : provider === "360dialog" && i ? "Chiave salvata: ora premi «Configura il webhook su 360dialog»"
            : "Non collegato: mancano dei dati",
  };
}

const PERCORSO = z.string().trim().max(120).regex(/^\/[A-Za-z0-9/_.-]{0,118}$/).refine((p) => !p.includes(".."), "percorso non valido");

export const SchemaModificaCollegamento = z.object({
  provider: z.enum(["meta", "360dialog"]).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  versione: z.string().trim().max(10).optional(),
  phoneNumberId: z.string().trim().max(40).optional(),
  /** Vuoto = non cambiare. */
  token: z.string().trim().max(1000).optional(),
  appSecret: z.string().trim().max(200).optional(),
  verifyToken: z.string().trim().max(200).optional(),
  /** [non verificato] percorsi di 360dialog (vuoto = quello di serie). */
  percorsoSalute: z.union([z.literal(""), PERCORSO]).optional(),
  percorsoSync: z.union([z.literal(""), PERCORSO]).optional(),
}).strict();

/**
 * Indirizzo di un fornitore (forma, senza rete): solo https, porta 443, niente credenziali né parametri,
 * un NOME pubblico (niente indirizzi numerici, localhost, .local, .internal…; il punto finale si toglie).
 * Stesse regole dei server di posta «altro» della Fase 2 (posta/rete.ts).
 */
export function controllaBaseUrl(u: string): string {
  let p: URL;
  try { p = new URL(u); } catch { throw new ErroreWhatsapp("Indirizzo del fornitore non valido."); }
  if (p.protocol !== "https:") throw new ErroreWhatsapp("L'indirizzo del fornitore deve iniziare con https://.");
  if (p.username || p.password) throw new ErroreWhatsapp("Niente nome utente o password nell'indirizzo.");
  if (p.port && p.port !== "443") throw new ErroreWhatsapp("Il fornitore deve usare la porta normale di https (443).");
  if (p.search || p.hash) throw new ErroreWhatsapp("Scrivi solo l'indirizzo di base, senza parametri.");
  let host: string;
  try { host = controllaNomeServer(p.hostname); } catch {
    throw new ErroreWhatsapp("Il fornitore deve avere un nome pubblico (per esempio waba-v2.360dialog.io), non un indirizzo numerico o interno.");
  }
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/.test(host) || /^metadata(\.|$)/.test(host)) {
    throw new ErroreWhatsapp("Il fornitore deve avere un nome pubblico, non un servizio che porta a indirizzi interni.");
  }
  return `https://${host}${p.pathname.replace(/\/+$/, "")}`;
}

/** Il nome del fornitore si risolve: basta un indirizzo interno (loopback, rete privata, link-local, metadati…) per bloccare. */
export async function controllaFornitoreInRete(baseUrl: string, risolvi?: RisolviNome): Promise<string> {
  const pulito = controllaBaseUrl(baseUrl);
  try { await indirizziServer(new URL(pulito).hostname, risolvi); } catch {
    throw new ErroreWhatsapp("L'indirizzo del fornitore non si raggiunge o porta a un indirizzo non ammesso (rete interna).");
  }
  return pulito;
}

/** Segreto nuovo per l'intestazione del webhook di 360dialog: 32 byte casuali. */
export const nuovoSegretoWebhook = (): string => randomBytes(32).toString("base64url");

/** Salva le modifiche (prima controlla tutto, poi scrive). Restituisce il collegamento salvato. */
export async function salvaCollegamento(f: Fonte & { risolvi?: RisolviNome }, m: z.infer<typeof SchemaModificaCollegamento>): Promise<CollegamentoWa> {
  const prima = leggiCollegamento(f);
  const provider: Provider = m.provider ?? prima?.provider ?? "meta";
  let baseUrl = "";
  if (provider === "360dialog") {
    const scritto = m.baseUrl !== undefined ? m.baseUrl : prima?.provider === "360dialog" ? prima.baseUrl : "";
    baseUrl = await controllaFornitoreInRete(scritto || BASE_360, f.risolvi);
  }
  const versione = m.versione !== undefined ? (m.versione || VERSIONE_PREDEFINITA) : prima?.versione || VERSIONE_PREDEFINITA;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(versione)) throw new ErroreWhatsapp("La versione della Graph API si scrive come v27.0.");
  const phoneNumberId = m.phoneNumberId !== undefined ? m.phoneNumberId : prima?.phoneNumberId ?? "";
  if (phoneNumberId && !/^\d{5,30}$/.test(phoneNumberId)) throw new ErroreWhatsapp("L'id del numero (phone_number_id) è fatto solo di cifre.");
  // Il token salvato resta valido solo se non cambiano fornitore e indirizzo.
  const cambiaDestinazione = !!prima && (prima.provider !== provider || (provider === "360dialog" && prima.baseUrl !== baseUrl));
  const token = m.token ? m.token : prima?.token ?? "";
  if (cambiaDestinazione && !m.token && token) throw new ErroreWhatsapp("Hai cambiato fornitore o indirizzo: riscrivi il token o la chiave API.");
  if (token && /[\s\u0000-\u001f]/.test(token)) throw new ErroreWhatsapp("Il token non deve contenere spazi.");
  // Segreto dell'app e parola di verifica valgono per Meta: cambiando fornitore si cancellano (vanno riscritti).
  const cambiaFornitore = !!prima && prima.provider !== provider;
  const appSecret = m.appSecret ? m.appSecret : cambiaFornitore ? "" : prima?.appSecret ?? "";
  const verifyToken = m.verifyToken ? m.verifyToken : cambiaFornitore ? "" : prima?.verifyToken ?? "";
  if (m.verifyToken && m.verifyToken.length < 12) throw new ErroreWhatsapp("La parola di verifica deve avere almeno 12 caratteri.");
  if (m.appSecret && !/^[A-Za-z0-9]{16,200}$/.test(m.appSecret)) throw new ErroreWhatsapp("Il segreto dell'app di Meta è fatto di lettere e cifre (almeno 16).");
  // Il segreto del webhook di 360dialog vale solo per quel fornitore e quell'indirizzo: se cambia uno dei due si cancella
  // (il webhook resta spento finché Jarvis non lo riconfigura). Con una chiave nuova dello stesso numero resta.
  const tieniSegreto = !!prima && !cambiaDestinazione && provider === "360dialog";
  const c: CollegamentoWa = {
    provider, baseUrl, versione, phoneNumberId, token, appSecret, verifyToken,
    webhookSecret: tieniSegreto ? prima.webhookSecret : "",
    segretiPrecedenti: tieniSegreto ? prima.segretiPrecedenti : [],
    webhookConfigurato: tieniSegreto ? prima.webhookConfigurato : 0,
    percorsoSalute: m.percorsoSalute !== undefined ? (m.percorsoSalute || PERCORSO_SALUTE_360) : prima?.percorsoSalute || PERCORSO_SALUTE_360,
    percorsoSync: m.percorsoSync !== undefined ? (m.percorsoSync || PERCORSO_SYNC_360) : prima?.percorsoSync || PERCORSO_SYNC_360,
  };
  scriviCollegamento(f, c);
  return c;
}

/** Scrive il collegamento così com'è (già controllato). */
export function scriviCollegamento(f: Fonte, c: CollegamentoWa): void {
  salvaSegreto(f.db, f.cifratore, "whatsapp", JSON.stringify(c));
}

/**
 * Scrittura «se non è cambiato niente» (compare-and-set): rilegge il collegamento e scrive solo se `condizione` è vera
 * sul valore di adesso. Lettura e scrittura sono una dopo l'altra senza attese (better-sqlite3 è sincrono), quindi nessun
 * altro salvataggio può infilarsi in mezzo. Restituisce true se ha scritto.
 */
export function aggiornaSe(f: Fonte, condizione: (adesso: CollegamentoWa | null) => boolean, modifica: (adesso: CollegamentoWa) => CollegamentoWa): boolean {
  const adesso = leggiCollegamento(f);
  if (!adesso || !condizione(adesso)) return false;
  scriviCollegamento(f, modifica(adesso));
  return true;
}

export function scollega(f: Fonte): void {
  salvaSegreto(f.db, f.cifratore, "whatsapp", "");
}
