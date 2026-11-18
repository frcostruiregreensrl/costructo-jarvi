// Date e ore scritte in italiano nei messaggi («domani alle 10», «giovedì», «12/03», «3 maggio»), senza AI.
// Sempre nel fuso di Luigi. Nel dubbio: niente (meglio chiedere che indovinare).
import { daOraLocale, dataIso, partiLocali } from "../tempo.js";

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const GIORNI = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];

export const normalizza = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Giorno (AAAA-MM-GG) a `n` giorni da oggi, nel fuso. */
export function giornoDa(ora: number, n: number, fuso: string): string {
  const p = partiLocali(ora, fuso);
  return dataIso(daOraLocale(p.anno, p.mese, p.giorno + n, 12, 0, fuso), fuso);
}

function valida(a: number, m: number, g: number): string | null {
  const d = new Date(Date.UTC(a, m, g));
  if (d.getUTCMonth() !== m || d.getUTCDate() !== g || a < 2000 || a > 2100) return null;
  return `${a}-${String(m + 1).padStart(2, "0")}-${String(g).padStart(2, "0")}`;
}

/**
 * La data detta nel testo. `futuro`: senza anno, una data già passata va all'anno dopo (appuntamenti, compleanni);
 * altrimenti resta quest'anno (ore lavorate, documenti).
 */
export function leggiData(testo: string, ora: number, fuso: string, futuro = true): string | null {
  const t = normalizza(testo);
  const oggi = partiLocali(ora, fuso);
  // 12/03, 12/03/2027, 12-3-27, 12.03.2027
  // (con il punto solo se c'è anche l'anno: «8.5 ore» non è l'8 maggio)
  const num = /\b([0-3]?\d)[/\-]([01]?\d)(?:[/\-](\d{2,4}))?\b/.exec(t) ?? /\b([0-3]?\d)\.([01]?\d)\.(\d{2,4})\b/.exec(t);
  if (num) {
    const g = +num[1], m = +num[2] - 1;
    let a = num[3] ? +num[3] : oggi.anno;
    if (a < 100) a += 2000;
    let d = valida(a, m, g);
    if (d && !num[3] && futuro && d < dataIso(ora, fuso)) d = valida(a + 1, m, g);
    if (d) return d;
  }
  // 3 maggio, 3 maggio 2027
  const parole = new RegExp(`\\b([0-3]?\\d)\\s+(${MESI.join("|")})(?:\\s+(\\d{4}))?\\b`).exec(t);
  if (parole) {
    const g = +parole[1], m = MESI.indexOf(parole[2]);
    let d = valida(parole[3] ? +parole[3] : oggi.anno, m, g);
    if (d && !parole[3] && futuro && d < dataIso(ora, fuso)) d = valida(oggi.anno + 1, m, g);
    if (d) return d;
  }
  if (/\bdopodomani\b/.test(t)) return giornoDa(ora, 2, fuso);
  if (/\bdomani\b/.test(t)) return giornoDa(ora, 1, fuso);
  if (/\bieri\b/.test(t)) return giornoDa(ora, -1, fuso);
  if (/\b(oggi|stasera|stamattina|stamani|stanotte|in giornata|oggi pomeriggio)\b/.test(t)) return giornoDa(ora, 0, fuso);
  const gs = new RegExp(`\\b(${GIORNI.join("|")})\\b`).exec(t);
  if (gs) {
    const voluto = GIORNI.indexOf(gs[1]);
    let n = (voluto - oggi.giornoSettimana + 7) % 7;
    if (n === 0) n = futuro ? 7 : 0;
    if (!futuro && n > 0) n -= 7; // «lunedì ho fatto 8 ore» = il lunedì passato
    return giornoDa(ora, n, fuso);
  }
  return null;
}

/** L'ora detta nel testo: «alle 10», «alle 10:30», «ore 15.15», «h 9». */
export function leggiOra(testo: string): string | null {
  const m = /\b(?:alle|all'|ore|h)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b/i.exec(testo);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
}

/** Fine del giorno (23:59) di una data AAAA-MM-GG, in ms. */
export function fineGiorno(data: string, fuso: string): number {
  const [a, m, g] = data.split("-").map(Number);
  return daOraLocale(a, m - 1, g, 23, 59, fuso);
}

/** Inizio del giorno di una data AAAA-MM-GG, in ms. */
export function inizioData(data: string, fuso: string): number {
  const [a, m, g] = data.split("-").map(Number);
  return daOraLocale(a, m - 1, g, 0, 0, fuso);
}

/** Data AAAA-MM-GG in forma breve italiana (18/11/2026). */
export const dataBreve = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d);

/** Distanza in metri tra due punti (formula dell'emisenoverso). */
export function distanzaMetri(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6_371_000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
