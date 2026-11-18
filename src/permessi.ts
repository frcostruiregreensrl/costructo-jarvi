// Motore dei permessi (Fasi 1, 2 e 3, autonomia livello 2).
// Regola d'oro: Jarvis legge Costructo, la posta e i calendari, e scrive solo nella propria agenda e nella propria memoria.
// Ogni scrittura parte solo se l'ha chiesta Luigi nel messaggio del turno; altrimenti (per esempio se l'idea
// arriva da un dato esterno) diventa una richiesta di conferma.
// Fase 2: una bozza di risposta va nella cartella Bozze della casella (una scrittura FUORI da Jarvis): serve
// SEMPRE la conferma di Luigi con il pulsante. Mandare email resta impossibile: non esiste nessuno strumento per farlo.
// Fase 3: una risposta WhatsApp parte SOLO dopo la conferma di Luigi (pulsante o «sì, conferma» alla domanda appena fatta);
// anche assegnare un contatto a un'azienda chiede sempre la conferma.
// Fase 3b: mandare una PROPOSTA a Costructo è una scrittura fuori da Jarvis → sempre la conferma di Luigi
// (con il testo completo di ogni proposta). Preparare la proposta in Jarvis (bozza locale) richiede che Luigi
// l'abbia chiesta nel turno, sullo stesso oggetto. La ricerca unica legge solo quello che la scheda può vedere.
import type { Vista, Spazio } from "./memorie.js";

export type Azione =
  | "costructo.leggi"
  | "calendario.leggi"
  | "agenda.leggi"
  | "agenda.aggiungi"
  | "agenda.cancella"
  | "memoria.leggi"
  | "memoria.salva"
  | "interfaccia.numero"
  | "posta.leggi"
  | "posta.bozza"
  | "calendario_aziende.leggi"
  | "whatsapp.leggi"
  | "whatsapp.risposta"
  | "whatsapp.assegna"
  | "ricerca.leggi"
  | "proposta.leggi"
  | "proposta.prepara"
  | "costructo.proposta";

export const AZIONI_FASE1: ReadonlySet<string> = new Set<Azione>([
  "costructo.leggi", "calendario.leggi", "agenda.leggi", "agenda.aggiungi", "agenda.cancella", "memoria.leggi", "memoria.salva", "interfaccia.numero",
  // Fase 2
  "posta.leggi", "posta.bozza", "calendario_aziende.leggi",
  // Fase 3
  "whatsapp.leggi", "whatsapp.risposta", "whatsapp.assegna",
  // Fase 3b
  "ricerca.leggi", "proposta.leggi", "proposta.prepara", "costructo.proposta",
]);
export const SCRITTURE: ReadonlySet<Azione> = new Set<Azione>(["agenda.aggiungi", "agenda.cancella", "memoria.salva", "posta.bozza", "whatsapp.risposta", "whatsapp.assegna", "proposta.prepara", "costructo.proposta"]);
/** Scritture fuori da Jarvis: chiedono SEMPRE la conferma di Luigi (pulsante), anche se l'ha chiesto lui. */
export const SEMPRE_CONFERMA: ReadonlySet<Azione> = new Set<Azione>(["posta.bozza", "whatsapp.risposta", "whatsapp.assegna", "costructo.proposta"]);

export interface ContestoPermesso {
  vista: Vista;
  /** Il messaggio scritto o detto da Luigi in questo turno (NON i dati esterni). */
  messaggioLuigi: string;
  /** Spazio di memoria toccato (solo per memoria.*). */
  spazio?: Spazio;
  /**
   * Oggetto della scrittura: titolo dell'impegno da aggiungere o cercare, testo del ricordo.
   * Serve a legare il verbo all'oggetto: «cancella la palestra» autorizza solo la palestra.
   * Per le scritture è obbligatorio: senza oggetto si chiede conferma.
   */
  oggetto?: string;
  /** Quante scritture dello stesso tipo sono già state fatte in questo turno. */
  giaFatte?: number;
}

export type Decisione = { esito: "consentito" } | { esito: "negato"; motivo: string } | { esito: "conferma"; motivo: string };

/** Quante cancellazioni (dello stesso tipo) un turno può fare senza conferma. */
export const CANCELLAZIONI_PER_TURNO = 1;

export function controllaPermesso(azione: string, c: ContestoPermesso): Decisione {
  if (!AZIONI_FASE1.has(azione)) return { esito: "negato", motivo: "Azione non prevista in questa fase." };
  if (azione === "costructo.leggi" && c.vista === "privato") return { esito: "negato", motivo: "Nella scheda Privato non uso i dati di lavoro." };
  if (azione.startsWith("agenda.") && c.vista === "lavoro") return { esito: "negato", motivo: "L'agenda locale è privata: usa la scheda Privato o Tutto." };
  if (azione.startsWith("calendario.") && c.vista === "lavoro") return { esito: "negato", motivo: "Il calendario personale è privato." };
  if (azione === "calendario_aziende.leggi" && c.vista === "privato") return { esito: "negato", motivo: "Nella scheda Privato non uso i calendari di lavoro." };
  if (azione.startsWith("memoria.") && c.spazio && c.vista !== "tutto" && c.spazio !== c.vista) {
    return { esito: "negato", motivo: `Nella scheda ${c.vista} non tocco i ricordi dello spazio ${c.spazio}.` };
  }
  if (!SCRITTURE.has(azione as Azione)) return { esito: "consentito" };
  const a = azione as Azione;
  if (a === "whatsapp.risposta") return { esito: "conferma", motivo: "Messaggio WhatsApp: parte solo dopo la conferma di Luigi." };
  if (a === "whatsapp.assegna") return { esito: "conferma", motivo: "Azienda di un contatto WhatsApp: decide Luigi." };
  if (a === "costructo.proposta") return { esito: "conferma", motivo: "Proposta per Costructo: parte solo dopo la conferma di Luigi." };
  if (a === "proposta.prepara" && c.vista === "privato") return { esito: "negato", motivo: "Nella scheda Privato non preparo proposte per Costructo." };
  if (SEMPRE_CONFERMA.has(a)) return { esito: "conferma", motivo: "Scrittura nella casella di posta: serve sempre la conferma di Luigi." };
  if (!haIntenzione(a, c.messaggioLuigi)) {
    return { esito: "conferma", motivo: "Luigi non l'ha chiesto in questo messaggio: serve la sua conferma." };
  }
  if (!c.oggetto || !oggettoNelMessaggio(c.oggetto, c.messaggioLuigi)) {
    return { esito: "conferma", motivo: "Luigi ha chiesto un'altra cosa in questo messaggio: serve la sua conferma." };
  }
  if (a === "agenda.cancella" && (c.giaFatte ?? 0) >= CANCELLAZIONI_PER_TURNO) {
    return { esito: "conferma", motivo: "Più cancellazioni nello stesso messaggio: serve la conferma di Luigi." };
  }
  return { esito: "consentito" };
}

// Per ogni scrittura, le parole con cui Luigi la chiede. Un dato esterno non può "parlare" al posto suo.
// «ricordami» vale per l'agenda (promemoria); «ricordati / ricorda che» per la memoria.
const INTENZIONI: Partial<Record<Azione, RegExp>> = {
  "agenda.aggiungi": /\b(segna(mi|re|lo|la)?|aggiungi(mi)?|aggiunge?re|metti(mi)?|fiss[ai](mi)?|prenota(mi)?|crea|inserisci|programma|ricordami|promemoria|appuntamento alle)\b/i,
  "agenda.cancella": /\b(cancella(lo|la|re)?|elimina(lo|la|re)?|togli(lo|la|ere)?|rimuovi(lo|la)?|disdici|annulla(lo|la|re)?)\b/i,
  "memoria.salva": /\b(ricorda(ti|re)?|memorizza|salva|annota|appunta|segnati|tieni a mente|sappi che|non dimenticare)\b/i,
  "proposta.prepara": /\b(manda(gli|le|re)?|mandare|invia(gli|le|re)?|spedisci|spedire|prepara(mi|re)?|proponi|gira(gli|le)?|fai avere)\b/i,
};

// «ricordami cosa ho domani», «ricordami quando...»: è una domanda, non una richiesta di scrivere.
const RICORDAMI_DOMANDA = /\bricordami\s+(un po'\s+)?(cosa|che cosa|cos'|quando|quali?|se|dove|chi|come|quanto|quanti|perch[eé])\b/i;

export function haIntenzione(azione: Azione, messaggio: string): boolean {
  const re = INTENZIONI[azione];
  if (!re) return false;
  if (azione === "agenda.aggiungi") {
    // Togliamo le domande con «ricordami»: se resta un altro verbo di scrittura, l'intenzione c'è.
    const senzaDomande = messaggio.replace(new RegExp(RICORDAMI_DOMANDA.source, "gi"), " ");
    return re.test(senzaDomande);
  }
  return re.test(messaggio);
}

// ---------------------------------------------------------------- verbo legato all'oggetto
const PAROLE_VUOTE = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della", "dello", "dei", "degli", "delle", "da", "dal", "dalla",
  "a", "al", "alla", "ai", "agli", "alle", "in", "nel", "nella", "con", "su", "per", "tra", "fra", "e", "o", "che", "mi", "ti", "si",
  "luigi", "jarvis", "impegno", "appuntamento", "evento", "ricordo", "promemoria", "oggi", "domani", "dopodomani", "ore", "alle",
]);
const normalizza = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const parole = (t: string) => normalizza(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !PAROLE_VUOTE.has(p));

/** Vero se almeno una parola significativa dell'oggetto compare nel messaggio di Luigi (anche al plurale). */
export function oggettoNelMessaggio(oggetto: string, messaggio: string): boolean {
  const nel = parole(messaggio);
  return parole(oggetto).some((o) => nel.some((m) => {
    if (o === m) return true;
    if (o.length < 5 || m.length < 5) return false;
    const radice = Math.max(4, Math.min(o.length, m.length) - 2);
    return o.slice(0, radice) === m.slice(0, radice);
  }));
}
