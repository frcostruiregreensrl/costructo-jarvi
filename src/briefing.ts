// Briefing mattutino: impegni, cantieri, scadenze, documenti in scadenza, fatture da incassare, meteo.
// Con più aziende collegate, la parte di lavoro è divisa per azienda (ogni frase inizia con il nome).
// Testo costruito SENZA AI (costo zero, nessun rischio di dati inventati).
import type { Db } from "./db.js";
import type { ClientCostructo, BriefingCostructo } from "./costructo.js";
import type { AziendaCollegata } from "./aziende.js";
import { impegniProssimiGiorni, descriviImpegno } from "./agenda.js";
import { leggiImpostazioni } from "./impostazioni.js";
import { meteoCantieri, type MeteoCantiere } from "./meteo.js";
import { scaricaCalendario, occorrenze } from "./calendario.js";
import { inizioGiorno, oraMinuti } from "./tempo.js";

export interface RigaBriefing { testo: string; numero?: { id: string; etichetta: string; valore: number; suffisso?: string } }
export interface CosaImportante { spazio: "privato" | "lavoro"; testo: string; quando?: string; azienda?: string }
/** La parte di lavoro di una azienda. */
export interface SezioneAzienda {
  id: string;
  nome: string;
  lavoro: BriefingCostructo | null;
  /** Frasi di questa azienda (con più aziende iniziano con il nome). */
  righe: RigaBriefing[];
  avvisi: string[];
}
export interface Briefing {
  righe: RigaBriefing[];
  adesso: CosaImportante[];
  oggi: Array<{ ora: string; titolo: string; spazio: "privato" | "lavoro"; azienda?: string }>;
  /** Lavoro dell'unica azienda collegata; null se non c'è Costructo o se le aziende sono più di una (vedi `aziende`). */
  lavoro: BriefingCostructo | null;
  aziende: SezioneAzienda[];
  meteo: MeteoCantiere[];
  avvisi: string[];
}

const plurale = (n: number, uno: string, tanti: string) => `${n} ${n === 1 ? uno : tanti}`;
const euro = (n: number) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export interface OpzioniBriefing {
  db: Db;
  fuso: string;
  /** Le aziende collegate (una per token). */
  aziende?: AziendaCollegata[];
  /** Compatibilità: una sola azienda senza nome. Ignorato se ci sono `aziende`. */
  costructo?: ClientCostructo | null;
  linkCalendario: string;
  fetchFn?: typeof fetch;
  ora?: number;
}

/** Frasi del lavoro di una azienda. Con più aziende una sola frase che inizia con il nome. */
function righeLavoro(lavoro: BriefingCostructo, nome: string, id: string, piu: boolean): RigaBriefing[] {
  const cantieri = lavoro.cantieri ?? [], scadenze = lavoro.scadenze ?? [], documenti = lavoro.documentiInScadenza ?? [], fatture = lavoro.fattureDaIncassare ?? [];
  const totale = fatture.reduce((t, f) => t + (f.residuo ?? f.importo ?? 0), 0);
  const primaScadenza = scadenze[0]?.titolo || scadenze[0]?.descrizione;
  const primoDocumento = documenti[0]?.titolo || documenti[0]?.nome;
  if (!piu) {
    const righe: RigaBriefing[] = [];
    if (cantieri.length) righe.push({ testo: `Cantieri aperti: ${cantieri.length}.`, numero: { id: "cantieri", etichetta: "CANTIERI", valore: cantieri.length } });
    if (scadenze.length) righe.push({ testo: `Hai ${plurale(scadenze.length, "scadenza", "scadenze")} in arrivo${primaScadenza ? `, la prima: ${primaScadenza}` : ""}.` });
    if (documenti.length) righe.push({ testo: `${plurale(documenti.length, "documento sta", "documenti stanno")} per scadere${primoDocumento ? `, per esempio ${primoDocumento}` : ""}.` });
    if (fatture.length) righe.push({ testo: `Fatture da incassare: ${fatture.length}${totale ? `, per ${euro(totale)}` : ""}.`, numero: { id: "fatture", etichetta: "DA INCASSARE", valore: Math.round(totale), suffisso: " €" } });
    return righe;
  }
  const pezzi: string[] = [];
  if (cantieri.length) pezzi.push(plurale(cantieri.length, "cantiere aperto", "cantieri aperti"));
  if (scadenze.length) pezzi.push(`${plurale(scadenze.length, "scadenza", "scadenze")} in arrivo${primaScadenza ? ` (la prima: ${primaScadenza})` : ""}`);
  if (documenti.length) pezzi.push(`${plurale(documenti.length, "documento", "documenti")} in scadenza${primoDocumento ? ` (per esempio ${primoDocumento})` : ""}`);
  if (fatture.length) pezzi.push(`${plurale(fatture.length, "fattura", "fatture")} da incassare${totale ? ` per ${euro(totale)}` : ""}`);
  return [{
    testo: pezzi.length ? `${nome}: ${pezzi.join(", ")}.` : `${nome}: niente di nuovo da Costructo.`,
    ...(cantieri.length ? { numero: { id: `cantieri-${id}`, etichetta: `CANTIERI ${nome.toUpperCase().slice(0, 16)}`, valore: cantieri.length } } : {}),
  }];
}

export async function creaBriefing(o: OpzioniBriefing): Promise<Briefing> {
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

  // ---- lavoro: ogni azienda per conto suo; l'errore di una non ferma le altre
  const elenco: AziendaCollegata[] = (o.aziende ?? (o.costructo ? [{ id: "principale", nome: "", client: o.costructo }] : [])).filter((a) => a.client.configurato);
  const piu = elenco.length > 1;
  const etichetta = (nome: string) => (piu && nome ? nome : "Costructo");
  const aziende: SezioneAzienda[] = await Promise.all(elenco.map(async (a) => {
    const sez: SezioneAzienda = { id: a.id, nome: a.nome, lavoro: null, righe: [], avvisi: [] };
    try { sez.lavoro = (await a.client.briefing()).dati; } catch (e) { sez.avvisi.push(`${etichetta(a.nome)}: ${(e as Error).message}`); }
    sez.righe = sez.lavoro ? righeLavoro(sez.lavoro, a.nome, a.id, piu) : piu ? [{ testo: `${a.nome}: Costructo non ha risposto.` }] : [];
    return sez;
  }));
  for (const sez of aziende) avvisi.push(...sez.avvisi);
  for (const sez of aziende) {
    for (const i of sez.lavoro?.impegni ?? []) {
      const t = i.inizio ? Date.parse(i.inizio) : NaN;
      const titolo = i.titolo || "Impegno di lavoro";
      oggi.push({ ora: Number.isFinite(t) ? oraMinuti(t, o.fuso) : "", titolo: piu ? `${sez.nome}: ${titolo}` : titolo, spazio: "lavoro", ...(sez.nome ? { azienda: sez.nome } : {}) });
    }
  }
  oggi.sort((a, b) => (a.ora || "00:00").padStart(5, "0").localeCompare((b.ora || "00:00").padStart(5, "0")));

  let meteo: MeteoCantiere[] = [];
  const cantieri = aziende.flatMap((sez) => (sez.lavoro?.cantieri ?? []).map((c) => (piu && c.nome ? { ...c, nome: `${c.nome} (${sez.nome})` } : c)));
  if (imp.meteoCantieri && cantieri.length) meteo = await meteoCantieri(cantieri, o.fuso, o.fetchFn);

  // ---- frasi
  const righe: RigaBriefing[] = [{ testo: `Buongiorno ${s}, tutti i sistemi sono attivi.` }];
  const primo = oggi.find((x) => x.ora);
  righe.push({
    testo: oggi.length ? `Oggi hai ${plurale(oggi.length, "impegno", "impegni")}${primo ? `, il primo alle ${primo.ora}: ${primo.titolo}` : ""}.` : "Oggi l'agenda è libera.",
    numero: { id: "agenda", etichetta: "IMPEGNI OGGI", valore: oggi.length },
  });
  for (const sez of aziende) righe.push(...sez.righe);
  const pioggia = meteo.filter((m) => (m.pioggia ?? 0) >= 60);
  if (pioggia.length) righe.push({ testo: `Oggi è probabile pioggia su: ${pioggia.map((m) => m.cantiere).join(", ")}.` });
  if (avvisi.length) righe.push({ testo: "Alcune fonti non hanno risposto: trovi i dettagli sullo schermo." });

  // ---- le 3 cose importanti (con più aziende il testo dice di quale azienda è)
  const adesso: CosaImportante[] = [];
  if (primo) adesso.push({ spazio: primo.spazio, testo: primo.titolo, quando: `alle ${primo.ora}`, ...(primo.azienda ? { azienda: primo.azienda } : {}) });
  const conNome = (sez: SezioneAzienda, t: string) => (piu ? `${sez.nome}: ${t}` : t);
  const lavoroDi = (sez: SezioneAzienda) => (sez.nome ? { azienda: sez.nome } : {});
  // Prima una cosa per azienda (scadenza, poi documento, poi fattura), poi le altre: ogni azienda ha il suo posto.
  const candidati = aziende.map((sez) => {
    const l: CosaImportante[] = [];
    const sc = sez.lavoro?.scadenze?.[0], d = sez.lavoro?.documentiInScadenza?.[0], f = sez.lavoro?.fattureDaIncassare?.[0];
    if (sc) l.push({ spazio: "lavoro", testo: conNome(sez, sc.titolo || sc.descrizione || "Scadenza"), quando: sc.scadenza || sc.data, ...lavoroDi(sez) });
    if (d) l.push({ spazio: "lavoro", testo: conNome(sez, `Documento: ${d.titolo || d.nome || "in scadenza"}`), quando: d.scadenza, ...lavoroDi(sez) });
    if (f) l.push({ spazio: "lavoro", testo: conNome(sez, `Da incassare: ${f.cliente || f.numero || "fattura"}`), quando: f.scadenza, ...lavoroDi(sez) });
    return l;
  });
  for (let giro = 0; giro < 3; giro++) for (const l of candidati) if (l[giro]) adesso.push(l[giro]);
  if (adesso.length < 3) {
    const prossimi = impegniProssimiGiorni(o.db, 7, o.fuso, ora).filter((i) => i.inizio >= fine).slice(0, 3 - adesso.length);
    for (const i of prossimi) adesso.push({ spazio: "privato", testo: descriviImpegno(i, o.fuso) });
  }
  return { righe, adesso: adesso.slice(0, 3), oggi, lavoro: piu ? null : (aziende[0]?.lavoro ?? null), aziende, meteo, avvisi };
}

/** Testo breve per la notifica del mattino (una sola azienda o nessuna). */
export function testoNotifica(b: Briefing): string {
  return b.righe.slice(1, 4).map((r) => r.testo).join(" ").slice(0, 180) || "Il briefing di oggi è pronto.";
}

export interface Notifica { titolo: string; testo: string }
export const TITOLO_NOTIFICA = "Buongiorno da Jarvis";

/**
 * Notifiche del mattino. Con una sola azienda (o nessuna): una notifica, come sempre.
 * Con più aziende: una notifica per azienda (titolo e testo iniziano con il nome) e, solo se oggi
 * c'è qualcosa di privato, una in più per la parte privata.
 */
export function notificheDelMattino(b: Briefing): Notifica[] {
  if (b.aziende.length <= 1) return [{ titolo: TITOLO_NOTIFICA, testo: testoNotifica(b) }];
  const out: Notifica[] = b.aziende.map((sez) => {
    const impegni = b.oggi.filter((x) => x.spazio === "lavoro" && x.azienda === sez.nome).length;
    // Se Costructo non ha risposto per questa azienda, la notifica lo dice (l'avviso inizia già con il nome).
    const frasi = sez.lavoro
      ? [...sez.righe.map((r) => r.testo), ...(impegni ? [`Impegni di lavoro oggi: ${impegni}.`] : [])]
      : sez.avvisi.length ? sez.avvisi : sez.righe.map((r) => r.testo);
    const testo = frasi.join(" ").trim() || `${sez.nome}: niente di nuovo da Costructo.`;
    return { titolo: `${sez.nome} · ${TITOLO_NOTIFICA}`.slice(0, 80), testo: (testo.startsWith(sez.nome) ? testo : `${sez.nome}: ${testo}`).slice(0, 180) };
  });
  const privati = b.oggi.filter((x) => x.spazio === "privato");
  if (privati.length) {
    const primo = privati.find((x) => x.ora);
    out.push({ titolo: TITOLO_NOTIFICA, testo: `Oggi hai ${plurale(privati.length, "impegno personale", "impegni personali")}${primo ? `, il primo alle ${primo.ora}: ${primo.titolo}` : ""}.`.slice(0, 180) });
  }
  return out;
}
