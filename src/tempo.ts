// Date e ore nel fuso di Luigi (predefinito Europe/Rome), indipendenti dal fuso del server.

export function scartoFuso(utcMs: number, fuso: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: fuso, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** Ora "da muro" in un fuso → istante UTC (ms). */
export function daOraLocale(a: number, me: number, g: number, h: number, mi: number, fuso: string): number {
  const ipotesi = Date.UTC(a, me, g, h, mi, 0);
  let utc = ipotesi - scartoFuso(ipotesi, fuso);
  utc = ipotesi - scartoFuso(utc, fuso);
  return utc;
}

export interface PartiData { anno: number; mese: number; giorno: number; ora: number; minuto: number; giornoSettimana: number }
export function partiLocali(ms: number, fuso: string): PartiData {
  const d = new Date(ms + scartoFuso(ms, fuso));
  return { anno: d.getUTCFullYear(), mese: d.getUTCMonth(), giorno: d.getUTCDate(), ora: d.getUTCHours(), minuto: d.getUTCMinutes(), giornoSettimana: d.getUTCDay() };
}

/** Mezzanotte di oggi (nel fuso) in ms UTC. */
export function inizioGiorno(ms: number, fuso: string): number {
  const p = partiLocali(ms, fuso);
  return daOraLocale(p.anno, p.mese, p.giorno, 0, 0, fuso);
}

export const oraMinuti = (ms: number, fuso: string) => {
  const p = partiLocali(ms, fuso);
  return `${p.ora}:${String(p.minuto).padStart(2, "0")}`;
};
export const dataIso = (ms: number, fuso: string) => {
  const p = partiLocali(ms, fuso);
  return `${p.anno}-${String(p.mese + 1).padStart(2, "0")}-${String(p.giorno).padStart(2, "0")}`;
};
export const descriviGiorno = (ms: number, fuso: string) =>
  new Date(ms).toLocaleDateString("it-IT", { timeZone: fuso, weekday: "long", day: "numeric", month: "long" });
export const descriviAdesso = (ms: number, fuso: string) =>
  new Date(ms).toLocaleString("it-IT", { timeZone: fuso, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
