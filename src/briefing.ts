// Briefing mattutino: impegni, cantieri, scadenze, documenti in scadenza, fatture da incassare, meteo.
// Testo costruito SENZA AI (costo zero, nessun rischio di dati inventati).
import type { Db } from "./db.js";
import type { ClientCostructo, BriefingCostructo } from "./costructo.js";
import { impegniProssimiGiorni, descriviImpegno } from "./agenda.js";
import { leggiImpostazioni } from "./impostazioni.js";
import { meteoCantieri, type MeteoCantiere } from "./meteo.js";
import { scaricaCalendario, occorrenze } from "./calendario.js";
import { inizioGiorno, oraMinuti } from "./tempo.js";

export interface RigaBriefing { testo: string; numero?: { id: string; etichetta: string; valore: number; suffisso?: string } }
export interface CosaImportante { spazio: "privato" | "lavoro"; testo: string; quando?: string }
export interface Briefing {
  righe: RigaBriefing[];
  adesso: CosaImportante[];
  oggi: Array<{ ora: string; titolo: string; spazio: "privato" | "lavoro" }>;
  lavoro: BriefingCostructo | null;
  meteo: MeteoCantiere[];
  avvisi: string[];
}

const plurale = (n: number, uno: string, tanti: string) => `${n} ${n === 1 ? uno : tanti}`;
const euro = (n: number) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export async function creaBriefing(o: { db: Db; fuso: string; costructo: ClientCostructo | null; linkCalendario: string; fetchFn?: typeof fetch; ora?: number }): Promise<Briefing> {
  const ora = o.ora ?? Date.now();
  const imp = leggiImpostazioni(o.db);
  const s = imp.comeChiamarmi;
  const avvisi: string[] = [];
  const inizio = inizioGiorno(ora, o.fuso), fine = inizio + 864e5;

  const oggi: Briefing["oggi"] = impegniProssimiGiorni(o.db, 1, o.fuso, ora)
    .map((i) => ({ ora: i.tutto_il_giorno ? "" : oraMinuti(i.inizio, o.fuso), titolo: i.titolo, spazio: "privato" as const }));
  if (o.linkCalendario) {
    try {
      const ev = occorrenze(await scaricaCalendario(o.linkCalendario, { fetchFn: o.fetchFn }), inizio, fine, o.fuso);
      for (const e of ev) oggi.push({ ora: e.tuttoIlGiorno ? "" : oraMinuti(e.inizio, o.fuso), titolo: e.titolo, spazio: "privato" });
    } catch (e) { avvisi.push(`Calendario: ${(e as Error).message}`); }
  }

  let lavoro: BriefingCostructo | null = null;
  if (o.costructo?.configurato) {
    try { lavoro = (await o.costructo.briefing()).dati; } catch (e) { avvisi.push(`Costructo: ${(e as Error).message}`); }
  }
  for (const i of lavoro?.impegni ?? []) {
    const t = i.inizio ? Date.parse(i.inizio) : NaN;
    oggi.push({ ora: Number.isFinite(t) ? oraMinuti(t, o.fuso) : "", titolo: i.titolo || "Impegno di lavoro", spazio: "lavoro" });
  }
  oggi.sort((a, b) => (a.ora || "00:00").padStart(5, "0").localeCompare((b.ora || "00:00").padStart(5, "0")));

  let meteo: MeteoCantiere[] = [];
  if (imp.meteoCantieri && lavoro?.cantieri?.length) meteo = await meteoCantieri(lavoro.cantieri, o.fuso, o.fetchFn);

  // ---- frasi
  const righe: RigaBriefing[] = [{ testo: `Buongiorno ${s}, tutti i sistemi sono attivi.` }];
  const primo = oggi.find((x) => x.ora);
  righe.push({
    testo: oggi.length ? `Oggi hai ${plurale(oggi.length, "impegno", "impegni")}${primo ? `, il primo alle ${primo.ora}: ${primo.titolo}` : ""}.` : "Oggi l'agenda è libera.",
    numero: { id: "agenda", etichetta: "IMPEGNI OGGI", valore: oggi.length },
  });
  const cantieri = lavoro?.cantieri ?? [];
  if (cantieri.length) righe.push({ testo: `Cantieri aperti: ${cantieri.length}.`, numero: { id: "cantieri", etichetta: "CANTIERI", valore: cantieri.length } });
  const scadenze = lavoro?.scadenze ?? [];
  if (scadenze.length) righe.push({ testo: `Hai ${plurale(scadenze.length, "scadenza", "scadenze")} in arrivo${scadenze[0].titolo || scadenze[0].descrizione ? `, la prima: ${scadenze[0].titolo || scadenze[0].descrizione}` : ""}.` });
  const documenti = lavoro?.documentiInScadenza ?? [];
  if (documenti.length) righe.push({ testo: `${plurale(documenti.length, "documento sta", "documenti stanno")} per scadere${documenti[0].titolo || documenti[0].nome ? `, per esempio ${documenti[0].titolo || documenti[0].nome}` : ""}.` });
  const fatture = lavoro?.fattureDaIncassare ?? [];
  if (fatture.length) {
    const totale = fatture.reduce((t, f) => t + (f.residuo ?? f.importo ?? 0), 0);
    righe.push({ testo: `Fatture da incassare: ${fatture.length}${totale ? `, per ${euro(totale)}` : ""}.`, numero: { id: "fatture", etichetta: "DA INCASSARE", valore: Math.round(totale), suffisso: " €" } });
  }
  const pioggia = meteo.filter((m) => (m.pioggia ?? 0) >= 60);
  if (pioggia.length) righe.push({ testo: `Oggi è probabile pioggia su: ${pioggia.map((m) => m.cantiere).join(", ")}.` });
  if (avvisi.length) righe.push({ testo: "Alcune fonti non hanno risposto: trovi i dettagli sullo schermo." });

  // ---- le 3 cose importanti
  const adesso: CosaImportante[] = [];
  if (primo) adesso.push({ spazio: primo.spazio, testo: primo.titolo, quando: `alle ${primo.ora}` });
  if (scadenze[0]) adesso.push({ spazio: "lavoro", testo: scadenze[0].titolo || scadenze[0].descrizione || "Scadenza", quando: scadenze[0].scadenza || scadenze[0].data });
  if (documenti[0]) adesso.push({ spazio: "lavoro", testo: `Documento: ${documenti[0].titolo || documenti[0].nome || "in scadenza"}`, quando: documenti[0].scadenza });
  if (fatture[0] && adesso.length < 3) adesso.push({ spazio: "lavoro", testo: `Da incassare: ${fatture[0].cliente || fatture[0].numero || "fattura"}`, quando: fatture[0].scadenza });
  if (adesso.length < 3) {
    const prossimi = impegniProssimiGiorni(o.db, 7, o.fuso, ora).filter((i) => i.inizio >= fine).slice(0, 3 - adesso.length);
    for (const i of prossimi) adesso.push({ spazio: "privato", testo: descriviImpegno(i, o.fuso) });
  }
  return { righe, adesso: adesso.slice(0, 3), oggi, lavoro, meteo, avvisi };
}

/** Testo breve per la notifica del mattino. */
export function testoNotifica(b: Briefing): string {
  return b.righe.slice(1, 4).map((r) => r.testo).join(" ").slice(0, 180) || "Il briefing di oggi è pronto.";
}
