// Briefing mattutino: impegni, cantieri, scadenze, documenti in scadenza, fatture da incassare, meteo.
// Con più aziende collegate, la parte di lavoro è divisa per azienda (ogni frase inizia con il nome).
// Fase 2: mail urgenti per azienda e private (dalle ultime 24 ore) ed eventi dei calendari Apple scelti.
// Fase 3: chat WhatsApp senza risposta e urgenti, per azienda e private (mai il testo dei messaggi).
// Testo costruito SENZA AI (costo zero, nessun rischio di dati inventati).
import type { Db } from "./db.js";
import type { ClientCostructo, BriefingCostructo } from "./costructo.js";
import type { AziendaCollegata } from "./aziende.js";
import { impegniProssimiGiorni, descriviImpegno } from "./agenda.js";
import { leggiImpostazioni } from "./impostazioni.js";
import { meteoCantieri, type MeteoCantiere } from "./meteo.js";
import { scaricaCalendario, occorrenze } from "./calendario.js";
import { inizioGiorno, oraMinuti } from "./tempo.js";
import type { EventoApple } from "./calendarioApple.js";
import { statoChat } from "./whatsapp/archivio.js";

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
  /** Mail urgenti delle caselle di questa azienda (ultime 24 ore). */
  posta?: PostaUrgente;
  /** Chat WhatsApp di questa azienda senza risposta (ultimi 2 giorni) e con messaggi urgenti (ultime 24 ore). */
  whatsapp?: WhatsappDaFare;
}
export interface PostaUrgente { urgenti: number; primo?: string }
export interface WhatsappDaFare { senzaRisposta: number; urgenti: number }
export interface Briefing {
  righe: RigaBriefing[];
  adesso: CosaImportante[];
  oggi: Array<{ ora: string; titolo: string; spazio: "privato" | "lavoro"; azienda?: string }>;
  /** Lavoro dell'unica azienda collegata; null se non c'è Costructo o se le aziende sono più di una (vedi `aziende`). */
  lavoro: BriefingCostructo | null;
  aziende: SezioneAzienda[];
  meteo: MeteoCantiere[];
  avvisi: string[];
  /** Mail urgenti private (ultime 24 ore). */
  postaPrivata?: PostaUrgente;
  /** Chat WhatsApp private senza risposta e urgenti. */
  whatsappPrivato?: WhatsappDaFare;
  /** Contatti WhatsApp di cui Jarvis deve ancora sapere l'azienda. */
  whatsappDaAssegnare?: number;
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
  /** Fase 2: eventi dei calendari Apple scelti (privati o di un'azienda). */
  calendarioApple?: (da: number, a: number) => Promise<{ eventi: EventoApple[]; avvisi: string[] }>;
}

/** Mail urgenti delle ultime 24 ore, per spazio (id dell'azienda o «privato»). */
function postaUrgente(db: Db, ora: number): Map<string, PostaUrgente> {
  const righe = db.prepare("SELECT spazio, oggetto, da_nome, da_indirizzo FROM posta_messaggi WHERE urgente = 1 AND data >= ? ORDER BY data DESC").all(ora - 864e5) as
    Array<{ spazio: string; oggetto: string; da_nome: string; da_indirizzo: string }>;
  const out = new Map<string, PostaUrgente>();
  for (const r of righe) {
    const p = out.get(r.spazio) ?? { urgenti: 0 };
    p.urgenti++;
    p.primo = `${r.oggetto || "(senza oggetto)"} (da ${r.da_nome || r.da_indirizzo})`.slice(0, 120); // l'ultima letta è la più vecchia: la prima arrivata
    out.set(r.spazio, p);
  }
  return out;
}
/** Chat WhatsApp per spazio (id dell'azienda, «privato» o '' se non assegnate): senza risposta e urgenti. */
function whatsappDaFare(db: Db, ora: number): Map<string, WhatsappDaFare> {
  const righe = db.prepare(`SELECT c.id, c.spazio, MAX(CASE WHEN m.urgente = 1 AND m.ricevuto >= ? THEN 1 ELSE 0 END) AS urgente
      FROM wa_contatti c JOIN wa_messaggi m ON m.contatto_id = c.id
      WHERE m.direzione = 'in' AND m.storico = 0 AND m.ricevuto >= ? GROUP BY c.id`).all(ora - 864e5, ora - 2 * 864e5) as Array<{ id: string; spazio: string; urgente: number }>;
  const out = new Map<string, WhatsappDaFare>();
  for (const r of righe) {
    const w = out.get(r.spazio) ?? { senzaRisposta: 0, urgenti: 0 };
    if (statoChat(db, r.id, ora).senzaRisposta) w.senzaRisposta++;
    if (r.urgente) w.urgenti++;
    out.set(r.spazio, w);
  }
  for (const [k, w] of out) if (!w.senzaRisposta && !w.urgenti) out.delete(k);
  return out;
}
const fraseWhatsapp = (w: WhatsappDaFare) => [
  w.senzaRisposta ? plurale(w.senzaRisposta, "chat WhatsApp senza risposta", "chat WhatsApp senza risposta") : "",
  w.urgenti ? `${plurale(w.urgenti, "chat WhatsApp urgente", "chat WhatsApp urgenti")}` : "",
].filter(Boolean).join(", ");

const fraseUrgenti = (p: PostaUrgente) => `${plurale(p.urgenti, "mail urgente", "mail urgenti")}${p.primo ? `, ${p.urgenti === 1 ? "" : "la prima: "}«${p.primo}»` : ""}`;

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
  let eventiApple: EventoApple[] = [];
  if (o.calendarioApple) {
    try {
      const r = await o.calendarioApple(inizio, fine);
      eventiApple = r.eventi;
      avvisi.push(...r.avvisi);
    } catch (e) { avvisi.push(`Calendario Apple: ${(e as Error).message}`); }
  }
  for (const e of eventiApple.filter((x) => x.spazio === "privato")) {
    oggi.push({ ora: e.tuttoIlGiorno ? "" : oraMinuti(e.inizio, o.fuso), titolo: e.titolo, spazio: "privato" });
  }
  const posta = postaUrgente(o.db, ora);
  const whatsapp = whatsappDaFare(o.db, ora);

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
  for (const sez of aziende) {
    avvisi.push(...sez.avvisi);
    const p = posta.get(sez.id);
    if (p) {
      sez.posta = p;
      if (piu && sez.righe[0]) sez.righe[0] = { ...sez.righe[0], testo: `${sez.righe[0].testo.replace(/\.$/, "")}; ${fraseUrgenti(p)}.` };
      else if (piu) sez.righe.push({ testo: `${sez.nome}: ${fraseUrgenti(p)}.` });
      else sez.righe.push({ testo: `Posta di lavoro: ${fraseUrgenti(p)}.` });
    }
    const w = whatsapp.get(sez.id);
    if (w) {
      sez.whatsapp = w;
      if (piu && sez.righe[0]) sez.righe[0] = { ...sez.righe[0], testo: `${sez.righe[0].testo.replace(/\.$/, "")}; ${fraseWhatsapp(w)}.` };
      else if (piu) sez.righe.push({ testo: `${sez.nome}: ${fraseWhatsapp(w)}.` });
      else sez.righe.push({ testo: `WhatsApp di lavoro: ${fraseWhatsapp(w)}.` });
    }
  }
  // Calendari Apple delle aziende: l'evento dice sempre di quale azienda è.
  for (const e of eventiApple.filter((x) => x.spazio !== "privato")) {
    const sez = aziende.find((a) => a.id === e.spazio);
    const nome = sez?.nome ?? "";
    oggi.push({ ora: e.tuttoIlGiorno ? "" : oraMinuti(e.inizio, o.fuso), titolo: piu && nome ? `${nome}: ${e.titolo}` : e.titolo, spazio: "lavoro", ...(nome ? { azienda: nome } : {}) });
  }
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
  // Mail urgenti di caselle di aziende che oggi non hanno una sezione (Costructo non collegato)
  const senzaSezione = [...posta.entries()].filter(([spazio]) => spazio !== "privato" && !aziende.some((a) => a.id === spazio));
  const altre = senzaSezione.reduce((t, [, p]) => t + p.urgenti, 0);
  if (altre) righe.push({ testo: `Posta di lavoro: ${plurale(altre, "mail urgente", "mail urgenti")}.` });
  const postaPrivata = posta.get("privato");
  if (postaPrivata) righe.push({ testo: `Posta privata: ${fraseUrgenti(postaPrivata)}.` });
  // WhatsApp di aziende senza sezione (Costructo non collegato), privato e contatti da assegnare.
  const waAltre = [...whatsapp.entries()].filter(([sp]) => sp && sp !== "privato" && !aziende.some((a) => a.id === sp))
    .reduce((t, [, w]) => ({ senzaRisposta: t.senzaRisposta + w.senzaRisposta, urgenti: t.urgenti + w.urgenti }), { senzaRisposta: 0, urgenti: 0 });
  if (waAltre.senzaRisposta || waAltre.urgenti) righe.push({ testo: `WhatsApp di lavoro: ${fraseWhatsapp(waAltre)}.` });
  const whatsappPrivato = whatsapp.get("privato");
  if (whatsappPrivato) righe.push({ testo: `WhatsApp privato: ${fraseWhatsapp(whatsappPrivato)}.` });
  const whatsappDaAssegnare = (o.db.prepare("SELECT COUNT(*) n FROM wa_domande WHERE stato = 'aperta'").get() as { n: number }).n;
  if (whatsappDaAssegnare) righe.push({ testo: `WhatsApp: ${plurale(whatsappDaAssegnare, "contatto nuovo", "contatti nuovi")} da assegnare a un'azienda o al privato.` });
  const pioggia = meteo.filter((m) => (m.pioggia ?? 0) >= 60);
  if (pioggia.length) righe.push({ testo: `Oggi è probabile pioggia su: ${pioggia.map((m) => m.cantiere).join(", ")}.` });
  if (avvisi.length) righe.push({ testo: "Alcune fonti non hanno risposto: trovi i dettagli sullo schermo." });

  // ---- le 3 cose importanti (con più aziende il testo dice di quale azienda è)
  const adesso: CosaImportante[] = [];
  if (primo) adesso.push({ spazio: primo.spazio, testo: primo.titolo, quando: `alle ${primo.ora}`, ...(primo.azienda ? { azienda: primo.azienda } : {}) });
  const conNome = (sez: SezioneAzienda, t: string) => (piu ? `${sez.nome}: ${t}` : t);
  const lavoroDi = (sez: SezioneAzienda) => (sez.nome ? { azienda: sez.nome } : {});
  // Prima una cosa per azienda (scadenza, poi documento, poi fattura), poi le altre: ogni azienda ha il suo posto.
  if (postaPrivata?.primo) adesso.push({ spazio: "privato", testo: `Mail urgente: ${postaPrivata.primo}` });
  const candidati = aziende.map((sez) => {
    const l: CosaImportante[] = [];
    if (sez.posta?.primo) l.push({ spazio: "lavoro", testo: conNome(sez, `Mail urgente: ${sez.posta.primo}`), ...lavoroDi(sez) });
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
  return {
    righe, adesso: adesso.slice(0, 3), oggi, lavoro: piu ? null : (aziende[0]?.lavoro ?? null), aziende, meteo, avvisi,
    ...(postaPrivata ? { postaPrivata } : {}), ...(whatsappPrivato ? { whatsappPrivato } : {}), ...(whatsappDaAssegnare ? { whatsappDaAssegnare } : {}),
  };
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
  if (privati.length || b.postaPrivata || b.whatsappPrivato) {
    const primo = privati.find((x) => x.ora);
    const frasi = [
      ...(privati.length ? [`Oggi hai ${plurale(privati.length, "impegno personale", "impegni personali")}${primo ? `, il primo alle ${primo.ora}: ${primo.titolo}` : ""}.`] : []),
      ...(b.postaPrivata ? [`Posta privata: ${plurale(b.postaPrivata.urgenti, "mail urgente", "mail urgenti")}.`] : []),
      ...(b.whatsappPrivato ? [`WhatsApp privato: ${fraseWhatsapp(b.whatsappPrivato)}.`] : []),
    ];
    out.push({ titolo: TITOLO_NOTIFICA, testo: frasi.join(" ").slice(0, 180) });
  }
  return out;
}
