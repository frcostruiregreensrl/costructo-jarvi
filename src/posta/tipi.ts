// Tipi della posta (Fase 2). Jarvis LEGGE le caselle, riassume, segnala le urgenze e prepara BOZZE.
// Non cancella, non sposta e non segna mai come lette le mail. Dalle PEC non parte mai niente.
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import type { Cervello } from "../cervello/tipi.js";
import type { Invia } from "../push.js";
import type { RisolviNome } from "../calendario.js";

export type TipoCasella = "pec" | "gmail" | "altro";
export interface Server { host: string; porta: number }

/** Una casella email, salvata nel segreto cifrato «posta_caselle» (con la password). */
export interface Casella {
  id: string;
  nome: string;
  tipo: TipoCasella;
  /** Id dell'azienda (dall'elenco delle aziende) oppure «privato». */
  spazio: string;
  imap: Server;
  smtp?: Server;
  utente: string;
  password: string;
  /** Conferme di ricezione automatiche: di serie spente, sempre spente per le PEC. */
  confermeAutomatiche: boolean;
}

/** Un'azienda come la vede la posta: solo id e nome. */
export interface AziendaPosta { id: string; nome: string }

/** Un messaggio come arriva dal server (sorgente troncata: bastano intestazioni e inizio del testo). */
export interface MessaggioGrezzo {
  uid: number;
  sorgente: Buffer;
  dimensione?: number;
  data?: Date;
  /** Nomi e dimensioni degli allegati letti dalla struttura del messaggio (senza scaricarli). */
  allegati?: Array<{ nome: string; dimensione: number }>;
}

/**
 * Collegamento IMAP a una casella. È l'UNICO modo in cui Jarvis parla con il server di posta:
 * non ci sono operazioni che cambiano i segni (letto, importante…), spostano o cancellano.
 * L'unica scrittura è aggiungere una bozza (con il segno \Draft) nella cartella Bozze.
 */
export interface ConnessioneImap {
  /** Apre la Posta in arrivo in SOLA LETTURA (EXAMINE). */
  apriInbox(): Promise<{ uidValidity: string; uidNext: number }>;
  /** UID dei messaggi arrivati da quella data in poi. */
  cercaDal(data: Date): Promise<number[]>;
  /** UID maggiori di `uid`. */
  uidDopo(uid: number): Promise<number[]>;
  /** Scarica i messaggi senza segnarli come letti (BODY.PEEK), al massimo `maxByte` ciascuno. */
  scarica(uids: number[], maxByte: number): Promise<MessaggioGrezzo[]>;
  /** Percorso della cartella Bozze (SPECIAL-USE \Drafts, oppure «Bozze» / «Drafts»), null se non c'è. */
  cartellaBozze(): Promise<string | null>;
  /** Aggiunge una bozza (segno \Draft). Non la invia. */
  aggiungiBozza(cartella: string, sorgente: Buffer): Promise<void>;
  chiudi(): Promise<void>;
}
export type ApriImap = (c: Casella) => Promise<ConnessioneImap>;

export interface MailInUscita {
  a: string;
  oggetto: string;
  testo: string;
  inReplyTo?: string;
  references?: string;
}
/** Invio SMTP: usato SOLO per le conferme di ricezione automatiche (mai per le PEC, mai per le bozze). */
export interface PostaInUscita {
  invia(c: Casella, m: MailInUscita): Promise<void>;
  prova(c: Casella): Promise<void>;
}

export interface DipendenzePosta {
  db: Db;
  cifratore: Cifratore;
  fuso: string;
  apriImap: ApriImap;
  uscita: PostaInUscita;
  cervello: () => Promise<Cervello>;
  modello: string;
  /** Le aziende collegate (per i nomi e per controllare l'appartenenza delle caselle). */
  aziende: () => AziendaPosta[];
  invia?: Invia | null;
  risolvi?: RisolviNome;
  ora?: () => number;
}

/** Una mail salvata da Jarvis (al massimo 30 giorni). */
export interface MessaggioPosta {
  id: string;
  casella_id: string;
  uid: number;
  uid_validity: string;
  message_id: string;
  riferimenti: string;
  da_nome: string;
  da_indirizzo: string;
  rispondi_a: string;
  a: string;
  oggetto: string;
  data: number;
  estratto: string;
  allegati: string;
  segni: string;
  spazio: string;
  stato: "da_classificare" | "classificato" | "filtrato" | "tetto" | "errore";
  riassunto: string;
  urgente: number;
  motivo: string;
  tocca: number;
  tentativi: number;
  nuova: number;
  conferma_auto: string;
  notificata: number;
  salvato: number;
}

export interface Segni {
  /** Mailing list o invio di massa (List-*, Precedence: bulk/list/junk). */
  lista?: boolean;
  /** Messaggio automatico (Auto-Submitted diverso da «no», risposte automatiche, mailer-daemon). */
  automatico?: boolean;
  /** Mittente no-reply / noreply / donotreply. */
  noReply?: boolean;
  /** PEC: busta di trasporto o ricevuta (accettazione, consegna…). */
  pec?: "messaggio" | "accettazione" | "consegna" | "non_accettazione" | "mancata_consegna" | "presa_in_carico" | "errore";
}

export class ErrorePosta extends Error {
  constructor(messaggio: string, readonly stato = 400) { super(messaggio); }
}
