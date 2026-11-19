// Messaggi mandati da Jarvis con la API di WhatsApp (risposte confermate, conferme automatiche, modelli):
//  - contatore del mese, mostrato in «Spesa del mese» con una STIMA del costo;
//  - tetto mensile (di serie 900) che blocca SOLO gli invii di Jarvis: i messaggi che Luigi scrive dal telefono
//    non passano da qui, non si contano e restano gratis;
//  - limite di velocità: al massimo 20 messaggi al secondo (limite di WhatsApp per numero).
// Da ottobre 2026 Meta fa pagare anche le risposte dentro le 24 ore oltre le prime 1.000 del mese per numero:
// prezzo di serie 0,0248 € l'una (si può cambiare in Impostazioni). I modelli si pagano a parte, sempre (prezzo di serie
// 0,03 €, da verificare sul listino di Meta). È una stima: il conto vero lo fa Meta (o 360dialog).
import type { Db } from "../db.js";
import { leggiImpostazioni } from "../impostazioni.js";
import { meseDi } from "../consumi.js";
import { ErroreWhatsapp } from "./tipi.js";

export type TipoInvioApi = "risposta" | "conferma" | "modello";
/** Messaggi al mese per numero che Meta non fa pagare (risposte dentro le 24 ore). */
export const SOGLIA_GRATUITA = 1000;

export interface ContatoreInvio { db: Db; fuso: string; tipo: TipoInvioApi; ora?: number }

export class TettoMessaggi extends ErroreWhatsapp {
  constructor(tetto: number) {
    super(`Ho raggiunto il tetto di ${tetto} messaggi mandati da Jarvis su WhatsApp questo mese: non ho mandato niente. `
      + "Puoi rispondere tu dal telefono (gratis) oppure alzare il tetto in Impostazioni → WhatsApp.", 409);
  }
}

/**
 * Prenota un invio: se il tetto del mese è raggiunto lancia TettoMessaggi (e non parte niente), altrimenti conta +1.
 * Tutto in una transazione: due invii insieme non sfondano il tetto. Restituisce la funzione che annulla la prenotazione
 * (da chiamare SOLO quando il messaggio sicuramente non è partito).
 */
export function prenotaInvio(c: ContatoreInvio): () => void {
  const mese = meseDi(c.ora ?? Date.now(), c.fuso);
  const tetto = leggiImpostazioni(c.db).whatsappTettoMessaggiMese;
  c.db.transaction(() => {
    const n = (c.db.prepare("SELECT COALESCE(SUM(n),0) n FROM wa_invii_api WHERE mese = ?").get(mese) as { n: number }).n;
    if (n >= tetto) throw new TettoMessaggi(tetto);
    c.db.prepare("INSERT INTO wa_invii_api (mese, tipo, n) VALUES (?,?,1) ON CONFLICT(mese, tipo) DO UPDATE SET n = n + 1").run(mese, c.tipo);
  })();
  let annullato = false;
  return () => {
    if (annullato) return;
    annullato = true;
    c.db.prepare("UPDATE wa_invii_api SET n = MAX(0, n - 1) WHERE mese = ? AND tipo = ?").run(mese, c.tipo);
  };
}

/** Toglie dal mese un messaggio che sicuramente non è arrivato (errore 131060 dal webhook). */
export function rilasciaInvio(db: Db, fuso: string, tipo: TipoInvioApi, quando: number): void {
  db.prepare("UPDATE wa_invii_api SET n = MAX(0, n - 1) WHERE mese = ? AND tipo = ?").run(meseDi(quando, fuso), tipo);
}

export interface RiepilogoInviiWa {
  mese: string;
  inviati: number;
  perTipo: Record<TipoInvioApi, number>;
  tetto: number;
  raggiunto: boolean;
  sogliaGratuita: number;
  /** Prezzo stimato di una risposta oltre le 1.000 gratuite. */
  prezzoEur: number;
  /** Prezzo stimato di un modello (i modelli si pagano sempre, fuori dalle 1.000 risposte gratuite). */
  prezzoModelloEur: number;
  /**
   * Stima: (risposte + conferme − 1.000) × prezzo, mai sotto zero, PIÙ modelli × prezzo del modello.
   * I modelli non rientrano nei 1.000 messaggi di servizio gratuiti.
   */
  stimaEur: number;
}

export function riepilogoInviiWa(db: Db, fuso: string, ora = Date.now()): RiepilogoInviiWa {
  const mese = meseDi(ora, fuso);
  const imp = leggiImpostazioni(db);
  const righe = db.prepare("SELECT tipo, n FROM wa_invii_api WHERE mese = ?").all(mese) as Array<{ tipo: TipoInvioApi; n: number }>;
  const perTipo: Record<TipoInvioApi, number> = { risposta: 0, conferma: 0, modello: 0 };
  for (const r of righe) if (r.tipo in perTipo) perTipo[r.tipo] = r.n;
  const inviati = perTipo.risposta + perTipo.conferma + perTipo.modello;
  const servizio = perTipo.risposta + perTipo.conferma;
  const stima = Math.max(0, servizio - SOGLIA_GRATUITA) * imp.whatsappPrezzoMessaggioEur + perTipo.modello * imp.whatsappPrezzoModelloEur;
  return {
    mese, inviati, perTipo, tetto: imp.whatsappTettoMessaggiMese, raggiunto: inviati >= imp.whatsappTettoMessaggiMese,
    sogliaGratuita: SOGLIA_GRATUITA, prezzoEur: imp.whatsappPrezzoMessaggioEur, prezzoModelloEur: imp.whatsappPrezzoModelloEur,
    stimaEur: Math.round(stima * 100) / 100,
  };
}

// ---------------------------------------------------------------- limite di velocità (20 messaggi al secondo)
export const MAX_AL_SECONDO = 20;

export interface Limitatore { attendiTurno(): Promise<void> }

/**
 * Finestra scorrevole: al massimo `massimo` partenze in `finestraMs`. Chi arriva oltre aspetta il suo turno
 * (in ordine). Orologio e attesa si possono sostituire nei test.
 */
export function creaLimitatore(massimo = MAX_AL_SECONDO, finestraMs = 1000, ora: () => number = Date.now,
  attesa: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Limitatore {
  const partenze: number[] = [];
  let coda: Promise<void> = Promise.resolve();
  return {
    attendiTurno() {
      const turno = coda.then(async () => {
        for (;;) {
          const t = ora();
          while (partenze.length && t - partenze[0] >= finestraMs) partenze.shift();
          if (partenze.length < massimo) { partenze.push(t); return; }
          await attesa(finestraMs - (t - partenze[0]));
        }
      });
      coda = turno.catch(() => {});
      return turno;
    },
  };
}

/** Il limitatore di tutto il processo (un solo numero WhatsApp). */
export const limitatoreWhatsapp = creaLimitatore();
