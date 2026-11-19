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

/**
 * Come si collega WhatsApp (Fase 3, parte 2):
 *  - «meta»: direttamente con la Cloud API di Meta. Webhook firmato da Meta (X-Hub-Signature-256, segreto dell'app).
 *  - «360dialog»: tramite il fornitore 360dialog (serve per la «coesistenza» con l'app WhatsApp Business).
 *    I messaggi hanno lo stesso formato di Meta, ma NON sono firmati con un segreto nostro: il webhook si
 *    controlla con un'intestazione segreta che Jarvis sceglie e scrive lui stesso nella configurazione di 360dialog.
 * Un vecchio «bsp» salvato nella parte 1 si legge come «360dialog».
 */
export type Provider = "meta" | "360dialog";

/** Il collegamento a WhatsApp, salvato nel segreto cifrato «whatsapp». */
export interface CollegamentoWa {
  provider: Provider;
  /** Solo per «360dialog»: indirizzo di base (di serie https://waba-v2.360dialog.io). Per «meta» è sempre graph.facebook.com. */
  baseUrl: string;
  /** Versione della Graph API di Meta (per esempio v27.0). */
  versione: string;
  /** Id del numero di telefono su WhatsApp (phone_number_id). Per 360dialog serve solo a scartare i messaggi di altri numeri. */
  phoneNumberId: string;
  /** Meta: token di accesso (Bearer). 360dialog: chiave API del numero (intestazione D360-API-KEY). */
  token: string;
  /** Segreto dell'app di Meta: serve a controllare la firma X-Hub-Signature-256 di ogni webhook (obbligatorio con «meta»). */
  appSecret: string;
  /** Parola di verifica scelta da Luigi, da scrivere anche nel pannello di Meta (solo «meta»). */
  verifyToken: string;
  /**
   * Solo «360dialog»: segreto casuale (32 byte) che Jarvis genera e manda lui a 360dialog quando configura il webhook.
   * 360dialog lo rimanda in ogni webhook nell'intestazione X-Jarvis-Segreto. Luigi non lo vede mai.
   */
  webhookSecret: string;
  /**
   * Segreti precedenti ancora validi per poco (al massimo 2, un'ora ciascuno). Ci sono SOLO dopo un cambio con esito
   * incerto (non si sa se 360dialog ha preso il nuovo); dopo un cambio confermato si svuota subito.
   */
  segretiPrecedenti: Array<{ segreto: string; fino: number }>;
  /** Quando Jarvis ha configurato il webhook su 360dialog (0 = mai). */
  webhookConfigurato: number;
  /** [non verificato] Percorso della prova di collegamento su 360dialog (di serie /health_status). */
  percorsoSalute: string;
  /** [non verificato] Percorso della sincronizzazione di contatti e storico su 360dialog (di serie /smb_app_data). */
  percorsoSync: string;
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

/**
 * Errore 131060 di WhatsApp (coesistenza): il messaggio non arriverà a quel contatto (primo messaggio a un contatto nuovo,
 * dispositivo non supportato). Non si riprova: né Jarvis né un pulsante «manda di nuovo».
 */
export class NonConsegnabile extends ErroreWhatsapp {
  constructor(messaggio: string) { super(messaggio, 422); }
}
export const CODICE_NON_CONSEGNABILE = 131060;

/** Invio con esito incerto (tempo scaduto, errore 5xx): il messaggio potrebbe essere partito. Mai ripetere da soli. */
export class InvioIncerto extends ErroreWhatsapp {
  constructor() { super("Esito incerto: WhatsApp non ha risposto in tempo e il messaggio potrebbe essere partito. Controlla sul telefono prima di riprovare.", 502); }
}
