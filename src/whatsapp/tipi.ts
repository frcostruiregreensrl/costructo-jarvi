// Tipi di WhatsApp (Fase 3, parte 1: tutto pronto, ma SENZA collegamento reale a Meta).
// Autonomia livello 2: Jarvis legge, riassume, segnala le urgenze e prepara risposte.
// Una risposta parte SOLO dopo la conferma esplicita di Luigi. Jarvis non manda mai le «spunte blu» (letto).
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import type { Cervello } from "../cervello/tipi.js";
import type { Invia } from "../push.js";
import type { AziendaCollegata } from "../aziende.js";
import type { RisolviNome } from "../calendario.js";

/** Un'azienda come la vede WhatsApp: solo id e nome. */
export interface AziendaWa { id: string; nome: string }

export const PRIVATO = "privato";
/** Testo breve salvato per ogni messaggio: al massimo 4 KB. */
export const MAX_TESTO_BYTE = 4096;
/** Corpo massimo accettato dal webhook (lo storico può arrivare in blocchi grandi). */
export const MAX_CORPO_WEBHOOK = 2 * 1024 * 1024;
/** Finestra di 24 ore di WhatsApp: fuori si può rispondere solo con un «modello» approvato da Meta. */
export const FINESTRA_MS = 24 * 3600_000;
/** Messaggi dello stesso contatto a meno di 2 minuti l'uno dall'altro: una sola classificazione. */
export const RAGGRUPPA_MS = 2 * 60_000;
/** Al massimo una notifica urgente per contatto ogni 30 minuti. */
export const PAUSA_NOTIFICHE_MS = 30 * 60_000;
/** Testo massimo di una risposta (limite di WhatsApp: 4096 caratteri). */
export const MAX_TESTO_RISPOSTA = 4000;
/**
 * Testo massimo di una risposta proposta dall'AI con una richiesta di conferma: deve stare TUTTO nella domanda
 * di conferma (niente parti nascoste dopo un taglio). Più lungo → rifiutato.
 */
export const MAX_TESTO_CONFERMA = 1000;

export type Provider = "meta" | "bsp";

/** Il collegamento a WhatsApp, salvato nel segreto cifrato «whatsapp». */
export interface CollegamentoWa {
  provider: Provider;
  /** Solo per «bsp» (fornitore, per esempio 360dialog): indirizzo di base. Per «meta» è sempre graph.facebook.com. */
  baseUrl: string;
  /** Versione della Graph API di Meta (per esempio v27.0). */
  versione: string;
  /** Id del numero di telefono su WhatsApp (phone_number_id). */
  phoneNumberId: string;
  /** Meta: token di accesso (Bearer). Fornitore: chiave API. */
  token: string;
  /** Fornitore: nome dell'intestazione con la chiave (per 360dialog «D360-API-KEY»). */
  intestazione: string;
  /** Segreto dell'app di Meta: serve a controllare la firma X-Hub-Signature-256 di ogni webhook. */
  appSecret: string;
  /** Parola di verifica scelta da Luigi, da scrivere anche nel pannello di Meta. */
  verifyToken: string;
}

export interface DipendenzeWhatsapp {
  db: Db;
  cifratore: Cifratore;
  fuso: string;
  cervello: () => Promise<Cervello>;
  modello: string;
  /** Le aziende (id e nome) per attribuire contatti e chat. */
  aziende: () => AziendaWa[];
  /** Le aziende collegate a Costructo (per cercare il numero tra le controparti). */
  aziendeCostructo: () => AziendaCollegata[];
  /** Notifiche push (null = non configurate). */
  invia?: Invia | null;
  /** fetch per l'invio dei messaggi (nei test: un server finto). */
  fetchFn?: typeof fetch;
  ora?: () => number;
  /** Attesa tra un tentativo d'invio e l'altro (nei test: 0). */
  attesaRiprova?: (ms: number) => Promise<void>;
  /** Risoluzione dei nomi (indirizzo del fornitore: niente rete interna). Nei test: finta. */
  risolvi?: RisolviNome;
  /** Fase 3b: fetch verso il fornitore della trascrizione (nei test: uno finto). */
  fetchTrascrizione?: typeof fetch;
}

export interface ContattoWa {
  id: string;
  chiave: string;
  wa_id: string;
  user_id: string;
  nome_profilo: string;
  nome_rubrica: string;
  gruppo: number;
  spazio: string;
  fonte_spazio: string;
  proposta_spazio: string;
  ultima_notifica: number;
  creato: number;
  aggiornato: number;
}

export interface MediaWa { tipo?: string; mime?: string; nomeFile?: string; didascalia?: string; idMedia?: string; sha256?: string; lat?: number; lon?: number }

export interface MessaggioWa {
  id: string;
  wamid: string;
  contatto_id: string;
  gruppo_id: string;
  direzione: "in" | "out" | "eco";
  tipo: string;
  quando: number;
  ricevuto: number;
  testo: string;
  media: string;
  storico: number;
  automatico: number;
  stato_invio: string;
  errore_invio: string;
  revocato: number;
  stato: "da_classificare" | "classificato" | "filtrato" | "tetto" | "errore" | "nessuno";
  riassunto: string;
  urgente: number;
  motivo: string;
  tocca: number;
  tentativi: number;
  notificata: number;
  conferma_auto: string;
}

export interface RispostaWa {
  id: string;
  contatto_id: string;
  tipo: "risposta" | "richiesta_documento";
  testo: string;
  creata: number;
  stato: "proposta" | "bozza" | "in_invio" | "inviata" | "errore" | "incerto" | "scartata";
  wamid: string;
  esito: string;
  inviata: number;
}

export class ErroreWhatsapp extends Error {
  constructor(messaggio: string, readonly stato = 400) { super(messaggio); }
}

/** Invio con esito incerto (tempo scaduto, errore 5xx): il messaggio potrebbe essere partito. Mai ripetere da soli. */
export class InvioIncerto extends ErroreWhatsapp {
  constructor() { super("Esito incerto: WhatsApp non ha risposto in tempo e il messaggio potrebbe essere partito. Controlla sul telefono prima di riprovare.", 502); }
}
