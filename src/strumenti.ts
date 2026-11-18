// Strumenti che l'AI può usare in Fase 1. Ogni chiamata: validazione (zod) → permesso → esecuzione → registro.
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
import { inizioGiorno, oraMinuti, descriviGiorno } from "./tempo.js";

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
 * Legge Costructo per una o più aziende.
 * - una sola azienda collegata: si usa quella;
 * - più aziende e `richiesta` detta: si cerca per nome o id; se non è chiaro, l'AI deve chiedere a Luigi;
 * - più aziende e niente `richiesta`: si leggono tutte (se `tutte`), ogni dato con il nome della sua azienda;
 *   l'errore di un'azienda non nasconde i dati delle altre.
 */
async function daCostructo(c: ContestoStrumenti, richiesta: string | undefined, f: Lettura, tutte = true): Promise<string> {
  const aziende = aziendeDelContesto(c);
  if (!aziende.length) return "Costructo non è ancora collegato: dillo a Luigi in una frase.";
  const chiedi = (motivo: string) =>
    `${motivo} Le aziende collegate sono: ${nomiAziende(aziende, "e")}. Non ho letto niente: chiedi a Luigi «Di quale azienda parli: ${nomiAziende(aziende)}?».`;
  let scelte = aziende;
  if (aziende.length > 1) {
    const r = (richiesta ?? "").trim();
    if (r) {
      scelte = trovaAziende(aziende, r);
      if (!scelte.length) return chiedi(`Nessuna azienda collegata corrisponde a «${r.slice(0, 80)}».`);
      if (scelte.length > 1) return chiedi(`«${r.slice(0, 80)}» può essere più di un'azienda.`);
    } else if (!tutte) {
      return chiedi("Non è chiaro di quale azienda parla Luigi.");
    }
  }
  if (scelte.length === 1) {
    const a = scelte[0];
    try {
      const r = await f(a.client);
      return marcaDati("costructo", { ...(a.nome ? { azienda: a.nome } : {}), percorso: r.percorso, dati: r.dati });
    } catch (e) {
      if (aziende.length > 1 && e instanceof Error) throw new ErroreCostructo(`${a.nome}: ${e.message}`, e instanceof ErroreCostructo ? e.codice : "server");
      throw e;
    }
  }
  const esiti = await Promise.allSettled(scelte.map((a) => f(a.client)));
  if (esiti.every((e) => e.status === "rejected")) {
    throw new ErroreCostructo(esiti.map((e, i) => `${scelte[i].nome}: ${((e as PromiseRejectedResult).reason as Error)?.message ?? "errore"}`).join(" "), "server");
  }
  return marcaDati("costructo", {
    nota: "Dati di più aziende: ogni blocco dice di quale azienda è. Di' sempre a quale azienda appartiene ogni informazione e non sommare numeri di aziende diverse senza dirlo.",
    aziende: esiti.map((e, i) => e.status === "fulfilled"
      ? { azienda: scelte[i].nome, percorso: e.value.percorso, dati: e.value.dati }
      : { azienda: scelte[i].nome, errore: (e.reason as Error)?.message ?? "errore" }),
  });
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
      if (!link) return "Nessun calendario personale collegato.";
      const da = inizioGiorno(Date.now(), c.fuso);
      const ev = occorrenze(await scaricaCalendario(link, { fetchFn: c.fetchFn }), da, da + i.giorni * 864e5, c.fuso).slice(0, 60);
      return marcaDati("calendario", ev.map((e) => ({ giorno: descriviGiorno(e.inizio, c.fuso), ora: e.tuttoIlGiorno ? "tutto il giorno" : oraMinuti(e.inizio, c.fuso), titolo: e.titolo, luogo: e.luogo })));
    },
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
  const scritture = c.scritture ?? new Map<string, number>();
  const decisione = controllaPermesso(s.azione, {
    vista: c.vista, messaggioLuigi: c.messaggioLuigi, spazio: s.spazio?.(v.data), oggetto: s.oggetto?.(v.data), giaFatte: scritture.get(s.azione) ?? 0,
  });
  if (decisione.esito === "negato") {
    registra(c.db, s.azione, "negato", "jarvis", { strumento: nome, motivo: decisione.motivo });
    return { contenuto: `Non consentito: ${decisione.motivo}`, errore: true };
  }
  if (decisione.esito === "conferma") {
    const id = creaConferma(c, s.azione, { strumento: nome, input: v.data });
    c.emetti({ tipo: "conferma", id, domanda: descriviProposta(nome, v.data), opzioni: [] });
    registra(c.db, s.azione, "richiesta_conferma", "jarvis", { strumento: nome, input: v.data, motivo: decisione.motivo, conferma: id });
    return { contenuto: "Non fatto: serve la conferma di Luigi, che vede un pulsante. Diglielo in una frase.", errore: false };
  }
  c.emetti({ tipo: "strumento", nome });
  try {
    const contenuto = await s.esegui(v.data, c);
    const scritto = SCRITTURE.has(s.azione) && !(s.azione === "agenda.cancella" && !contenuto.startsWith("Cancellato"));
    if (scritto) scritture.set(s.azione, (scritture.get(s.azione) ?? 0) + 1);
    if (s.azione !== "agenda.cancella" || !contenuto.startsWith("Ho trovato")) {
      registra(c.db, s.azione, "fatto", "jarvis", { strumento: nome, input: v.data });
    }
    return { contenuto, errore: false };
  } catch (e) {
    const msg = e instanceof ErroreCostructo || e instanceof Error ? e.message : "errore";
    registra(c.db, s.azione, "errore", "jarvis", { strumento: nome, motivo: msg });
    return { contenuto: `Non riuscito: ${msg}`, errore: true };
  }
}

function descriviProposta(nome: string, input: Record<string, unknown>): string {
  if (nome === "agenda_aggiungi") return `Vuoi che segni «${input.titolo}» il ${input.data}${input.ora ? ` alle ${input.ora}` : ""}?`;
  if (nome === "agenda_cancella") return `Vuoi che cancelli l'impegno «${input.titolo}»?`;
  if (nome === "ricordo_salva") return `Vuoi che ricordi (${input.spazio}): «${input.testo}»?`;
  return "Confermi questa azione?";
}

/** Luigi risponde a una conferma (pulsante o «sì» / «il secondo» / «annulla»). */
export function rispondiConferma(db: Db, id: string, scelta: "conferma" | "annulla" | number, fuso: string, ora = Date.now()): { ok: boolean; messaggio: string } {
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
  const dati = JSON.parse(r.dati) as { ids?: string[]; strumento?: string; input?: Record<string, unknown> };
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
