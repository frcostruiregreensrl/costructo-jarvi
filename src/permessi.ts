// Motore dei permessi (Fase 1, autonomia livello 2).
// Regola d'oro: Jarvis legge Costructo e scrive solo nella propria agenda e nella propria memoria.
// Nessuna azione esterna. Ogni scrittura parte solo se l'ha chiesta Luigi nel messaggio del turno;
// altrimenti (per esempio se l'idea arriva da un dato esterno) diventa una richiesta di conferma.
import type { Vista, Spazio } from "./memorie.js";

export type Azione =
  | "costructo.leggi"
  | "calendario.leggi"
  | "agenda.leggi"
  | "agenda.aggiungi"
  | "agenda.cancella"
  | "memoria.leggi"
  | "memoria.salva"
  | "interfaccia.numero";

export const AZIONI_FASE1: ReadonlySet<string> = new Set<Azione>([
  "costructo.leggi", "calendario.leggi", "agenda.leggi", "agenda.aggiungi", "agenda.cancella", "memoria.leggi", "memoria.salva", "interfaccia.numero",
]);
export const SCRITTURE: ReadonlySet<Azione> = new Set<Azione>(["agenda.aggiungi", "agenda.cancella", "memoria.salva"]);

export interface ContestoPermesso {
  vista: Vista;
  /** Il messaggio scritto o detto da Luigi in questo turno (NON i dati esterni). */
  messaggioLuigi: string;
  /** Spazio di memoria toccato (solo per memoria.*). */
  spazio?: Spazio;
}

export type Decisione = { esito: "consentito" } | { esito: "negato"; motivo: string } | { esito: "conferma"; motivo: string };

export function controllaPermesso(azione: string, c: ContestoPermesso): Decisione {
  if (!AZIONI_FASE1.has(azione)) return { esito: "negato", motivo: "Azione non prevista in questa fase." };
  if (azione === "costructo.leggi" && c.vista === "privato") return { esito: "negato", motivo: "Nella scheda Privato non uso i dati di lavoro." };
  if (azione.startsWith("agenda.") && c.vista === "lavoro") return { esito: "negato", motivo: "L'agenda locale è privata: usa la scheda Privato o Tutto." };
  if (azione.startsWith("calendario.") && c.vista === "lavoro") return { esito: "negato", motivo: "Il calendario personale è privato." };
  if (azione.startsWith("memoria.") && c.spazio && c.vista !== "tutto" && c.spazio !== c.vista) {
    return { esito: "negato", motivo: `Nella scheda ${c.vista} non tocco i ricordi dello spazio ${c.spazio}.` };
  }
  if (SCRITTURE.has(azione as Azione) && !haIntenzione(azione as Azione, c.messaggioLuigi)) {
    return { esito: "conferma", motivo: "Luigi non l'ha chiesto in questo messaggio: serve la sua conferma." };
  }
  return { esito: "consentito" };
}

// Per ogni scrittura, le parole con cui Luigi la chiede. Un dato esterno non può "parlare" al posto suo.
const INTENZIONI: Partial<Record<Azione, RegExp>> = {
  "agenda.aggiungi": /\b(segna(mi|re)?|aggiungi(mi)?|aggiunge?re|metti(mi)?|fiss[ai](mi)?|prenota|crea|inserisci|programma|ricordami|appuntamento alle)\b/i,
  "agenda.cancella": /\b(cancella|elimina|togli|rimuovi|disdici|annulla)\b/i,
  "memoria.salva": /\b(ricorda(ti|re)?|memorizza|salva|annota|appunta|segnati|tieni a mente|sappi che|non dimenticare)\b/i,
};

export function haIntenzione(azione: Azione, messaggio: string): boolean {
  const re = INTENZIONI[azione];
  return !!re && re.test(messaggio);
}
