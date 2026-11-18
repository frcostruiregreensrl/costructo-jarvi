// Lettura di una mail senza AI: intestazioni, testo breve senza HTML, allegati (solo nomi e dimensioni),
// PEC (busta e ricevute), filtro gratuito per newsletter e messaggi automatici, parole di denaro e impegni.
// Il testo delle mail è un DATO non attendibile: chi lo passa all'AI lo racchiude in marcaDati().
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { MessaggioGrezzo, Segni } from "./tipi.js";

/** Testo breve salvato per ogni mail: al massimo 4 KB. */
export const MAX_ESTRATTO_BYTE = 4096;
/** Quanto si scarica di ogni mail: bastano intestazioni e inizio del testo (gli allegati non servono). */
export const MAX_SORGENTE_BYTE = 256 * 1024;

export interface MailLetta {
  messageId: string;
  riferimenti: string;
  daNome: string;
  daIndirizzo: string;
  rispondiA: string;
  a: string;
  oggetto: string;
  data: number;
  estratto: string;
  allegati: Array<{ nome: string; dimensione: number }>;
  segni: Segni;
}

const breve = (t: string, n: number) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Toglie l'HTML rimasto, comprime gli spazi e taglia a `max` byte (senza spezzare un carattere). */
export function pulisciTesto(testo: string, max = MAX_ESTRATTO_BYTE): string {
  let t = testo
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(t) <= max) return t;
  t = Buffer.from(t).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
  return `${t}…`;
}

function primoIndirizzo(a: AddressObject | AddressObject[] | undefined): { nome: string; indirizzo: string } {
  const o = Array.isArray(a) ? a[0] : a;
  const v = o?.value?.[0];
  return { nome: breve(v?.name ?? "", 120), indirizzo: breve(v?.address ?? "", 200).toLowerCase() };
}
function elencoIndirizzi(a: AddressObject | AddressObject[] | undefined): string {
  const tutti = (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value ?? []);
  return breve(tutti.map((v) => v.address ?? "").filter(Boolean).join(", "), 500).toLowerCase();
}

function intestazione(p: ParsedMail, nome: string): string {
  const v = p.headers.get(nome.toLowerCase());
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "value" in (v as object)) return String((v as { value: unknown }).value ?? "");
  if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text ?? "");
  return String(v);
}

// ---------------------------------------------------------------- PEC
const RICEVUTE: Record<string, NonNullable<Segni["pec"]>> = {
  "accettazione": "accettazione",
  "avvenuta-consegna": "consegna",
  "non-accettazione": "non_accettazione",
  "errore-consegna": "mancata_consegna",
  "preavviso-errore-consegna": "mancata_consegna",
  "presa-in-carico": "presa_in_carico",
  "rilevazione-virus": "errore",
};

/** Riconosce la busta PEC e le ricevute dalle intestazioni (X-Ricevuta, X-Trasporto) o dall'oggetto. */
export function rilevaPec(ricevuta: string, trasporto: string, oggetto: string): Segni["pec"] | undefined {
  const r = ricevuta.trim().toLowerCase();
  if (r && RICEVUTE[r]) return RICEVUTE[r];
  const t = trasporto.trim().toLowerCase();
  if (t === "posta-certificata") return "messaggio";
  if (t === "errore") return "errore";
  const o = oggetto.trim().toUpperCase();
  if (o.startsWith("ACCETTAZIONE:")) return "accettazione";
  if (o.startsWith("CONSEGNA:")) return "consegna";
  if (o.startsWith("AVVISO DI NON ACCETTAZIONE")) return "non_accettazione";
  if (o.startsWith("AVVISO DI MANCATA CONSEGNA")) return "mancata_consegna";
  if (o.startsWith("POSTA CERTIFICATA:")) return "messaggio";
  return undefined;
}

// ---------------------------------------------------------------- mittenti automatici
const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|non[-_.]?rispondere|mailer-daemon|postmaster|bounce[s]?|notifich[ea]|notifications?|newsletter|news|info-?noreply)([+._-].*)?$/i;

export function segniDa(p: ParsedMail, indirizzo: string, pec: Segni["pec"]): Segni {
  const s: Segni = {};
  const precedenza = intestazione(p, "precedence").toLowerCase();
  // mailparser raccoglie le intestazioni List-* sotto «list»: si guardano anche le righe originali.
  const conList = p.headers.has("list") || p.headerLines.some((h) => /^list-(id|unsubscribe|post|help|subscribe|owner|archive)$/i.test(h.key));
  if (conList || /\b(bulk|list|junk)\b/.test(precedenza)) s.lista = true;
  const auto = intestazione(p, "auto-submitted").toLowerCase().trim();
  if ((auto && auto !== "no") || p.headers.has("x-autoreply") || p.headers.has("x-autorespond") || /^(auto-replied|auto-generated)/.test(auto)) s.automatico = true;
  const locale = indirizzo.split("@")[0] ?? "";
  if (NO_REPLY.test(locale)) s.noReply = true;
  if (/^(mailer-daemon|postmaster)$/i.test(locale)) s.automatico = true;
  if (pec) s.pec = pec;
  return s;
}

// ---------------------------------------------------------------- lettura
/**
 * Legge una mail grezza. Per la PEC il messaggio vero sta nell'allegato «postacert.eml»: se c'è,
 * oggetto, testo e mittente vengono da lì (la busta dice solo «Per conto di: …»).
 */
export async function leggiMail(g: MessaggioGrezzo): Promise<MailLetta> {
  const p = await simpleParser(g.sorgente, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 512 * 1024 });
  let oggetto = breve(p.subject ?? "", 300);
  let { nome: daNome, indirizzo: daIndirizzo } = primoIndirizzo(p.from);
  const rispondiA = primoIndirizzo(p.replyTo).indirizzo;
  const pec = rilevaPec(intestazione(p, "x-ricevuta"), intestazione(p, "x-trasporto"), oggetto);
  let testo = p.text || (typeof p.html === "string" ? p.html : "");
  let messageId = breve(p.messageId ?? "", 300);
  let riferimenti = breve([...(Array.isArray(p.references) ? p.references : p.references ? [p.references] : [])].join(" "), 1000);
  const segni = segniDa(p, daIndirizzo, pec);

  if (pec === "messaggio") {
    // Busta di trasporto: «Per conto di: mario@pec.it <posta-certificata@pec.aruba.it>»
    const perConto = /per conto di:?\s*([^\s<>"]+@[^\s<>"]+)/i.exec(daNome);
    if (perConto) daIndirizzo = perConto[1].toLowerCase();
    else if (rispondiA) daIndirizzo = rispondiA;
    const interno = p.attachments.find((a) => /postacert\.eml$/i.test(a.filename ?? "") || a.contentType === "message/rfc822");
    if (interno?.content) {
      try {
        const q = await simpleParser(interno.content, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 512 * 1024 });
        oggetto = breve(q.subject ?? oggetto.replace(/^POSTA CERTIFICATA:\s*/i, ""), 300);
        testo = q.text || (typeof q.html === "string" ? q.html : "") || testo;
        const vero = primoIndirizzo(q.from);
        if (vero.indirizzo) { daIndirizzo = vero.indirizzo; daNome = vero.nome; }
        if (q.messageId) messageId = breve(q.messageId, 300);
      } catch { /* allegato troncato o rovinato: resta la busta */ }
    } else {
      oggetto = oggetto.replace(/^POSTA CERTIFICATA:\s*/i, "");
    }
    daNome = daNome.replace(/per conto di:?\s*/i, "").trim();
  }

  const allegati = (g.allegati ?? p.attachments
    .filter((a) => !(pec === "messaggio" && /^(postacert\.eml|daticert\.xml|smime\.p7s)$/i.test(a.filename ?? "")))
    .map((a) => ({ nome: breve(a.filename ?? "allegato", 200), dimensione: a.size ?? 0 })))
    .slice(0, 30);
  const data = p.date && Number.isFinite(p.date.getTime()) ? p.date.getTime() : g.data?.getTime() ?? Date.now();
  return {
    messageId, riferimenti, daNome, daIndirizzo, rispondiA, a: elencoIndirizzi(p.to), oggetto,
    data, estratto: pulisciTesto(testo), allegati, segni,
  };
}

// ---------------------------------------------------------------- filtro gratuito (senza AI)
export interface EsitoFiltro { filtrato: boolean; riassunto: string }

/**
 * Newsletter, mailing list, messaggi automatici, no-reply e ricevute PEC: non sono urgenti e non
 * serve l'AI per dirlo (costo zero). Il riassunto è fatto con l'oggetto.
 */
export function prefiltra(m: { oggetto: string; daNome: string; daIndirizzo: string; segni: Segni }): EsitoFiltro {
  const s = m.segni, o = m.oggetto || "(senza oggetto)";
  const nomiPec: Record<string, string> = {
    accettazione: "Ricevuta PEC di accettazione", consegna: "Ricevuta PEC di avvenuta consegna", presa_in_carico: "Ricevuta PEC di presa in carico",
  };
  if (s.pec && nomiPec[s.pec]) return { filtrato: true, riassunto: `${nomiPec[s.pec]}: ${o}` };
  if (s.lista) return { filtrato: true, riassunto: `Newsletter o mailing list: ${o}` };
  if (s.automatico) return { filtrato: true, riassunto: `Messaggio automatico: ${o}` };
  if (s.noReply) return { filtrato: true, riassunto: `Avviso automatico (no-reply): ${o}` };
  return { filtrato: false, riassunto: "" };
}

// ---------------------------------------------------------------- denaro, importi, impegni
// Se una di queste parole compare in oggetto o testo, la mail NON riceve mai una conferma automatica
// (anche se l'AI dice il contrario). Nel dubbio si preferisce non mandare niente.
const PAROLE_DENARO = new RegExp([
  "euro", "eur", "importi?", "pagament[oi]", "pagare", "pagato", "pagata", "paga", "bonific[oi]", "fattur[ae]", "fatturazione", "preventiv[oi]",
  "scadenz[ae]", "scade", "scaduto", "scaduta", "contratt[oi]", "ordin[ei]", "ordinativo", "penal[ei]", "sollecit[oi]", "iban", "saldo", "acconto",
  "caparra", "rat[ae]", "addebit[oi]", "accredit[oi]", "offert[ae]", "quotazione", "prezz[oi]", "cost[oi]", "sconto", "nota di credito", "ddt",
  "f24", "mora", "interessi", "ingiunzione", "ingiuntivo", "diffida", "avvocat[oi]", "legale", "tribunale", "firma", "firmare", "impegn[oi]",
  "impegnarsi", "garanzia", "fideiussione", "cauzione", "pos", "ricevuta di pagamento", "rimborso", "debito", "credito", "versamento",
].map((p) => `\\b${p}\\b`).join("|"), "i");
const SIMBOLI_DENARO = /[€$£]|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\b|\b\d+,\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:k€|keur|mila euro)\b/i;

/** Vero se oggetto o testo parlano di soldi, importi, pagamenti o impegni (controllo senza AI). */
export function parlaDiDenaro(...testi: string[]): boolean {
  const t = testi.join("\n");
  return PAROLE_DENARO.test(t) || SIMBOLI_DENARO.test(t);
}

/** Domini delle caselle PEC più comuni: a un indirizzo PEC non si risponde mai in automatico. */
export function indirizzoPec(indirizzo: string): boolean {
  const dominio = indirizzo.split("@")[1] ?? "";
  return /(^|\.)pec\.|(^|\.)(legalmail\.it|pec\.it|postacert\.it|arubapec\.it|cert\.legalmail\.it|pecveneto\.it|sicurezzapostale\.it|postecert\.it|registerpec\.it|gigapec\.it)$/i.test(dominio)
    || /(^|\.)pec$/i.test(dominio.split(".").slice(0, -1).join("."));
}
