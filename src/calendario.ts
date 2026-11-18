// Lettura di un calendario tramite link iCal (.ics): Apple iCloud, Google, Outlook. SOLA LETTURA.
// Portato da calendar.mjs di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo) con queste correzioni:
// - sicurezza: solo https (webcal → https), niente indirizzi interni (SSRF) controllati su tutti gli indirizzi
//   del nome e di nuovo al momento della connessione, al massimo 3 redirect controllati, limite di 2 MB;
// - cache per link (non più una sola globale), fuso di Luigi invece di quello del server;
// - ricorrenze mensili/annuali con BYDAY ("2° martedì", "ultimo venerdì") e BYMONTHDAY;
// - nomi di fuso di Windows/Outlook più comuni, TZID tra virgolette;
// - i testi degli eventi sono DATI: chi li usa li passa all'AI marcati come non attendibili.
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
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

// Reti che il server non deve mai raggiungere: loopback, private, link-local, CGNAT, multicast,
// metadati dei cloud (169.254.169.254, fd00:ec2::254), documentazione, riservate.
const RETI_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4aNumero(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

function v4Privato(n: number): boolean {
  return RETI_V4.some(([rete, bit]) => (n >>> (32 - bit)) === (v4aNumero(rete) >>> (32 - bit)));
}

/** Indirizzo IPv6 in 8 gruppi da 16 bit (accetta "::" e la coda IPv4 «::ffff:1.2.3.4»). null se non valido. */
export function espandiV6(ip: string): number[] | null {
  let x = ip.toLowerCase().split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) {
    if (isIP(v4[1]) !== 4) return null;
    const n = v4aNumero(v4[1]);
    x = x.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const doppio = x.split("::");
  if (doppio.length > 2) return null;
  const sx = doppio[0] ? doppio[0].split(":") : [];
  const dx = doppio.length === 2 && doppio[1] ? doppio[1].split(":") : [];
  const mancano = 8 - sx.length - dx.length;
  if (doppio.length === 1 ? mancano !== 0 : mancano < 1) return null;
  const gruppi = [...sx, ...Array(doppio.length === 2 ? mancano : 0).fill("0"), ...dx];
  if (gruppi.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return gruppi.map((g) => parseInt(g, 16));
}

/**
 * Vero se l'indirizzo è interno o comunque da non contattare. Normalizza gli IPv6 che contengono
 * un IPv4 (::ffff:, ::a.b.c.d, 64:ff9b::/96, 2002::/16) e controlla l'IPv4 dentro.
 * Un indirizzo che non si riesce a leggere è considerato interno.
 */
export function ipPrivato(ip: string): boolean {
  const pulito = ip.replace(/^\[|\]$/g, "");
  if (isIP(pulito) === 4) return v4Privato(v4aNumero(pulito));
  if (isIP(pulito) !== 6) return true;
  const g = espandiV6(pulito);
  if (!g) return true;
  const v4 = (alto: number, basso: number) => v4Privato(((alto << 16) >>> 0) + basso);
  const zeri = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeri(5) && g[5] === 0xffff) return v4(g[6], g[7]);                 // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeri(6)) return true;                                                // ::, ::1, ::a.b.c.d (IPv4-compatibile, deprecato)
  if (zeri(4) && g[4] === 0xffff && g[5] === 0) return true;               // ::ffff:0:a.b.c.d (traduzione SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).some((x) => x !== 0) || v4(g[6], g[7]); // NAT64 64:ff9b::/96 (il resto, es. 64:ff9b:1::/48, è locale)
  if (g[0] === 0x2002) return v4(g[1], g[2]);                              // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;                          // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;                      // documentazione
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 scarto
  if ((g[0] & 0xfe00) === 0xfc00) return true;                             // fc00::/7 unique-local (anche fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local e site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                             // multicast
  return false;
}

export type RisolviNome = (host: string) => Promise<string[]>;
export const risolviPredefinito: RisolviNome = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

async function indirizziAmmessi(host: string, risolvi: RisolviNome): Promise<string[]> {
  const indirizzi = isIP(host) ? [host] : await risolvi(host);
  if (!indirizzi.length || indirizzi.some(ipPrivato)) throw new Error("Il link del calendario punta a un indirizzo non ammesso.");
  return indirizzi;
}

/** Controlla che l'indirizzo sia https e non punti alla rete interna (tutti gli indirizzi del nome). Lancia un errore leggibile. */
export async function controllaIndirizzo(url: string, risolvi: RisolviNome = risolviPredefinito): Promise<URL> {
  let u: URL;
  try { u = new URL(url.trim().replace(/^webcal:\/\//i, "https://")); } catch { throw new Error("Il link del calendario non è valido."); }
  if (u.protocol !== "https:") throw new Error("Il link del calendario deve iniziare con https:// o webcal://.");
  if (u.username || u.password) throw new Error("Il link non deve contenere nome utente o password.");
  if (u.port && u.port !== "443") throw new Error("Porta non ammessa nel link del calendario.");
  await indirizziAmmessi(u.hostname.replace(/^\[|\]$/g, ""), risolvi);
  return u;
}

type CallbackLookup = (err: NodeJS.ErrnoException | null, indirizzo: string | LookupAddress[], famiglia?: number) => void;

/**
 * Funzione `lookup` per l'agente https: risolve il nome al momento della connessione, ricontrolla
 * TUTTI gli indirizzi e restituisce solo quelli verificati. Così il server si collega esattamente
 * all'indirizzo controllato (niente DNS rebinding tra controllo e scaricamento).
 */
export function creaLookupSicuro(risolvi: RisolviNome = risolviPredefinito) {
  return (host: string, opzioni: { all?: boolean } | number | undefined, cb: CallbackLookup): void => {
    indirizziAmmessi(host, risolvi).then(
      (indirizzi) => {
        if (typeof opzioni === "object" && opzioni?.all) cb(null, indirizzi.map((address) => ({ address, family: isIP(address) })));
        else cb(null, indirizzi[0], isIP(indirizzi[0]));
      },
      (e: Error) => cb(Object.assign(e, { code: "ENOTFOUND" }), ""),
    );
  };
}

const SENZA_CORPO = new Set([101, 204, 205, 304]);

/** GET https senza seguire i reindirizzamenti, collegandosi solo a indirizzi verificati. */
function richiestaSicura(url: URL, risolvi: RisolviNome): Promise<Response> {
  return new Promise((ok, ko) => {
    const req = httpsGet(url, {
      lookup: creaLookupSicuro(risolvi) as never,
      headers: { Accept: "text/calendar", "User-Agent": "Jarvis-calendario" },
      timeout: 12_000,
      signal: AbortSignal.timeout(12_000),
    }, (res) => {
      const intestazioni = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) intestazioni.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const stato = res.statusCode ?? 502;
      const corpo = SENZA_CORPO.has(stato) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      if (!corpo) res.resume();
      ok(new Response(corpo, { status: stato, headers: intestazioni }));
    });
    req.on("timeout", () => req.destroy(new Error("Il calendario non ha risposto in tempo.")));
    req.on("error", (e) => ko(/non ammesso|tempo/.test(e.message) ? e : new Error("Il calendario non è raggiungibile.")));
  });
}

const MAX_REINDIRIZZAMENTI = 3;
const cache = new Map<string, { quando: number; eventi: EventoIcs[] }>();

export async function scaricaCalendario(url: string, opz: { maxEtaMs?: number; fetchFn?: typeof fetch; risolvi?: RisolviNome } = {}): Promise<EventoIcs[]> {
  const maxEta = opz.maxEtaMs ?? 5 * 60_000;
  const c = cache.get(url);
  if (c && Date.now() - c.quando < maxEta) return c.eventi;
  const risolvi = opz.risolvi ?? risolviPredefinito;
  // fetchFn serve solo ai test (servizi finti); in produzione si usa sempre la richiesta sicura.
  const scarica = (u: URL) => (opz.fetchFn
    ? opz.fetchFn(u, { redirect: "manual", signal: AbortSignal.timeout(12_000), headers: { Accept: "text/calendar" } })
    : richiestaSicura(u, risolvi));
  let indirizzo = await controllaIndirizzo(url, risolvi);
  let r = await scarica(indirizzo);
  for (let salti = 0; r.status >= 300 && r.status < 400 && r.headers.get("location"); salti++) {
    if (salti >= MAX_REINDIRIZZAMENTI) throw new Error("Il calendario fa troppi reindirizzamenti.");
    indirizzo = await controllaIndirizzo(new URL(r.headers.get("location")!, indirizzo).toString(), risolvi);
    r = await scarica(indirizzo);
  }
  if (!r.ok) throw new Error(`Il calendario ha risposto ${r.status}.`);
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
