// Interfaccia del "cervello" (il modello AI). Il ciclo con gli strumenti sta in assistente.ts:
// il cervello fa un solo passo per volta, così è facile sostituirlo con uno finto nei test.

export interface ChiamataStrumento { id: string; nome: string; input: unknown }

export type MessaggioCervello =
  | { ruolo: "utente"; testo: string }
  /** `grezzo` conserva il contenuto originale del fornitore (es. blocchi di ragionamento) da rimandare invariato. */
  | { ruolo: "jarvis"; testo: string; chiamate: ChiamataStrumento[]; grezzo?: unknown }
  | { ruolo: "risultati"; risultati: Array<{ id: string; contenuto: string; errore?: boolean }> };

export interface DefinizioneStrumento {
  nome: string;
  descrizione: string;
  /** JSON Schema con additionalProperties:false e tutti i campi in required (strumenti "strict"). */
  schema: Record<string, unknown>;
}

export interface RichiestaPasso {
  modello: string;
  /** Prompt di sistema STABILE (va in cache). Le cose che cambiano stanno nei messaggi. */
  sistema: string;
  messaggi: MessaggioCervello[];
  strumenti: DefinizioneStrumento[];
  maxToken: number;
  sforzo: "low" | "medium" | "high";
  segnale?: AbortSignal;
}

export type MotivoFine = "fine" | "strumenti" | "rifiuto" | "limite" | "altro";

export interface UsoToken { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number }

export interface RispostaPasso {
  testo: string;
  chiamate: ChiamataStrumento[];
  fine: MotivoFine;
  uso: UsoToken;
  /**
   * Facoltativo: consumo diviso per modello quando nello stesso passo hanno lavorato più modelli
   * (per esempio il ripiego lato server dopo un rifiuto). Se c'è, sostituisce `uso` nel conteggio.
   */
  consumi?: Array<{ modello: string; uso: UsoToken }>;
  grezzo?: unknown;
}

export interface Cervello {
  nome: string;
  /** Un passo: chiama il modello una volta, passa il testo man mano che arriva. */
  passo(r: RichiestaPasso, suTesto: (pezzo: string) => void): Promise<RispostaPasso>;
}

export class CervelloNonDisponibile extends Error {}

/**
 * Il passo si è fermato a metà: Luigi ha premuto stop o ha fatto una nuova domanda ("interrotto"),
 * la rete è caduta ("rete") o Claude non ha risposto in tempo ("tempo").
 * `uso` è il consumo noto fino a quel punto (se il fornitore l'ha comunicato): chi riceve l'errore
 * lo registra comunque, o in mancanza usa una stima prudente.
 */
export class PassoInterrotto extends Error {
  constructor(public motivo: "interrotto" | "rete" | "tempo", public uso?: UsoToken, public testoParziale = "") {
    super(`passo interrotto (${motivo})`);
  }
}
