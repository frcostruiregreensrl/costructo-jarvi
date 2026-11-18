// Calendario Apple (iCloud) con CalDAV, in SOLA LETTURA.
// Luigi scrive l'Apple ID e una «password specifica per le app» (account.apple.com → Accesso e sicurezza).
// Scoperta: PROPFIND https://caldav.icloud.com/ (current-user-principal) → calendar-home-set → elenco dei calendari
// (nome e colore) → REPORT calendar-query con l'intervallo di date → eventi (VEVENT) letti con il parser iCal
// già esistente (ricorrenze comprese, con `occorrenze`).
// Sicurezza: solo https, solo nomi *.icloud.com (anche per i reindirizzamenti e per gli indirizzi che risponde iCloud),
// porta 443; la password viaggia solo verso iCloud. Apple ID e password stanno nel segreto cifrato «calendario_apple».
// Luigi sceglie quali calendari usare e per ognuno se è privato o di un'azienda. Risultati in cache per 5 minuti.
import { z } from "zod";
import type { Db } from "./db.js";
import type { Cifratore } from "./sicurezza/cifra.js";
import { leggiSegreto, salvaSegreto } from "./impostazioni.js";
import { analizzaIcs, occorrenze, type Occorrenza } from "./calendario.js";

export const RADICE_ICLOUD = "https://caldav.icloud.com/";
const MAX_REINDIRIZZAMENTI = 3;
const MAX_BYTE = 4 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;

export class ErroreApple extends Error {
  constructor(messaggio: string, readonly stato = 400) { super(messaggio); }
}

export interface CalendarioApple {
  url: string;
  nome: string;
  colore: string;
  /** Usato da Jarvis (briefing e agenda)? */
  incluso: boolean;
  /** «privato» oppure l'id di un'azienda. */
  spazio: string;
}
export interface ImpostazioniApple { appleId: string; password: string; calendari: CalendarioApple[] }

const SchemaCal = z.object({ url: z.string().url().max(500), nome: z.string().max(100), colore: z.string().max(20), incluso: z.boolean(), spazio: z.string().min(1).max(40) });
const SchemaImp = z.object({ appleId: z.string().min(3).max(200), password: z.string().min(1).max(200), calendari: z.array(SchemaCal).max(50) });

export interface FonteApple { db: Db; cifratore: Cifratore; fetchFn?: typeof fetch }

export function leggiApple(f: FonteApple): ImpostazioniApple | null {
  const grezzo = leggiSegreto(f.db, f.cifratore, "calendario_apple");
  if (!grezzo) return null;
  try { const ok = SchemaImp.safeParse(JSON.parse(grezzo)); return ok.success ? ok.data : null; } catch { return null; }
}
function salvaApple(f: FonteApple, imp: ImpostazioniApple | null): void {
  salvaSegreto(f.db, f.cifratore, "calendario_apple", imp ? JSON.stringify(imp) : "");
  cache.clear();
}

/** Per l'interfaccia: mai la password, nemmeno le ultime cifre. */
export function appleVisibile(f: FonteApple) {
  const imp = leggiApple(f);
  return imp
    ? { collegato: true, appleId: imp.appleId, password: "••••", passwordImpostata: true, calendari: imp.calendari }
    : { collegato: false, appleId: "", password: "", passwordImpostata: false, calendari: [] as CalendarioApple[] };
}

// ---------------------------------------------------------------- richieste verso iCloud
/** Solo https, solo *.icloud.com, solo porta 443, niente credenziali nel link. */
export function urlIcloud(u: string | URL, base?: string | URL): URL {
  let x: URL;
  try { x = new URL(u, base); } catch { throw new ErroreApple("Risposta di iCloud non valida."); }
  const host = x.hostname.toLowerCase();
  if (x.protocol !== "https:" || (x.port && x.port !== "443") || x.username || x.password || !(host === "icloud.com" || host.endsWith(".icloud.com"))) {
    throw new ErroreApple("iCloud ha indicato un indirizzo non ammesso: mi fermo.");
  }
  return x;
}

async function leggiTesto(r: Response): Promise<string> {
  if (Number(r.headers.get("content-length") || 0) > MAX_BYTE) throw new ErroreApple("Risposta di iCloud troppo grande.");
  if (!r.body) return "";
  const lettore = r.body.getReader();
  const pezzi: Uint8Array[] = [];
  let tot = 0;
  for (;;) {
    const { value, done } = await lettore.read();
    if (done) break;
    tot += value.byteLength;
    if (tot > MAX_BYTE) { await lettore.cancel(); throw new ErroreApple("Risposta di iCloud troppo grande."); }
    pezzi.push(value);
  }
  return Buffer.concat(pezzi).toString("utf8");
}

interface Credenziali { appleId: string; password: string }

/** Una richiesta WebDAV verso iCloud. I reindirizzamenti si seguono solo verso *.icloud.com (al massimo 3). */
async function dav(cred: Credenziali, metodo: "PROPFIND" | "REPORT", url: URL, profondita: "0" | "1", corpo: string, fetchFn: typeof fetch): Promise<{ url: URL; testo: string }> {
  const auth = `Basic ${Buffer.from(`${cred.appleId}:${cred.password}`).toString("base64")}`;
  let indirizzo = urlIcloud(url);
  for (let salti = 0; ; salti++) {
    let r: Response;
    try {
      r = await fetchFn(indirizzo, {
        method: metodo, redirect: "manual", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: auth, Depth: profondita, "Content-Type": "application/xml; charset=utf-8", Accept: "application/xml, text/xml", "User-Agent": "Jarvis-calendario" },
        body: corpo,
      });
    } catch (e) {
      if (e instanceof ErroreApple) throw e;
      throw new ErroreApple("iCloud non è raggiungibile in questo momento.", 502);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      if (salti >= MAX_REINDIRIZZAMENTI) throw new ErroreApple("iCloud fa troppi reindirizzamenti.");
      indirizzo = urlIcloud(r.headers.get("location")!, indirizzo);
      await r.body?.cancel().catch(() => {});
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new ErroreApple("Apple non ha accettato l'Apple ID o la password. Serve una «password specifica per le app» (account.apple.com → Accesso e sicurezza), non la password normale.", 401);
    if (r.status !== 207 && !r.ok) throw new ErroreApple(`iCloud ha risposto ${r.status}.`, 502);
    return { url: indirizzo, testo: await leggiTesto(r) };
  }
}

// ---------------------------------------------------------------- lettura dell'XML (senza librerie: poche etichette note)
const decodifica = (t: string) => t
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

/** Le <response> di una risposta multistatus. */
function risposte(xml: string): string[] {
  return [...xml.matchAll(/<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/gi)].map((m) => m[0]);
}
/** Il testo di un'etichetta (con qualunque prefisso), oppure "". */
function etichetta(xml: string, nome: string): string {
  const m = new RegExp(`<(?:[\\w-]+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`, "i").exec(xml);
  return m ? m[1] : "";
}
const href = (xml: string) => decodifica(etichetta(xml, "href").trim());
const haEtichetta = (xml: string, nome: string) => new RegExp(`<(?:[\\w-]+:)?${nome}[\\s/>]`, "i").test(xml);

const CORPO_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const CORPO_HOME = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const CORPO_CALENDARI = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

const dataCaldav = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
export function corpoIntervallo(da: number, a: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>`
    + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${dataCaldav(da)}" end="${dataCaldav(a)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** Scopre i calendari dell'account (solo quelli con eventi). Lancia ErroreApple con un messaggio chiaro. */
export async function scopriCalendari(cred: Credenziali, fetchFn: typeof fetch = fetch): Promise<Array<{ url: string; nome: string; colore: string }>> {
  const p = await dav(cred, "PROPFIND", new URL(RADICE_ICLOUD), "0", CORPO_PRINCIPAL, fetchFn);
  const principal = href(etichetta(p.testo, "current-user-principal"));
  if (!principal) throw new ErroreApple("iCloud non ha indicato l'account: riprova più tardi.", 502);
  const h = await dav(cred, "PROPFIND", urlIcloud(principal, p.url), "0", CORPO_HOME, fetchFn);
  const casa = href(etichetta(h.testo, "calendar-home-set"));
  if (!casa) throw new ErroreApple("iCloud non ha indicato dove sono i calendari.", 502);
  const homeUrl = urlIcloud(casa, h.url);
  const c = await dav(cred, "PROPFIND", homeUrl, "1", CORPO_CALENDARI, fetchFn);
  const out: Array<{ url: string; nome: string; colore: string }> = [];
  for (const r of risposte(c.testo)) {
    const tipo = etichetta(r, "resourcetype");
    if (!haEtichetta(tipo, "calendar")) continue;
    const componenti = etichetta(r, "supported-calendar-component-set");
    if (componenti && !/name=["']VEVENT["']/i.test(componenti)) continue; // solo promemoria: non servono
    const url = urlIcloud(href(r), homeUrl).toString();
    const nome = decodifica(etichetta(r, "displayname")).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 100) || "Calendario";
    const colore = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(decodifica(etichetta(r, "calendar-color")).trim()) ? decodifica(etichetta(r, "calendar-color")).trim().slice(0, 7) : "";
    if (!out.some((x) => x.url === url)) out.push({ url, nome, colore });
  }
  return out;
}

/** Eventi (VEVENT) di un calendario nell'intervallo, già espansi nelle singole occorrenze. */
export async function eventiCalendario(cred: Credenziali, url: string, da: number, a: number, fuso: string, fetchFn: typeof fetch = fetch): Promise<Occorrenza[]> {
  const r = await dav(cred, "REPORT", urlIcloud(url), "1", corpoIntervallo(da, a), fetchFn);
  const testi = risposte(r.testo).map((x) => decodifica(etichetta(x, "calendar-data"))).filter((t) => t.includes("BEGIN:VCALENDAR"));
  return occorrenze(testi.flatMap((t) => analizzaIcs(t)), da, a, fuso);
}

// ---------------------------------------------------------------- impostazioni (da Impostazioni → Calendario Apple)
/** Salva Apple ID e password SOLO se iCloud li accetta; mantiene le scelte dei calendari già fatte. */
export async function collegaApple(f: FonteApple, appleId: string, password: string): Promise<ImpostazioniApple> {
  const id = appleId.trim();
  const pw = password.replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) throw new ErroreApple("Scrivi l'Apple ID (l'indirizzo email dell'account Apple).");
  if (!pw) throw new ErroreApple("Scrivi la password specifica per le app.");
  const trovati = await scopriCalendari({ appleId: id, password: pw }, f.fetchFn ?? fetch);
  const prima = leggiApple(f)?.calendari ?? [];
  const calendari = trovati.map((t) => {
    const p = prima.find((x) => x.url === t.url);
    return { ...t, incluso: p?.incluso ?? true, spazio: p?.spazio ?? "privato" };
  });
  const imp = { appleId: id, password: pw, calendari };
  salvaApple(f, imp);
  return imp;
}

export function scegliCalendari(f: FonteApple, scelte: Array<{ url: string; incluso: boolean; spazio: string }>, aziendeIds: string[]): ImpostazioniApple {
  const imp = leggiApple(f);
  if (!imp) throw new ErroreApple("Il calendario Apple non è collegato.", 404);
  for (const s of scelte) {
    if (s.spazio !== "privato" && !aziendeIds.includes(s.spazio)) throw new ErroreApple("Scegli «Privato» oppure un'azienda collegata.");
  }
  const nuovo = { ...imp, calendari: imp.calendari.map((c) => { const s = scelte.find((x) => x.url === c.url); return s ? { ...c, incluso: s.incluso, spazio: s.spazio } : c; }) };
  salvaApple(f, nuovo);
  return nuovo;
}

export function scollegaApple(f: FonteApple): void { salvaApple(f, null); }

// ---------------------------------------------------------------- per briefing e strumenti
export interface EventoApple extends Occorrenza { calendario: string; spazio: string }
const cache = new Map<string, { quando: number; eventi: EventoApple[]; avvisi: string[] }>();

/**
 * Eventi dei calendari scelti tra `da` e `a`. Un calendario che non risponde non ferma gli altri:
 * il suo errore finisce in `avvisi`. Cache di 5 minuti.
 */
export async function eventiApple(f: FonteApple, da: number, a: number, fuso: string): Promise<{ eventi: EventoApple[]; avvisi: string[] }> {
  const imp = leggiApple(f);
  if (!imp) return { eventi: [], avvisi: [] };
  const scelti = imp.calendari.filter((c) => c.incluso);
  const chiave = `${imp.appleId}|${da}|${a}|${scelti.map((c) => `${c.url}=${c.spazio}`).join(",")}`;
  const c = cache.get(chiave);
  if (c && Date.now() - c.quando < CACHE_MS) return { eventi: c.eventi, avvisi: c.avvisi };
  const esiti = await Promise.allSettled(scelti.map((cal) => eventiCalendario(imp, cal.url, da, a, fuso, f.fetchFn ?? fetch)));
  const eventi: EventoApple[] = [];
  const avvisi: string[] = [];
  esiti.forEach((e, i) => {
    if (e.status === "fulfilled") for (const o of e.value) eventi.push({ ...o, calendario: scelti[i].nome, spazio: scelti[i].spazio });
    else avvisi.push(`Calendario Apple «${scelti[i].nome}»: ${(e.reason as Error)?.message ?? "non risponde"}`);
  });
  eventi.sort((x, y) => x.inizio - y.inizio);
  cache.set(chiave, { quando: Date.now(), eventi, avvisi });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return { eventi, avvisi };
}
