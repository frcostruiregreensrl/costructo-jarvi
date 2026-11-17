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

export interface RispostaPasso {
  testo: string;
  chiamate: ChiamataStrumento[];
  fine: MotivoFine;
  uso: { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number };
  grezzo?: unknown;
}

export interface Cervello {
  nome: string;
  /** Un passo: chiama il modello una volta, passa il testo man mano che arriva. */
  passo(r: RichiestaPasso, suTesto: (pezzo: string) => void): Promise<RispostaPasso>;
}

export class CervelloNonDisponibile extends Error {}
