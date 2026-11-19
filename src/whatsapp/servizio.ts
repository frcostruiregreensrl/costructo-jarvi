// Il giro di WhatsApp: parte poco dopo ogni webhook e comunque ogni minuto (un solo giro alla volta).
//  1) azienda dei contatti nuovi (scelta di Luigi → numero in Costructo → domanda a Luigi);
//  2) classificazione (filtro gratuito + Haiku, una chat per richiesta, dopo 2 minuti di silenzio del contatto);
//  3) proposte di risposta «mi manda la fattura?» quando si parla di pagamenti senza documento (da confermare);
//  4) conferme di ricezione automatiche (solo se tutte le regole lo permettono);
//  5) notifiche dei messaggi urgenti (al massimo una ogni 30 minuti per contatto, mai il testo, mai il numero).
// Fase 3b (le 20 funzioni): prima della classificazione i vocali (trascrizione, se accesa) e gli allegati (se lo
// scaricamento è acceso); dopo, l'analisi dei messaggi nuovi → proposte da confermare; poi gli invii automatici dei soli
// tipi accesi da Luigi (spenti di serie) e, ogni 15 minuti, lo stato delle proposte già mandate a Costructo.
// I messaggi dello storico non producono mai notifiche, conferme, domande o classificazioni.
import { registra } from "../registro.js";
import { leggiImpostazioni } from "../impostazioni.js";
import { inviaATutti } from "../push.js";
import { elaboraWebhook, type EsitoElaborazione } from "./elabora.js";
import { attribuisci } from "./attribuzione.js";
import { classificaWhatsapp, testiDi, type EsitoClassificaWa } from "./classifica.js";
import { mandaConfermeWa } from "./rispostaAuto.js";
import { preparaRisposta } from "./risposte.js";
import { leggiContatto, mediaDi, nomeContatto, nomeSpazio, statoChat } from "./archivio.js";
import { leggiCollegamento } from "./collegamento.js";
import { rilasciaInvio } from "./contatore.js";
import { applicaEventoAccount, assicuraDaCollegamento, segnaMessaggiInArrivo } from "./connessione.js";
import { giroVocali, giroAllegati, giroFunzioni, type EsitoFunzioni } from "../funzioni/analisi.js";
import { mandaAutomatiche, aggiornaStatiProposte, recuperaBloccate } from "../proposte/invio.js";
import { PAUSA_NOTIFICHE_MS, PRIVATO, RAGGRUPPA_MS, type ContattoWa, type DipendenzeWhatsapp, type MessaggioWa } from "./tipi.js";

export const OGNI_MS = 60_000;

/** Parole di pagamento (più strette di «soldi o impegni»): fattura, pagamento, bonifico, acconto, saldo, importo, €… */
const PAGAMENTO = /\b(fattur\w*|fatt|ft|pagament\w*|pagat[oaie]|pagare|pagher\w*|bonific\w*|acconto|saldo|import[oi]|rata|rate|iban|invoice|payment|euro)\b|€/i;
export const TESTO_RICHIESTA_DOCUMENTO = "Buongiorno, grazie del messaggio. Per poterle rispondere con precisione, ci può mandare la fattura "
  + "o il documento a cui si riferisce (numero e data)? Grazie.";

/** Messaggi di pagamento senza documento allegato → proposta di risposta (da confermare) che chiede la fattura. */
export function proponiRichiesteDocumento(dip: DipendenzeWhatsapp): number {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const recenti = db.prepare(`SELECT * FROM wa_messaggi WHERE direzione = 'in' AND storico = 0 AND stato = 'classificato' AND tocca = 1
      AND ricevuto > ? ORDER BY ricevuto`).all(ora - 2 * 3600_000) as MessaggioWa[];
  const perContatto = new Map<string, MessaggioWa[]>();
  for (const m of recenti) perContatto.set(m.contatto_id, [...(perContatto.get(m.contatto_id) ?? []), m]);
  let proposte = 0;
  for (const [id, lista] of perContatto) {
    const c = leggiContatto(db, id);
    if (!c || c.gruppo || c.spazio === PRIVATO) continue;
    if (!PAGAMENTO.test(testiDi(lista).join("\n"))) continue;
    // Un documento o una foto arrivati nelle ultime 2 ore bastano: niente richiesta.
    const conDocumento = db.prepare("SELECT COUNT(*) n FROM wa_messaggi WHERE contatto_id = ? AND direzione = 'in' AND tipo IN ('document','image') AND ricevuto > ?").get(id, ora - 2 * 3600_000) as { n: number };
    if (conDocumento.n || lista.some((m) => ["document", "image"].includes(mediaDi(m).tipo ?? ""))) continue;
    const gia = db.prepare("SELECT COUNT(*) n FROM wa_risposte WHERE contatto_id = ? AND tipo = 'richiesta_documento' AND creata > ?").get(id, ora - 7 * 864e5) as { n: number };
    if (gia.n) continue;
    const s = statoChat(db, id, ora);
    if (!s.dentroFinestra || s.ultimaRisposta >= lista[lista.length - 1].quando) continue;
    try {
      preparaRisposta(dip, id, TESTO_RICHIESTA_DOCUMENTO, "richiesta_documento", "proposta");
      proposte++;
    } catch { /* fuori finestra o gruppo: niente */ }
  }
  return proposte;
}

/** Notifiche dei messaggi urgenti: titolo con l'azienda (o «Privato»), testo con il SOLO nome del contatto. */
export async function notificaUrgentiWa(dip: DipendenzeWhatsapp): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const urgenti = db.prepare("SELECT * FROM wa_messaggi WHERE urgente = 1 AND notificata = 0 AND direzione = 'in' AND storico = 0 ORDER BY ricevuto").all() as MessaggioWa[];
  if (!urgenti.length) return 0;
  const segna = db.prepare("UPDATE wa_messaggi SET notificata = 1 WHERE id = ?");
  const perContatto = new Map<string, MessaggioWa[]>();
  for (const m of urgenti) perContatto.set(m.contatto_id, [...(perContatto.get(m.contatto_id) ?? []), m]);
  const nascondi = leggiImpostazioni(db).whatsappNascondiContenuto;
  const aziende = dip.aziende();
  let inviate = 0;
  for (const [id, lista] of perContatto) {
    const c = leggiContatto(db, id);
    if (!c || !dip.invia) { for (const m of lista) segna.run(m.id); continue; }
    if (ora - c.ultima_notifica < PAUSA_NOTIFICHE_MS) continue; // finiscono nella prossima
    const dove = nomeSpazio(c.spazio, aziende);
    const titolo = `WhatsApp urgente · ${dove}`.slice(0, 80);
    // Mai il testo del messaggio, mai il numero. Con «nascondi contenuto» nemmeno il nome del contatto.
    const testo = nascondi ? "Messaggio urgente su WhatsApp." : `${nomeContatto(c)}: messaggio urgente.`;
    await inviaATutti(db, dip.invia, titolo, testo.slice(0, 180), "notifica.whatsapp", "/#whatsapp");
    db.prepare("UPDATE wa_contatti SET ultima_notifica = ? WHERE id = ?").run(ora, id);
    for (const m of lista) segna.run(m.id);
    inviate++;
  }
  return inviate;
}

/**
 * Contatti con messaggi dal vivo e senza azienda: si prova ad attribuirli. Vale anche per quelli con una domanda
 * «Di quale azienda è…?» ancora aperta: se nel frattempo il numero compare in Costructo in una sola azienda,
 * la domanda si chiude da sola (senza nuove notifiche: la domanda aperta non si ripete).
 */
async function attribuisciNuovi(dip: DipendenzeWhatsapp): Promise<number> {
  const { db } = dip;
  const contatti = db.prepare(`SELECT * FROM wa_contatti c WHERE c.spazio = '' AND c.fonte_spazio = ''
      AND EXISTS (SELECT 1 FROM wa_messaggi m WHERE m.contatto_id = c.id AND m.storico = 0) LIMIT 50`).all() as ContattoWa[];
  let n = 0;
  for (const c of contatti) {
    const ricevuti = db.prepare("SELECT COUNT(*) n FROM wa_messaggi WHERE contatto_id = ? AND storico = 0 AND direzione = 'in'").get(c.id) as { n: number };
    await attribuisci(dip, c, ricevuti.n > 0);
    n++;
  }
  return n;
}

export interface EsitoGiroWa {
  attribuiti: number; classifica: EsitoClassificaWa | null; proposte: number; conferme: number; notifiche: number;
  vocali: number; allegati: number; funzioni: EsitoFunzioni | null; automatiche: number;
}
/** Ogni quanto rileggere da Costructo lo stato delle proposte mandate. */
export const OGNI_STATI_MS = 15 * 60_000;

export function creaServizioWhatsapp(dip: DipendenzeWhatsapp) {
  let giro: Promise<EsitoGiroWa> | null = null;
  let coda: Promise<unknown> = Promise.resolve();
  let prossimo: NodeJS.Timeout | null = null;
  let ultimiStati = 0;

  async function faiGiro(): Promise<EsitoGiroWa> {
    const e: EsitoGiroWa = { attribuiti: 0, classifica: null, proposte: 0, conferme: 0, notifiche: 0, vocali: 0, allegati: 0, funzioni: null, automatiche: 0 };
    const passo = async (nome: string, f: () => Promise<void> | void) => {
      try { await f(); } catch (err) { registra(dip.db, nome, "errore", "sistema", { motivo: String((err as Error)?.message || err).slice(0, 200) }); }
    };
    // Parte 2: scheda del collegamento (anche per le installazioni della parte 1), per il promemoria dei 14 giorni.
    await passo("whatsapp.collegamento", () => { assicuraDaCollegamento(dip); });
    await passo("whatsapp.azienda", async () => { e.attribuiti = await attribuisciNuovi(dip); });
    await passo("whatsapp.vocale", async () => { e.vocali = await giroVocali(dip); });
    await passo("whatsapp.allegato", async () => { e.allegati = await giroAllegati(dip); });
    await passo("whatsapp.classifica", async () => { e.classifica = await classificaWhatsapp(dip); });
    await passo("funzioni.analisi", async () => { e.funzioni = await giroFunzioni(dip); });
    await passo("proposta.invio", async () => { e.automatiche = await mandaAutomatiche(dip); });
    const ora = dip.ora?.() ?? Date.now();
    await passo("proposta.invio", async () => { await recuperaBloccate(dip); });
    if (ora - ultimiStati >= OGNI_STATI_MS) { ultimiStati = ora; await passo("proposta.stato", async () => { await aggiornaStatiProposte(dip); }); }
    await passo("whatsapp.risposta", () => { e.proposte = proponiRichiesteDocumento(dip); });
    await passo("whatsapp.conferma_automatica", async () => { e.conferme = await mandaConfermeWa(dip); });
    await passo("notifica.whatsapp", async () => { e.notifiche = await notificaUrgentiWa(dip); });
    return e;
  }

  const servizio = {
    dip,
    /** Un giro adesso (o aspetta quello già in corso). */
    giroOra(): Promise<EsitoGiroWa> {
      giro ??= faiGiro().finally(() => { giro = null; });
      return giro;
    },
    /**
     * Un webhook valido: si elabora DOPO aver risposto a Meta (in coda, uno alla volta).
     * Il giro parte appena il contatto smette di scrivere (2 minuti), così i messaggi vicini si classificano insieme.
     */
    ricevi(corpo: Parameters<typeof elaboraWebhook>[1]): Promise<EsitoElaborazione | null> {
      const lavoro = coda.then(async () => {
        const coll = leggiCollegamento(dip);
        const ora = dip.ora?.() ?? Date.now();
        const esito = elaboraWebhook(dip.db, corpo, coll?.phoneNumberId ?? "", ora);
        if (esito.nuovi || esito.eco || esito.storico) {
          const { eventiAccount: _e, nonConsegnati: _n, ...numeri } = esito;
          registra(dip.db, "whatsapp.ricevuti", "fatto", "sistema", numeri);
        }
        // Parte 2: messaggi dal vivo = il collegamento lavora; eventi dell'account (scollegato, ricollegato…).
        if (esito.nuovi || esito.eco) { assicuraDaCollegamento(dip); segnaMessaggiInArrivo(dip.db, esito.eco > 0, ora); }
        for (const ev of esito.eventiAccount) await applicaEventoAccount(dip, ev);
        for (const x of esito.nonConsegnati) rilasciaInvio(dip.db, dip.fuso, x.tipo, x.quando);
        if (esito.nuovi && !prossimo) {
          prossimo = setTimeout(() => { prossimo = null; servizio.giroOra().catch(() => {}); }, RAGGRUPPA_MS + 5000);
          prossimo.unref();
        }
        return esito;
      }).catch((e) => {
        registra(dip.db, "whatsapp.ricevuti", "errore", "sistema", { motivo: String((e as Error)?.message || e).slice(0, 200) });
        return null;
      });
      coda = lavoro;
      return lavoro;
    },
    /** Aspetta che i webhook in coda siano elaborati (per i test). */
    attendi: () => coda,
    avvia(): void {
      setInterval(() => { servizio.giroOra().catch(() => {}); }, OGNI_MS).unref();
    },
    ferma(): void { if (prossimo) clearTimeout(prossimo); prossimo = null; },
  };
  return servizio;
}
export type ServizioWhatsapp = ReturnType<typeof creaServizioWhatsapp>;
