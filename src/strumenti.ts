// Strumenti che l'AI può usare (Fasi 1, 2 e 3). Ogni chiamata: validazione (zod) → controllo → permesso → esecuzione → registro.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.js";
import type { DefinizioneStrumento } from "./cervello/tipi.js";
import type { ClientCostructo } from "./costructo.js";
import { ErroreCostructo } from "./costructo.js";
import { trovaAziende, nomiAziende, type AziendaCollegata } from "./aziende.js";
import { marcaDati } from "./dati.js";
import { aggiungiImpegno, cancellaImpegno, cercaImpegni, descriviImpegno, impegniProssimiGiorni, type Impegno } from "./agenda.js";
import { aggiungiMemoria, elencaMemorie, type Spazio, type Vista } from "./memorie.js";
import { controllaPermesso, SCRITTURE, type Azione } from "./permessi.js";
import { registra } from "./registro.js";
import { scaricaCalendario, occorrenze } from "./calendario.js";
import type { EventoApple } from "./calendarioApple.js";
import { inizioGiorno, oraMinuti, descriviGiorno } from "./tempo.js";
import type { DipendenzePosta } from "./posta/tipi.js";
import { elencoPerAi, leggiPerAi, mailPerBozza, type ContestoPosta } from "./posta/strumentiPosta.js";
import { creaBozza, oggettoRisposta, destinatarioRisposta, MAX_TESTO_BOZZA } from "./posta/bozze.js";
import { nomeSpazio } from "./posta/caselle.js";
import type { DipendenzeWhatsapp } from "./whatsapp/tipi.js";
import { PRIVATO as PRIVATO_WA } from "./whatsapp/tipi.js";
import { elencoPerAi as elencoWa, chatPerAi, trovaContattoPerAi, type ContestoWa } from "./whatsapp/strumentiWhatsapp.js";
import { leggiContatto, nomeContatto, nomeSpazio as nomeSpazioWa, statoChat } from "./whatsapp/archivio.js";
import { fuoriFinestra, preparaRisposta, inviaRisposta } from "./whatsapp/risposte.js";
import { rispondiDomanda } from "./whatsapp/attribuzione.js";
import { MAX_TESTO_RISPOSTA, MAX_TESTO_CONFERMA } from "./whatsapp/tipi.js";
import { pulisciTestoConfermato, improntaConferma, stessaImpronta, DA_COMPLETARE } from "./sicurezza/testoConfermato.js";

/** Testo di una bozza email proposta dall'AI: al massimo questo, così sta TUTTO nella domanda di conferma. */
export const MAX_TESTO_BOZZA_CONFERMA = 2000;
/** Non esegue mai da solo: queste azioni partono solo da rispondiConferma, dopo il sì di Luigi. */
const SOLO_DOPO_CONFERMA = "Non fatto: questa azione parte solo dalla conferma di Luigi.";

export type EventoFlusso =
  | { tipo: "delta"; testo: string }
  | { tipo: "modello"; modello: string }
  | { tipo: "strumento"; nome: string }
  | { tipo: "agenda" }
  | { tipo: "memoria"; spazio: Spazio; testo: string }
  | { tipo: "numero"; etichetta: string; valore: number; suffisso: string }
  | { tipo: "conferma"; id: string; domanda: string; opzioni: Array<{ indice: number; testo: string }> }
  | { tipo: "avviso"; testo: string }
  /** Il testo detto finora in questo turno va sostituito con `testo` (es. rifiuto a metà risposta). */
  | { tipo: "scarta"; testo: string }
  | { tipo: "fine"; conversazione: string; costoUsd: number };

export interface ContestoStrumenti {
  db: Db;
  fuso: string;
  vista: Vista;
  messaggioLuigi: string;
  conversazione: string;
  /** Una sola azienda (compatibilità). Se ci sono `aziende`, vale quell'elenco. */
  costructo?: ClientCostructo | null;
  /** Le aziende collegate a Costructo, ognuna con il suo token. */
  aziende?: AziendaCollegata[];
  linkCalendario: () => string;
  emetti: (e: EventoFlusso) => void;
  fetchFn?: typeof fetch;
  /** Scritture già fatte in questo turno, per tipo di azione (una sola cancellazione senza conferma). */
  scritture?: Map<string, number>;
  /** Fase 2: posta (caselle, archivio, bozze). Assente = nessuna casella. */
  posta?: DipendenzePosta;
  /** Fase 2: eventi dei calendari Apple scelti (con lo spazio: privato o id dell'azienda). */
  calendarioApple?: (da: number, a: number) => Promise<{ eventi: EventoApple[]; avvisi: string[] }>;
  /** Fase 3: WhatsApp (assente = non disponibile). */
  whatsapp?: DipendenzeWhatsapp;
}

const oggetto = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const giorni = { type: "integer", description: "Quanti giorni guardare in avanti (1-30)" };

interface Strumento<S extends z.ZodTypeAny> {
  def: DefinizioneStrumento;
  azione: Azione;
  viste: Vista[];
  input: S;
  spazio?: (i: z.infer<S>) => Spazio | undefined;
  /** Oggetto della scrittura (titolo o testo), da ritrovare nel messaggio di Luigi. */
  oggetto?: (i: z.infer<S>) => string;
  /** Controllo prima del permesso (es. la mail esiste ed è visibile): un testo = errore da dare all'AI. */
  verifica?: (i: z.infer<S>, c: ContestoStrumenti) => string | null;
  /** Cosa scrivere nel registro al posto dell'input (per non salvare testi delle mail o delle bozze). */
  perRegistro?: (i: z.infer<S>) => Record<string, unknown>;
  /** Dati in più da ricordare nella richiesta di conferma (es. l'id del contatto trovato nella scheda aperta). */
  datiConferma?: (i: z.infer<S>, c: ContestoStrumenti) => Record<string, unknown>;
  esegui: (i: z.infer<S>, c: ContestoStrumenti) => Promise<string> | string;
}
function strumento<S extends z.ZodTypeAny>(s: Strumento<S>): Strumento<S> { return s; }

/** Le aziende disponibili in questo turno. */
export function aziendeDelContesto(c: Pick<ContestoStrumenti, "aziende" | "costructo">): AziendaCollegata[] {
  if (c.aziende) return c.aziende.filter((a) => a.client.configurato);
  return c.costructo?.configurato ? [{ id: "principale", nome: "", client: c.costructo }] : [];
}

/** Parametro facoltativo di tutti gli strumenti costructo_* (stringa vuota = non detto). */
const azienda = { type: "string", description: "Nome dell'azienda di cui parla Luigi, come lo dice lui. Stringa vuota se non l'ha detto o se vuole tutte le aziende." };
const campoAzienda = z.string().max(80).optional();

type Lettura = (cl: ClientCostructo) => Promise<{ percorso: string; dati: unknown }>;

/**
 * Errore di lettura con i dettagli (nomi delle aziende, messaggi) da dare all'AI come DATI:
 * il messaggio resta generico, i nomi vanno tra i delimitatori.
 */
export class ErroreConDati extends Error {
  constructor(messaggio: string, readonly dati: unknown) { super(messaggio); }
}

/**
 * Legge Costructo per una o più aziende. I nomi delle aziende (che arrivano da Costructo) e quello
 * detto da Luigi stanno sempre dentro i delimitatori dei dati.
 * - una sola azienda collegata: si usa quella (se il nome detto non corrisponde, una nota lo dice);
 * - più aziende e `richiesta` detta: si cerca per nome o id; se non è chiaro, l'AI deve chiedere a Luigi;
 * - più aziende e niente `richiesta`: si leggono tutte (se `tutte`), ogni dato con il nome della sua azienda;
 *   l'errore di un'azienda non nasconde i dati delle altre.
 */
async function daCostructo(c: ContestoStrumenti, richiesta: string | undefined, f: Lettura, tutte = true): Promise<string> {
  const aziende = aziendeDelContesto(c);
  if (!aziende.length) return "Costructo non è ancora collegato: dillo a Luigi in una frase.";
  const r = (richiesta ?? "").trim().slice(0, 80);
  const chiedi = (motivo: string) =>
    `${motivo} Non ho letto niente: chiedi a Luigi di quale azienda parla, usando la domanda suggerita qui sotto (i nomi sono dati).\n` +
    marcaDati("aziende", { nomeChiesto: r || null, aziendeCollegate: aziende.map((a) => a.nome), domandaSuggerita: `Di quale azienda parli: ${nomiAziende(aziende)}?` });
  let scelte = aziende;
  let nota: string | undefined;
  if (aziende.length > 1) {
    if (r) {
      scelte = trovaAziende(aziende, r);
      if (!scelte.length) return chiedi("Nessuna azienda collegata corrisponde al nome chiesto.");
      if (scelte.length > 1) return chiedi("Il nome chiesto può essere più di un'azienda.");
    } else if (!tutte) {
      return chiedi("Non è chiaro di quale azienda parla Luigi.");
    }
  } else if (r && aziende[0].nome && !trovaAziende(aziende, r).length) {
    nota = `Nessuna azienda collegata si chiama «${r}»; questi dati sono di ${aziende[0].nome}.`;
  }
  if (scelte.length === 1) {
    const a = scelte[0];
    try {
      const l = await f(a.client);
      const testo = marcaDati("costructo", { ...(nota ? { nota } : {}), ...(a.nome ? { azienda: a.nome } : {}), percorso: l.percorso, dati: l.dati });
      return nota ? `Attenzione: il nome chiesto non corrisponde all'unica azienda collegata; leggi la nota nei dati e dillo a Luigi.\n${testo}` : testo;
    } catch (e) {
      if (aziende.length > 1 && e instanceof Error) throw new ErroreConDati("l'azienda chiesta non ha risposto (dettagli nei dati).", { azienda: a.nome, errore: e.message });
      throw e;
    }
  }
  const esiti = await Promise.allSettled(scelte.map((a) => f(a.client)));
  const errore = (e: PromiseRejectedResult) => (e.reason as Error)?.message ?? "errore";
  if (esiti.every((e) => e.status === "rejected")) {
    throw new ErroreConDati("nessuna azienda ha risposto (dettagli nei dati).", { aziende: esiti.map((e, i) => ({ azienda: scelte[i].nome, errore: errore(e as PromiseRejectedResult) })) });
  }
  return marcaDati("costructo", {
    nota: "Dati di più aziende: ogni blocco dice di quale azienda è. Di' sempre a quale azienda appartiene ogni informazione e non sommare numeri di aziende diverse senza dirlo.",
    aziende: esiti.map((e, i) => e.status === "fulfilled"
      ? { azienda: scelte[i].nome, percorso: e.value.percorso, dati: e.value.dati }
      : { azienda: scelte[i].nome, errore: errore(e) }),
  });
}

/** Contesto per la posta (null se non ci sono le dipendenze della posta). */
function contestoPosta(c: ContestoStrumenti): ContestoPosta | null {
  if (!c.posta) return null;
  return { db: c.db, cifratore: c.posta.cifratore, fuso: c.fuso, vista: c.vista, aziende: c.posta.aziende() };
}
/** Contesto per WhatsApp (null se non ci sono le dipendenze). */
function contestoWa(c: ContestoStrumenti): ContestoWa | null {
  if (!c.whatsapp) return null;
  return { db: c.db, fuso: c.fuso, vista: c.vista, aziende: c.whatsapp.aziende() };
}
const SENZA_WA = "WhatsApp non è disponibile in questo momento: dillo a Luigi in una frase.";
/** «privato» oppure l'id dell'unica azienda che corrisponde al nome; altrimenti la domanda da fare. */
function spazioDaNome(c: ContestoWa, nome: string): { spazio?: string; domanda?: string } {
  const r = nome.trim();
  if (/^(privat[oa]|personale|vita privata)$/i.test(r)) return { spazio: PRIVATO_WA };
  const t = trovaAziende(c.aziende, r);
  if (t.length === 1) return { spazio: t[0].id };
  return { domanda: `Di quale azienda: ${[...c.aziende.map((a) => a.nome), "privato"].join(", ").replace(/, ([^,]*)$/, " o $1")}?` };
}

const SENZA_POSTA = "Nessuna casella email collegata: dillo a Luigi in una frase (si collegano da Impostazioni → Caselle email).";
const campoTesto = (descrizione: string) => ({ type: "string", description: descrizione });

/** Eventi Apple dei prossimi giorni filtrati per spazio, pronti per l'AI. */
async function eventiAppleDi(c: ContestoStrumenti, giorni: number, filtro: (spazio: string) => boolean) {
  if (!c.calendarioApple) return { eventi: [] as EventoApple[], avvisi: [] as string[] };
  const da = inizioGiorno(Date.now(), c.fuso);
  const r = await c.calendarioApple(da, da + giorni * 864e5);
  return { eventi: r.eventi.filter((e) => filtro(e.spazio)), avvisi: r.avvisi };
}

export const STRUMENTI = [
  strumento({
    def: { nome: "costructo_briefing", descrizione: "Legge da Costructo il quadro di oggi: impegni di lavoro, cantieri, scadenze, documenti in scadenza, fatture da incassare.", schema: oggetto({ azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.briefing()),
  }),
  strumento({
    def: { nome: "costructo_agenda", descrizione: "Legge l'agenda di lavoro di Costructo (impegni, riunioni, sopralluoghi).", schema: oggetto({ giorni, azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ giorni: z.number().int().min(1).max(60), azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.agenda(i.giorni)),
  }),
  strumento({
    def: { nome: "costructo_scadenze", descrizione: "Legge lo scadenzario di Costructo (pagamenti, incassi, adempimenti).", schema: oggetto({ azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.scadenze()),
  }),
  strumento({
    def: { nome: "costructo_documenti_in_scadenza", descrizione: "Legge da Costructo i documenti in scadenza (DURC, visite mediche, attestati, polizze).", schema: oggetto({ azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.documentiInScadenza()),
  }),
  strumento({
    def: { nome: "costructo_cantieri", descrizione: "Elenca i cantieri di Costructo con stato e indirizzo.", schema: oggetto({ azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.cantieri()),
  }),
  strumento({
    def: { nome: "costructo_cerca", descrizione: "Ricerca globale in Costructo (clienti, fornitori, cantieri, preventivi, documenti).", schema: oggetto({ testo: { type: "string", description: "Cosa cercare" }, azienda }) },
    azione: "costructo.leggi", viste: ["lavoro", "tutto"], input: z.object({ testo: z.string().min(1).max(200), azienda: campoAzienda }).strict(),
    esegui: (i, c) => daCostructo(c, i.azienda, (cl) => cl.cerca(i.testo)),
  }),
  strumento({
    def: { nome: "agenda_elenca", descrizione: "Elenca gli impegni dell'agenda privata di Jarvis.", schema: oggetto({ giorni }) },
    azione: "agenda.leggi", viste: ["privato", "tutto"], input: z.object({ giorni: z.number().int().min(1).max(60) }).strict(),
    esegui: (i, c) => {
      const lista = impegniProssimiGiorni(c.db, i.giorni, c.fuso);
      return marcaDati("agenda_jarvis", lista.map((x) => descriviImpegno(x, c.fuso)));
    },
  }),
  strumento({
    def: {
      nome: "agenda_aggiungi",
      descrizione: "Aggiunge un impegno all'agenda privata di Jarvis. Usalo solo se Luigi chiede di segnare, fissare o aggiungere un impegno con giorno (e ora).",
      schema: oggetto({
        titolo: { type: "string", description: "Titolo breve e chiaro" },
        data: { type: "string", description: "Data YYYY-MM-DD" },
        ora: { type: "string", description: "Ora HH:MM (24h), oppure stringa vuota se è per tutto il giorno" },
        minuti: { type: "integer", description: "Durata stimata in minuti (di solito 60)" },
      }),
    },
    azione: "agenda.aggiungi", viste: ["privato", "tutto"], oggetto: (i) => i.titolo,
    input: z.object({ titolo: z.string().min(1).max(140), data: z.string(), ora: z.string().max(5), minuti: z.number().int().min(5).max(1440) }).strict(),
    esegui: (i, c) => {
      const imp = aggiungiImpegno(c.db, i, c.fuso);
      c.emetti({ tipo: "agenda" });
      return `Salvato: ${descriviImpegno(imp, c.fuso)}.`;
    },
  }),
  strumento({
    def: {
      nome: "agenda_cancella",
      descrizione: "Cancella un impegno dell'agenda privata di Jarvis (non quelli di Costructo o del calendario collegato). Se più impegni corrispondono, Jarvis chiede a Luigi quale.",
      schema: oggetto({ titolo: { type: "string", description: "Titolo o parte del titolo dell'impegno" } }),
    },
    azione: "agenda.cancella", viste: ["privato", "tutto"], oggetto: (i) => i.titolo, input: z.object({ titolo: z.string().min(2).max(140) }).strict(),
    esegui: (i, c) => {
      const trovati = cercaImpegni(c.db, i.titolo, c.fuso);
      if (!trovati.length) return "Nessun impegno dell'agenda di Jarvis con quel titolo. Quelli di Costructo o del calendario si cambiano lì.";
      if (trovati.length > 1) {
        const id = creaConferma(c, "agenda.cancella", { ids: trovati.slice(0, 5).map((t) => t.id) });
        c.emetti({
          tipo: "conferma", id, domanda: "Ho trovato più impegni simili. Quale cancello?",
          opzioni: trovati.slice(0, 5).map((t, n) => ({ indice: n, testo: descriviImpegno(t, c.fuso) })),
        });
        registra(c.db, "agenda.cancella", "richiesta_conferma", "jarvis", { cercato: i.titolo, trovati: trovati.length, conferma: id });
        return `Ho trovato ${trovati.length} impegni simili: non ho cancellato niente. Chiedi a Luigi quale, elencandoli brevemente.`;
      }
      cancellaImpegno(c.db, trovati[0].id);
      c.emetti({ tipo: "agenda" });
      return `Cancellato: ${descriviImpegno(trovati[0], c.fuso)}.`;
    },
  }),
  strumento({
    def: {
      nome: "ricordo_salva",
      descrizione: "Salva un ricordo nella memoria di Jarvis, nello spazio privato o lavoro. Usalo quando Luigi chiede di ricordare qualcosa.",
      schema: oggetto({
        testo: { type: "string", description: "Il fatto da ricordare, in terza persona, completo e autonomo" },
        spazio: { type: "string", enum: ["privato", "lavoro"], description: "privato per la vita personale, lavoro per l'impresa" },
      }),
    },
    azione: "memoria.salva", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ testo: z.string().min(2).max(500), spazio: z.enum(["privato", "lavoro"]) }).strict(),
    spazio: (i) => i.spazio,
    oggetto: (i) => i.testo,
    esegui: (i, c) => {
      const m = aggiungiMemoria(c.db, i.spazio, i.testo, "jarvis");
      c.emetti({ tipo: "memoria", spazio: m.spazio, testo: m.testo });
      return `Ricordo salvato nello spazio ${m.spazio}.`;
    },
  }),
  strumento({
    def: { nome: "ricordi_leggi", descrizione: "Rilegge i ricordi salvati di uno spazio.", schema: oggetto({ spazio: { type: "string", enum: ["privato", "lavoro"] } }) },
    azione: "memoria.leggi", viste: ["privato", "lavoro", "tutto"], input: z.object({ spazio: z.enum(["privato", "lavoro"]) }).strict(),
    spazio: (i) => i.spazio,
    esegui: (i, c) => marcaDati("memoria", elencaMemorie(c.db, i.spazio).map((m) => m.testo)),
  }),
  strumento({
    def: {
      nome: "mostra_numero",
      descrizione: "Mostra in grande sullo schermo un numero chiave della risposta. Usalo con parsimonia, solo quando un numero è il cuore della risposta.",
      schema: oggetto({ etichetta: { type: "string", description: "Etichetta breve in MAIUSCOLO" }, valore: { type: "number" }, suffisso: { type: "string", description: "Es. %, €, oppure vuoto" } }),
    },
    azione: "interfaccia.numero", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ etichetta: z.string().max(40), valore: z.number().finite(), suffisso: z.string().max(6) }).strict(),
    esegui: (i, c) => {
      c.emetti({ tipo: "numero", etichetta: i.etichetta.toUpperCase(), valore: i.valore, suffisso: i.suffisso });
      return "Mostrato.";
    },
  }),
  strumento({
    def: { nome: "calendario_leggi", descrizione: "Legge il calendario personale collegato (link iCal, sola lettura).", schema: oggetto({ giorni }) },
    azione: "calendario.leggi", viste: ["privato", "tutto"], input: z.object({ giorni: z.number().int().min(1).max(30) }).strict(),
    esegui: async (i, c) => {
      const link = c.linkCalendario();
      if (!link && !c.calendarioApple) return "Nessun calendario personale collegato.";
      const apple = await eventiAppleDi(c, i.giorni, (spazio) => spazio === "privato");
      const da = inizioGiorno(Date.now(), c.fuso);
      const ev = link ? occorrenze(await scaricaCalendario(link, { fetchFn: c.fetchFn }), da, da + i.giorni * 864e5, c.fuso) : [];
      const tutti = [...ev.map((e) => ({ ...e, calendario: "link iCal" })), ...apple.eventi].sort((x, y) => x.inizio - y.inizio).slice(0, 60);
      return marcaDati("calendario", {
        eventi: tutti.map((e) => ({ giorno: descriviGiorno(e.inizio, c.fuso), ora: e.tuttoIlGiorno ? "tutto il giorno" : oraMinuti(e.inizio, c.fuso), titolo: e.titolo, luogo: e.luogo, calendario: e.calendario })),
        ...(apple.avvisi.length ? { avvisi: apple.avvisi } : {}),
      });
    },
  }),
  strumento({
    def: {
      nome: "calendario_aziende_leggi",
      descrizione: "Legge i calendari Apple che Luigi ha assegnato alle sue aziende (sola lettura). Ogni evento dice di quale azienda è.",
      schema: oggetto({ giorni, azienda }),
    },
    azione: "calendario_aziende.leggi", viste: ["lavoro", "tutto"], input: z.object({ giorni: z.number().int().min(1).max(30), azienda: campoAzienda }).strict(),
    esegui: async (i, c) => {
      if (!c.calendarioApple) return "Nessun calendario Apple collegato.";
      const elenco = c.posta?.aziende() ?? (c.aziende ?? []).map((a) => ({ id: a.id, nome: a.nome }));
      let scelte = elenco;
      if (i.azienda?.trim()) {
        scelte = trovaAziende(elenco, i.azienda);
        if (scelte.length !== 1) return `Non è chiaro di quale azienda parla Luigi: chiediglielo.\n${marcaDati("aziende", { domandaSuggerita: `Di quale azienda parli: ${nomiAziende(elenco)}?` })}`;
      }
      const ids = new Set(scelte.map((a) => a.id));
      const r = await eventiAppleDi(c, i.giorni, (spazio) => ids.has(spazio));
      return marcaDati("calendario", {
        nota: "Di' sempre di quale azienda è ogni evento.",
        eventi: r.eventi.slice(0, 60).map((e) => ({ azienda: nomeSpazio(e.spazio, elenco), calendario: e.calendario, giorno: descriviGiorno(e.inizio, c.fuso), ora: e.tuttoIlGiorno ? "tutto il giorno" : oraMinuti(e.inizio, c.fuso), titolo: e.titolo, luogo: e.luogo })),
        ...(r.avvisi.length ? { avvisi: r.avvisi } : {}),
      });
    },
  }),
  // ------------------------------------------------------------ posta (Fase 2): lettura e bozze, MAI invio
  strumento({
    def: {
      nome: "posta_recenti",
      descrizione: "Elenca le email recenti delle caselle di Luigi con riassunto e urgenza. Ogni mail dice a quale azienda (o al privato) e a quale casella appartiene.",
      schema: oggetto({
        casella: campoTesto("Nome della casella, se Luigi lo dice; altrimenti stringa vuota"),
        azienda: campoTesto("Azienda (o «privato») di cui parla Luigi; stringa vuota per tutte quelle visibili"),
        soloUrgenti: { type: "boolean", description: "true per vedere solo le mail urgenti" },
        giorni: { type: "integer", description: "Quanti giorni indietro guardare (1-30)" },
      }),
    },
    azione: "posta.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ casella: z.string().max(80), azienda: z.string().max(80), soloUrgenti: z.boolean(), giorni: z.number().int().min(1).max(30) }).strict(),
    perRegistro: (i) => ({ soloUrgenti: i.soloUrgenti, giorni: i.giorni }),
    esegui: (i, c) => {
      const p = contestoPosta(c);
      return p ? elencoPerAi(p, { casella: i.casella, azienda: i.azienda, soloUrgenti: i.soloUrgenti, giorni: i.giorni }) : SENZA_POSTA;
    },
  }),
  strumento({
    def: {
      nome: "posta_cerca",
      descrizione: "Cerca tra le email salvate da Jarvis (ultimi 30 giorni) per mittente, oggetto o testo.",
      schema: oggetto({
        testo: campoTesto("Parole da cercare (mittente, oggetto o testo)"),
        azienda: campoTesto("Azienda (o «privato»), se Luigi la dice; altrimenti stringa vuota"),
        giorni: { type: "integer", description: "Quanti giorni indietro guardare (1-30)" },
      }),
    },
    azione: "posta.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ testo: z.string().min(1).max(200), azienda: z.string().max(80), giorni: z.number().int().min(1).max(30) }).strict(),
    perRegistro: (i) => ({ giorni: i.giorni }),
    esegui: (i, c) => {
      const p = contestoPosta(c);
      return p ? elencoPerAi(p, { testo: i.testo, azienda: i.azienda, giorni: i.giorni }) : SENZA_POSTA;
    },
  }),
  strumento({
    def: {
      nome: "posta_leggi",
      descrizione: "Legge una email: per id (dagli elenchi) oppure cercando il mittente. Se il mittente corrisponde a mail di aziende diverse, chiedi a Luigi quale.",
      schema: oggetto({
        id: campoTesto("Id della mail (dagli elenchi), oppure stringa vuota"),
        mittente: campoTesto("Mittente o oggetto detto da Luigi, se non c'è l'id; altrimenti stringa vuota"),
        azienda: campoTesto("Azienda (o «privato»), se Luigi la dice; altrimenti stringa vuota"),
      }),
    },
    azione: "posta.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ id: z.string().max(40), mittente: z.string().max(200), azienda: z.string().max(80) }).strict(),
    perRegistro: (i) => ({ mail: i.id || undefined }),
    esegui: (i, c) => {
      const p = contestoPosta(c);
      return p ? leggiPerAi(p, i) : SENZA_POSTA;
    },
  }),
  strumento({
    def: {
      nome: "posta_bozza",
      descrizione: "Prepara una BOZZA di risposta a una email: la salva in Jarvis e nella cartella Bozze della casella. NON la invia: la manda Luigi dalla sua app di posta. Serve sempre la conferma di Luigi.",
      schema: oggetto({
        id: campoTesto("Id della mail a cui rispondere"),
        testo: campoTesto("Testo della bozza, in italiano, cortese e breve. Niente promesse di pagamenti, importi, date o impegni: dove servono scrivi [da completare]"),
      }),
    },
    azione: "posta.bozza", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ id: z.string().min(1).max(40), testo: z.string().min(1).max(MAX_TESTO_BOZZA) }).strict(),
    verifica: (i, c) => {
      const p = contestoPosta(c);
      if (!p) return SENZA_POSTA;
      const t = pulisciTestoConfermato(i.testo);
      if (!t) return "La bozza è vuota.";
      if (t.length > MAX_TESTO_BOZZA_CONFERMA) return `Bozza troppo lunga: al massimo ${MAX_TESTO_BOZZA_CONFERMA} caratteri, così Luigi la vede tutta prima di confermare. Accorciala.`;
      return mailPerBozza(p, i.id).errore ?? null;
    },
    // La conferma vale solo per questo testo esatto (pulito) e per questa mail.
    datiConferma: (i) => { const testo = pulisciTestoConfermato(i.testo); return { testo, impronta: improntaConferma(`mail:${i.id}`, testo) }; },
    perRegistro: (i) => ({ mail: i.id }),
    esegui: () => { throw new Error(SOLO_DOPO_CONFERMA); },
  }),
  // ------------------------------------------------------------ WhatsApp (Fase 3): lettura e risposte, che partono SOLO dopo il sì di Luigi
  strumento({
    def: {
      nome: "whatsapp_recenti",
      descrizione: "Elenca le chat WhatsApp recenti di Luigi con riassunto, urgenza e se aspettano una risposta. Ogni chat dice a quale azienda (o al privato) appartiene.",
      schema: oggetto({
        contatto: campoTesto("Nome del contatto, se Luigi lo dice; altrimenti stringa vuota"),
        azienda: campoTesto("Azienda (o «privato») di cui parla Luigi; stringa vuota per tutte quelle visibili"),
        soloUrgenti: { type: "boolean", description: "true per vedere solo le chat con messaggi urgenti" },
        giorni: { type: "integer", description: "Quanti giorni indietro guardare (1-30)" },
      }),
    },
    azione: "whatsapp.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ contatto: z.string().max(80), azienda: z.string().max(80), soloUrgenti: z.boolean(), giorni: z.number().int().min(1).max(30) }).strict(),
    perRegistro: (i) => ({ soloUrgenti: i.soloUrgenti, giorni: i.giorni }),
    esegui: (i, c) => {
      const w = contestoWa(c);
      return w ? elencoWa(w, { contatto: i.contatto, azienda: i.azienda, soloUrgenti: i.soloUrgenti, giorni: i.giorni }) : SENZA_WA;
    },
  }),
  strumento({
    def: {
      nome: "whatsapp_cerca",
      descrizione: "Cerca nei messaggi WhatsApp salvati da Jarvis (ultimi 30 giorni) per parole, nome del contatto o nome di un allegato.",
      schema: oggetto({
        testo: campoTesto("Parole da cercare"),
        azienda: campoTesto("Azienda (o «privato»), se Luigi la dice; altrimenti stringa vuota"),
        giorni: { type: "integer", description: "Quanti giorni indietro guardare (1-30)" },
      }),
    },
    azione: "whatsapp.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ testo: z.string().min(1).max(200), azienda: z.string().max(80), giorni: z.number().int().min(1).max(30) }).strict(),
    perRegistro: (i) => ({ giorni: i.giorni }),
    esegui: (i, c) => {
      const w = contestoWa(c);
      return w ? elencoWa(w, { testo: i.testo, azienda: i.azienda, giorni: i.giorni }) : SENZA_WA;
    },
  }),
  strumento({
    def: {
      nome: "whatsapp_chat",
      descrizione: "Legge gli ultimi messaggi di una chat WhatsApp (per nome del contatto o id dagli elenchi). Se il nome corrisponde a più chat, chiedi a Luigi quale.",
      schema: oggetto({
        contatto: campoTesto("Nome del contatto o id della chat"),
        azienda: campoTesto("Azienda (o «privato»), se Luigi la dice; altrimenti stringa vuota"),
        quanti: { type: "integer", description: "Quanti messaggi (1-40, di solito 15)" },
      }),
    },
    azione: "whatsapp.leggi", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ contatto: z.string().min(1).max(80), azienda: z.string().max(80), quanti: z.number().int().min(1).max(40) }).strict(),
    perRegistro: (i) => ({ quanti: i.quanti }),
    esegui: (i, c) => {
      const w = contestoWa(c);
      return w ? chatPerAi(w, i) : SENZA_WA;
    },
  }),
  strumento({
    def: {
      nome: "whatsapp_risposta",
      descrizione: "Prepara una risposta WhatsApp a un contatto. Parte SOLO dopo la conferma di Luigi (vede il testo e un pulsante). Possibile solo entro 24 ore dall'ultimo messaggio del contatto; mai nei gruppi.",
      schema: oggetto({
        contatto: campoTesto("Nome del contatto o id della chat"),
        azienda: campoTesto("Azienda (o «privato»), se Luigi la dice; altrimenti stringa vuota"),
        testo: campoTesto("Testo del messaggio, in italiano, cortese e breve. Niente promesse di pagamenti, importi, date o impegni: dove servono scrivi [da completare]"),
      }),
    },
    azione: "whatsapp.risposta", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ contatto: z.string().min(1).max(80), azienda: z.string().max(80), testo: z.string().min(1).max(MAX_TESTO_RISPOSTA) }).strict(),
    // (oltre MAX_TESTO_CONFERMA caratteri dopo la pulizia: rifiutato in «verifica», con un messaggio chiaro)
    verifica: (i, c) => {
      const w = contestoWa(c);
      if (!w) return SENZA_WA;
      const t = trovaContattoPerAi(w, i.contatto, i.azienda);
      if (!t.contatto) return t.errore!;
      if (t.contatto.gruppo) return "Jarvis non scrive nei gruppi: Luigi può rispondere dal telefono.";
      if (!statoChat(c.db, t.contatto.id).dentroFinestra) return fuoriFinestra(nomeContatto(t.contatto));
      const testo = pulisciTestoConfermato(i.testo);
      if (!testo) return "Il messaggio è vuoto.";
      if (testo.length > MAX_TESTO_CONFERMA) return `Messaggio troppo lungo: al massimo ${MAX_TESTO_CONFERMA} caratteri, così Luigi lo vede tutto prima di confermare. Accorcialo.`;
      if (DA_COMPLETARE.test(testo)) return "Nel messaggio c'è [da completare]: chiedi prima a Luigi i dati mancanti. Un messaggio incompleto non si manda.";
      return null;
    },
    // La conferma vale solo per questo testo esatto (pulito) e per questo contatto.
    datiConferma: (i, c) => {
      const contattoId = trovaContattoPerAi(contestoWa(c)!, i.contatto, i.azienda).contatto?.id ?? "";
      const testo = pulisciTestoConfermato(i.testo);
      return { contattoId, testo, impronta: improntaConferma(contattoId, testo) };
    },
    perRegistro: (i) => ({ azienda: i.azienda || undefined }),
    // Difesa in più: anche se il permesso cambiasse per sbaglio, da qui non parte niente.
    esegui: () => { throw new Error(SOLO_DOPO_CONFERMA); },
  }),
  strumento({
    def: {
      nome: "whatsapp_assegna_azienda",
      descrizione: "Dice a quale azienda (o al privato) appartiene un contatto WhatsApp, e Jarvis se lo ricorda. Serve sempre la conferma di Luigi.",
      schema: oggetto({
        contatto: campoTesto("Nome del contatto o id della chat"),
        azienda: campoTesto("Nome dell'azienda oppure «privato»"),
      }),
    },
    azione: "whatsapp.assegna", viste: ["privato", "lavoro", "tutto"],
    input: z.object({ contatto: z.string().min(1).max(80), azienda: z.string().min(1).max(80) }).strict(),
    verifica: (i, c) => {
      const w = contestoWa(c);
      if (!w) return SENZA_WA;
      const t = trovaContattoPerAi(w, i.contatto);
      if (!t.contatto) return t.errore!;
      const s = spazioDaNome(w, i.azienda);
      return s.domanda ? `Non è chiaro di quale azienda: chiedilo a Luigi.\n${marcaDati("aziende", { domandaSuggerita: s.domanda })}` : null;
    },
    datiConferma: (i, c) => {
      const w = contestoWa(c)!;
      return { contattoId: trovaContattoPerAi(w, i.contatto).contatto?.id, spazio: spazioDaNome(w, i.azienda).spazio };
    },
    perRegistro: () => ({}),
    esegui: () => { throw new Error(SOLO_DOPO_CONFERMA); },
  }),
];

const PER_NOME = new Map(STRUMENTI.map((s) => [s.def.nome, s as unknown as Strumento<z.ZodTypeAny>]));

export function strumentiPerVista(vista: Vista): DefinizioneStrumento[] {
  return STRUMENTI.filter((s) => s.viste.includes(vista)).map((s) => s.def);
}

// ---------------------------------------------------------------- conferme
function creaConferma(c: ContestoStrumenti, azione: string, dati: unknown): string {
  const id = randomUUID();
  c.db.prepare("INSERT INTO conferme (id, conversazione_id, creata, azione, dati) VALUES (?,?,?,?,?)").run(id, c.conversazione, Date.now(), azione, JSON.stringify(dati));
  return id;
}

export interface Risultato { contenuto: string; errore: boolean }

/** Esegue una chiamata dell'AI. Non lancia mai: gli errori tornano all'AI come testo. */
export async function eseguiStrumento(nome: string, input: unknown, c: ContestoStrumenti): Promise<Risultato> {
  const s = PER_NOME.get(nome);
  if (!s) {
    registra(c.db, `sconosciuto:${nome}`, "negato", "jarvis", { input });
    return { contenuto: "Strumento inesistente.", errore: true };
  }
  const v = s.input.safeParse(input);
  if (!v.success) {
    registra(c.db, s.azione, "errore", "jarvis", { strumento: nome, motivo: "input non valido" });
    return { contenuto: "Dati dello strumento non validi: ricontrolla i campi.", errore: true };
  }
  const registroInput = s.perRegistro ? s.perRegistro(v.data) : { input: v.data };
  const problema = s.verifica?.(v.data, c);
  if (problema) {
    registra(c.db, s.azione, "errore", "jarvis", { strumento: nome, motivo: problema.slice(0, 120) });
    return { contenuto: problema, errore: true };
  }
  const scritture = c.scritture ?? new Map<string, number>();
  const decisione = controllaPermesso(s.azione, {
    vista: c.vista, messaggioLuigi: c.messaggioLuigi, spazio: s.spazio?.(v.data), oggetto: s.oggetto?.(v.data), giaFatte: scritture.get(s.azione) ?? 0,
  });
  if (decisione.esito === "negato") {
    registra(c.db, s.azione, "negato", "jarvis", { strumento: nome, motivo: decisione.motivo });
    return { contenuto: `Non consentito: ${decisione.motivo}`, errore: true };
  }
  if (decisione.esito === "conferma") {
    const id = creaConferma(c, s.azione, { strumento: nome, input: v.data, ...(s.datiConferma?.(v.data, c) ?? {}) });
    c.emetti({ tipo: "conferma", id, domanda: descriviProposta(nome, v.data, c), opzioni: [] });
    registra(c.db, s.azione, "richiesta_conferma", "jarvis", { strumento: nome, ...registroInput, motivo: decisione.motivo, conferma: id });
    return {
      contenuto: nome === "posta_bozza"
        ? "Non fatto: serve la conferma di Luigi, che vede il testo della bozza e un pulsante. Diglielo in una frase. Anche dopo la conferma la bozza NON viene inviata: la manda lui."
        : nome === "whatsapp_risposta"
          ? "Non mandato: il messaggio parte solo se Luigi conferma (vede il testo e un pulsante). Diglielo in una frase; non dire che è partito."
          : "Non fatto: serve la conferma di Luigi, che vede un pulsante. Diglielo in una frase.",
      errore: false,
    };
  }
  c.emetti({ tipo: "strumento", nome });
  try {
    const contenuto = await s.esegui(v.data, c);
    const scritto = SCRITTURE.has(s.azione) && !(s.azione === "agenda.cancella" && !contenuto.startsWith("Cancellato"));
    if (scritto) scritture.set(s.azione, (scritture.get(s.azione) ?? 0) + 1);
    if (s.azione !== "agenda.cancella" || !contenuto.startsWith("Ho trovato")) {
      registra(c.db, s.azione, "fatto", "jarvis", { strumento: nome, ...registroInput });
    }
    return { contenuto, errore: false };
  } catch (e) {
    const msg = e instanceof ErroreCostructo || e instanceof Error ? e.message : "errore";
    registra(c.db, s.azione, "errore", "jarvis", { strumento: nome, motivo: msg });
    return { contenuto: `Non riuscito: ${msg}${e instanceof ErroreConDati ? `\n${marcaDati("costructo", e.dati)}` : ""}`, errore: true };
  }
}

/**
 * La domanda di conferma. Per i testi che escono da Jarvis (bozza email, messaggio WhatsApp) mostra il testo
 * INTERO e già pulito: è esattamente quello che verrà salvato o mandato (niente tagli, niente parti nascoste).
 */
function descriviProposta(nome: string, input: Record<string, unknown>, c?: ContestoStrumenti): string {
  if (nome === "posta_bozza") {
    const p = c ? contestoPosta(c) : null;
    const t = p ? mailPerBozza(p, String(input.id)) : {};
    const dove = t.casella && p ? `casella ${t.casella.nome} · ${nomeSpazio(t.casella.spazio, p.aziende)}` : "";
    const testo = pulisciTestoConfermato(String(input.testo ?? ""));
    return `Vuoi che metta questa bozza nelle Bozze${dove ? ` (${dove})` : ""}, in risposta a ${t.m ? `${destinatarioRisposta(t.m)} «${oggettoRisposta(t.m.oggetto)}»` : "questa mail"}? Non verrà inviata: la mandi tu. Testo completo (${testo.length} caratteri):\n\n«${testo}»`;
  }
  if (nome === "whatsapp_risposta" || nome === "whatsapp_assegna_azienda") {
    const w = c ? contestoWa(c) : null;
    const k = w ? trovaContattoPerAi(w, String(input.contatto), nome === "whatsapp_risposta" ? String(input.azienda ?? "") : "").contatto : undefined;
    const chi = k && w ? `${nomeContatto(k)} (${nomeSpazioWa(k.spazio, w.aziende)})` : String(input.contatto);
    if (nome === "whatsapp_assegna_azienda") {
      const s = w ? spazioDaNome(w, String(input.azienda)).spazio : undefined;
      return `Vuoi che ${chi} sia considerato di ${s && w ? nomeSpazioWa(s, w.aziende) : String(input.azienda)}? Me lo ricorderò per le prossime chat.`;
    }
    const testo = pulisciTestoConfermato(String(input.testo ?? ""));
    return `Vuoi che mandi su WhatsApp a ${chi} questo messaggio? Parte solo se confermi. Testo completo (${testo.length} caratteri):\n\n«${testo}»`;
  }
  if (nome === "agenda_aggiungi") return `Vuoi che segni «${input.titolo}» il ${input.data}${input.ora ? ` alle ${input.ora}` : ""}?`;
  if (nome === "agenda_cancella") return `Vuoi che cancelli l'impegno «${input.titolo}»?`;
  if (nome === "ricordo_salva") return `Vuoi che ricordi (${input.spazio}): «${input.testo}»?`;
  return "Confermi questa azione?";
}

/** Luigi risponde a una conferma (pulsante o «sì» / «il secondo» / «annulla»). */
export async function rispondiConferma(db: Db, id: string, scelta: "conferma" | "annulla" | number, fuso: string, ora = Date.now(), posta?: DipendenzePosta, whatsapp?: DipendenzeWhatsapp): Promise<{ ok: boolean; messaggio: string }> {
  const r = db.prepare("SELECT * FROM conferme WHERE id = ?").get(id) as { id: string; creata: number; azione: string; dati: string; stato: string } | undefined;
  if (!r || r.stato !== "in_attesa") return { ok: false, messaggio: "Questa richiesta non è più in attesa." };
  if (ora - r.creata > 15 * 60_000) {
    db.prepare("UPDATE conferme SET stato = 'scaduta' WHERE id = ?").run(id);
    return { ok: false, messaggio: "La richiesta è scaduta: chiedimelo di nuovo." };
  }
  if (scelta === "annulla") {
    db.prepare("UPDATE conferme SET stato = 'annullata' WHERE id = ?").run(id);
    registra(db, r.azione, "negato", "luigi", { conferma: id, motivo: "annullata da Luigi" });
    return { ok: true, messaggio: "Va bene, non faccio niente." };
  }
  const dati = JSON.parse(r.dati) as { ids?: string[]; strumento?: string; input?: Record<string, unknown>; contattoId?: string; spazio?: string; testo?: string; impronta?: string };
  let messaggio = "Fatto.";
  if (dati.ids) {
    const indice = typeof scelta === "number" ? scelta : dati.ids.length === 1 ? 0 : -1;
    const idImpegno = dati.ids[indice];
    if (!idImpegno) return { ok: false, messaggio: "Dimmi quale: il primo, il secondo…" };
    const tolto: Impegno | null = cancellaImpegno(db, idImpegno);
    messaggio = tolto ? `Cancellato: ${descriviImpegno(tolto, fuso)}.` : "Quell'impegno non c'è più.";
  } else if (dati.strumento === "agenda_aggiungi" && dati.input) {
    const imp = aggiungiImpegno(db, dati.input as { titolo: string; data: string; ora: string; minuti: number }, fuso);
    messaggio = `Segnato: ${descriviImpegno(imp, fuso)}.`;
  } else if (dati.strumento === "agenda_cancella" && dati.input) {
    const trovati = cercaImpegni(db, String(dati.input.titolo), fuso);
    if (trovati.length !== 1) return { ok: false, messaggio: trovati.length ? "Ci sono più impegni simili: dimmi quale." : "Non trovo più quell'impegno." };
    cancellaImpegno(db, trovati[0].id);
    messaggio = `Cancellato: ${descriviImpegno(trovati[0], fuso)}.`;
  } else if (dati.strumento === "ricordo_salva" && dati.input) {
    aggiungiMemoria(db, dati.input.spazio as Spazio, String(dati.input.testo), "luigi");
    messaggio = "Ricordo salvato.";
  } else if (dati.strumento === "posta_bozza" && dati.input) {
    if (!posta) return { ok: false, messaggio: "La posta non è disponibile in questo momento." };
    // Si segna subito come confermata: un secondo clic non crea una seconda bozza.
    if (db.prepare("UPDATE conferme SET stato = 'confermata' WHERE id = ? AND stato = 'in_attesa'").run(id).changes === 0) return { ok: false, messaggio: "Questa richiesta non è più in attesa." };
    // Si salva SOLO il testo mostrato nella conferma (stessa impronta).
    const testo = dati.testo ?? "";
    if (!dati.impronta || !stessaImpronta(dati.impronta, improntaConferma(`mail:${String(dati.input.id)}`, testo))) return { ok: false, messaggio: "Il testo non corrisponde a quello confermato: non ho fatto niente." };
    try {
      const r = await creaBozza(posta, String(dati.input.id), testo);
      return { ok: true, messaggio: r.messaggio };
    } catch (e) {
      return { ok: false, messaggio: (e as Error).message || "Bozza non riuscita." };
    }
  } else if ((dati.strumento === "whatsapp_risposta" || dati.strumento === "whatsapp_assegna_azienda") && dati.input) {
    if (!whatsapp) return { ok: false, messaggio: "WhatsApp non è disponibile in questo momento." };
    const k = dati.contattoId ? leggiContatto(db, dati.contattoId) : undefined;
    if (!k) return { ok: false, messaggio: "Non trovo più quella chat." };
    // Si segna subito come confermata: un secondo clic non manda un secondo messaggio.
    if (db.prepare("UPDATE conferme SET stato = 'confermata' WHERE id = ? AND stato = 'in_attesa'").run(id).changes === 0) return { ok: false, messaggio: "Questa richiesta non è più in attesa." };
    registra(db, r.azione, "fatto", "luigi", { conferma: id, contatto: k.id });
    try {
      if (dati.strumento === "whatsapp_assegna_azienda") {
        if (!dati.spazio) return { ok: false, messaggio: "Non è chiaro di quale azienda: dimmelo di nuovo." };
        return { ok: true, messaggio: `Fatto: ${nomeContatto(k)} è di ${rispondiDomanda(whatsapp, k.id, dati.spazio)}. Me lo ricordo.` };
      }
      // Parte SOLO il testo mostrato nella conferma: stessa impronta di contatto + testo.
      const testo = dati.testo ?? "";
      if (!dati.impronta || !stessaImpronta(dati.impronta, improntaConferma(k.id, testo))) return { ok: false, messaggio: "Il testo non corrisponde a quello confermato: non ho mandato niente." };
      const risposta = preparaRisposta(whatsapp, k.id, testo, "risposta", "bozza", "luigi");
      if (risposta.testo !== testo) return { ok: false, messaggio: "Il testo non corrisponde a quello confermato: non ho mandato niente." };
      const e = await inviaRisposta(whatsapp, risposta.id, improntaConferma(k.id, risposta.testo));
      return { ok: e.inviata, messaggio: e.messaggio };
    } catch (e) {
      return { ok: false, messaggio: (e as Error).message || "Non riuscito." };
    }
  } else {
    return { ok: false, messaggio: "Non so eseguire questa conferma." };
  }
  db.prepare("UPDATE conferme SET stato = 'confermata' WHERE id = ?").run(id);
  registra(db, r.azione, "fatto", "luigi", { conferma: id, scelta });
  return { ok: true, messaggio };
}

export interface ConfermaAperta { id: string; dati: string; creata: number }

/** Conferme ancora in attesa nella conversazione, nate dopo l'istante `da` (e non scadute), dalla più recente. */
export function confermeAperte(db: Db, conversazione: string, da = 0, ora = Date.now()): ConfermaAperta[] {
  return db.prepare("SELECT id, dati, creata FROM conferme WHERE conversazione_id = ? AND stato = 'in_attesa' AND creata > ? AND creata >= ? ORDER BY creata DESC, rowid DESC")
    .all(conversazione, ora - 15 * 60_000, da) as ConfermaAperta[];
}
