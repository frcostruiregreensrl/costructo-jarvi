// Lettura di un calendario tramite link iCal (.ics): Apple iCloud, Google, Outlook. SOLA LETTURA.
// Portato da calendar.mjs di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo) con queste correzioni:
// - sicurezza: solo https (webcal → https), niente indirizzi interni (SSRF), redirect controllati, limite di 2 MB;
// - cache per link (non più una sola globale), fuso di Luigi invece di quello del server;
// - ricorrenze mensili/annuali con BYDAY ("2° martedì", "ultimo venerdì") e BYMONTHDAY;
// - nomi di fuso di Windows/Outlook più comuni, TZID tra virgolette;
// - i testi degli eventi sono DATI: chi li usa li passa all'AI marcati come non attendibili.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { scartoFuso } from "./tempo.js";

export interface OraMuro { y: number; mo: number; d: number; h: number; mi: number; s: number; tz: string; allDay: boolean }
export interface EventoIcs {
  uid?: string; summary?: string; location?: string; status?: string;
  start?: OraMuro | null; end?: OraMuro | null; rrule?: Record<string, string>; recurrenceId?: OraMuro | null; exdates: Set<number>;
}
export interface Occorrenza { titolo: string; luogo: string; inizio: number; fine: number; tuttoIlGiorno: boolean; fonte: "calendario" }

const FUSI_WINDOWS: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "UTC": "UTC",
  "Eastern Standard Time": "America/New_York",
  "Pacific Standard Time": "America/Los_Angeles",
};

// ---------------------------------------------------------------- scaricamento sicuro
const MAX_BYTE = 2 * 1024 * 1024;

export function ipPrivato(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return ipPrivato(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}

export type RisolviNome = (host: string) => Promise<string[]>;
const risolviPredefinito: RisolviNome = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Controlla che l'indirizzo sia https e non punti alla rete interna. Lancia un errore leggibile. */
export async function controllaIndirizzo(url: string, risolvi: RisolviNome = risolviPredefinito): Promise<URL> {
  let u: URL;
  try { u = new URL(url.trim().replace(/^webcal:\/\//i, "https://")); } catch { throw new Error("Il link del calendario non è valido."); }
  if (u.protocol !== "https:") throw new Error("Il link del calendario deve iniziare con https:// o webcal://.");
  if (u.username || u.password) throw new Error("Il link non deve contenere nome utente o password.");
  if (u.port && u.port !== "443") throw new Error("Porta non ammessa nel link del calendario.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const indirizzi = isIP(host) ? [host] : await risolvi(host);
  if (!indirizzi.length || indirizzi.some(ipPrivato)) throw new Error("Il link del calendario punta a un indirizzo non ammesso.");
  return u;
}

const cache = new Map<string, { quando: number; eventi: EventoIcs[] }>();

export async function scaricaCalendario(url: string, opz: { maxEtaMs?: number; fetchFn?: typeof fetch; risolvi?: RisolviNome } = {}): Promise<EventoIcs[]> {
  const maxEta = opz.maxEtaMs ?? 5 * 60_000;
  const c = cache.get(url);
  if (c && Date.now() - c.quando < maxEta) return c.eventi;
  const f = opz.fetchFn ?? fetch;
  let indirizzo = await controllaIndirizzo(url, opz.risolvi);
  let r: Response | null = null;
  for (let salti = 0; salti < 4; salti++) {
    r = await f(indirizzo, { redirect: "manual", signal: AbortSignal.timeout(12_000), headers: { Accept: "text/calendar" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      indirizzo = await controllaIndirizzo(new URL(r.headers.get("location")!, indirizzo).toString(), opz.risolvi);
      continue;
    }
    break;
  }
  if (!r || !r.ok) throw new Error(`Il calendario ha risposto ${r?.status ?? "?"}.`);
  const dichiarata = Number(r.headers.get("content-length") || 0);
  if (dichiarata > MAX_BYTE) throw new Error("Il calendario è troppo grande.");
  const testo = await leggiConLimite(r, MAX_BYTE);
  if (!testo.includes("BEGIN:VCALENDAR")) throw new Error("Il link non è un calendario iCal.");
  const eventi = analizzaIcs(testo);
  cache.set(url, { quando: Date.now(), eventi });
  if (cache.size > 10) cache.delete(cache.keys().next().value!);
  return eventi;
}

async function leggiConLimite(r: Response, max: number): Promise<string> {
  if (!r.body) return "";
  const lettore = r.body.getReader();
  const pezzi: Uint8Array[] = [];
  let tot = 0;
  for (;;) {
    const { value, done } = await lettore.read();
    if (done) break;
    tot += value.byteLength;
    if (tot > max) { await lettore.cancel(); throw new Error("Il calendario è troppo grande."); }
    pezzi.push(value);
  }
  return Buffer.concat(pezzi).toString("utf8");
}

// ---------------------------------------------------------------- analisi del testo iCal
export function analizzaIcs(testo: string): EventoIcs[] {
  const righe = testo.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const eventi: EventoIcs[] = [];
  let cur: EventoIcs | null = null;
  for (const riga of righe) {
    if (riga === "BEGIN:VEVENT") { cur = { exdates: new Set() }; continue; }
    if (riga === "END:VEVENT") { if (cur?.start && cur.status !== "CANCELLED") eventi.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = riga.indexOf(":");
    if (i < 0) continue;
    const [nome, ...param] = riga.slice(0, i).split(";");
    const valore = riga.slice(i + 1);
    const p: Record<string, string> = Object.fromEntries(param.map((x) => { const j = x.indexOf("="); return [x.slice(0, j), x.slice(j + 1).replace(/^"|"$/g, "")]; }));
    switch (nome) {
      case "UID": cur.uid = valore; break;
      case "SUMMARY": cur.summary = togliEscape(valore); break;
      case "LOCATION": cur.location = togliEscape(valore); break;
      case "STATUS": cur.status = valore; break;
      case "DTSTART": cur.start = leggiData(valore, p); break;
      case "DTEND": cur.end = leggiData(valore, p); break;
      case "RRULE": cur.rrule = Object.fromEntries(valore.split(";").map((x) => x.split("="))); break;
      case "RECURRENCE-ID": cur.recurrenceId = leggiData(valore, p); break;
      case "EXDATE": for (const v of valore.split(",")) { const d = leggiData(v, p); if (d) cur.exdates.add(aIstante(d, "UTC")); } break;
    }
  }
  return eventi;
}
const togliEscape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim().slice(0, 300);

function leggiData(v: string, p: Record<string, string>): OraMuro | null {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const allDay = p.VALUE === "DATE" || !m[4];
  const tzid = p.TZID ? (FUSI_WINDOWS[p.TZID] || p.TZID) : "";
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), tz: m[7] ? "UTC" : allDay ? "local" : tzid || "local", allDay };
}

/** Ora da muro → istante. "local" = fuso di Luigi. EXDATE senza fuso usa lo stesso criterio. */
function aIstante(w: OraMuro, fusoLocale: string): number {
  const tz = w.tz === "local" ? fusoLocale : w.tz;
  const ipotesi = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
  if (tz === "UTC") return ipotesi;
  try {
    let utc = ipotesi - scartoFuso(ipotesi, tz);
    utc = ipotesi - scartoFuso(utc, tz);
    return utc;
  } catch {
    let utc = ipotesi - scartoFuso(ipotesi, fusoLocale); // TZID sconosciuto: fuso di Luigi
    utc = ipotesi - scartoFuso(utc, fusoLocale);
    return utc;
  }
}

function aggiungiGiorni(w: OraMuro, n: number): OraMuro {
  const t = new Date(Date.UTC(w.y, w.mo, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}
const giorniNelMese = (y: number, mo: number) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
const GIORNI = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Giorni del mese (y, mo) che rispettano BYDAY (con ordinale: 2TU, -1FR) e/o BYMONTHDAY. */
function giorniDelMese(r: Record<string, string>, y: number, mo: number, giornoBase: number): number[] {
  const ultimo = giorniNelMese(y, mo);
  let giorni: number[] = [];
  if (r.BYMONTHDAY) {
    giorni = r.BYMONTHDAY.split(",").map(Number).map((n) => (n < 0 ? ultimo + n + 1 : n)).filter((n) => n >= 1 && n <= ultimo);
  } else if (r.BYDAY) {
    for (const voce of r.BYDAY.split(",")) {
      const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(voce);
      if (!m) continue;
      const dow = GIORNI.indexOf(m[2]);
      const tutti: number[] = [];
      for (let d = 1; d <= ultimo; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === dow) tutti.push(d);
      if (!m[1]) giorni.push(...tutti);
      else { const n = +m[1]; const scelto = n > 0 ? tutti[n - 1] : tutti[tutti.length + n]; if (scelto) giorni.push(scelto); }
    }
  } else if (giornoBase <= ultimo) giorni = [giornoBase];
  if (r.BYSETPOS) {
    const ord = [...new Set(giorni)].sort((a, b) => a - b);
    const pos = +r.BYSETPOS;
    const scelto = pos > 0 ? ord[pos - 1] : ord[ord.length + pos];
    return scelto ? [scelto] : [];
  }
  return [...new Set(giorni)].sort((a, b) => a - b);
}

/** Occorrenze tra da e a (ms UTC), ordinate. */
export function occorrenze(eventi: EventoIcs[], da: number, a: number, fuso: string): Occorrenza[] {
  const out: Occorrenza[] = [];
  const sostituiti = new Set(eventi.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${aIstante(e.recurrenceId!, fuso)}`));
  for (const ev of eventi) {
    const inizioEv = aIstante(ev.start!, fuso);
    const durata = Math.max(0, aIstante(ev.end || ev.start!, fuso) - inizioEv);
    const metti = (w: OraMuro) => {
      const s = aIstante(w, fuso);
      if (ev.exdates.has(s) || ev.exdates.has(Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s))) return;
      if (!ev.recurrenceId && sostituiti.has(`${ev.uid}|${s}`)) return;
      const e = s + durata;
      if (e > da && s < a) out.push({ titolo: ev.summary || "Evento", luogo: ev.location || "", inizio: s, fine: e, tuttoIlGiorno: !!ev.start!.allDay, fonte: "calendario" });
    };
    if (!ev.rrule) { metti(ev.start!); continue; }
    espandi(ev, da, a, fuso, metti);
  }
  return out.sort((x, y) => x.inizio - y.inizio);
}

function espandi(ev: EventoIcs, da: number, a: number, fuso: string, metti: (w: OraMuro) => void): void {
  const r = ev.rrule!, intervallo = Math.max(1, +(r.INTERVAL || 1));
  const fino = r.UNTIL ? aIstante(leggiData(r.UNTIL, {})!, fuso) : null;
  let conteggio = r.COUNT ? +r.COUNT : Infinity;
  const limite = fino !== null && fino < a ? fino : a;
  const start = ev.start!;
  const inizioMs = aIstante(start, fuso);
  const emetti = (w: OraMuro): boolean => {
    if (conteggio <= 0) return false;
    const t = aIstante(w, fuso);
    if (t > limite) return false;
    if (t < inizioMs) return true;
    conteggio--;
    metti(w);
    return true;
  };
  let k0 = 0;
  if (conteggio === Infinity) {
    const giorni = (da - inizioMs) / 864e5;
    const unita = ({ DAILY: giorni, WEEKLY: giorni / 7, MONTHLY: giorni / 31, YEARLY: giorni / 366 } as Record<string, number>)[r.FREQ] || 0;
    k0 = Math.max(0, Math.floor(unita / intervallo) - 1) * intervallo;
  }
  for (let k = k0, passi = 0; passi < 3000; k += intervallo, passi++) {
    if (r.FREQ === "DAILY") { if (!emetti(aggiungiGiorni(start, k))) return; }
    else if (r.FREQ === "WEEKLY") {
      const dow = new Date(Date.UTC(start.y, start.mo, start.d)).getUTCDay();
      const giorni = (r.BYDAY || GIORNI[dow]).split(",").map((x) => GIORNI.indexOf(x.slice(-2)));
      const lunedi = aggiungiGiorni(start, k * 7 - ((dow + 6) % 7));
      for (const g of giorni.sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7))) {
        if (!emetti(aggiungiGiorni(lunedi, (g + 6) % 7))) return;
      }
    } else if (r.FREQ === "MONTHLY" || r.FREQ === "YEARLY") {
      const passoMesi = r.FREQ === "MONTHLY" ? k : k * 12;
      const t = new Date(Date.UTC(start.y, start.mo + passoMesi, 1));
      const y = t.getUTCFullYear();
      let mo = t.getUTCMonth();
      if (r.FREQ === "YEARLY" && r.BYMONTH) mo = +r.BYMONTH - 1;
      for (const d of giorniDelMese(r, y, mo, start.d)) {
        if (!emetti({ ...start, y, mo, d })) return;
      }
    } else { emetti(start); return; }
  }
}
