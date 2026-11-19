// Stato del collegamento WhatsApp (parte 2, coesistenza con l'app WhatsApp Business):
//  - eventi «account_update» di Meta: PARTNER_REMOVED e ACCOUNT_OFFBOARDED → collegamento interrotto (notifica a Luigi),
//    ACCOUNT_RECONNECTED → di nuovo attivo;
//  - regola dei 14 giorni: se Luigi non apre l'app WhatsApp Business sul telefono per 14 giorni, Meta scollega il numero.
//    Jarvis lo ricorda nel briefing quando da 12 giorni non arriva nessuna «eco» (messaggio scritto da Luigi sul telefono);
//    i messaggi dei contatti non contano. Solo per i numeri in coesistenza (360dialog, o Meta con is_on_biz_app);
//  - sincronizzazione di contatti e storico: si fa UNA volta, entro 24 ore dal collegamento (vedi fornitore.ts).
// Qui non ci sono segreti: tutto sta tra i valori interni delle impostazioni (mai restituiti per intero al browser).
import type { Db } from "../db.js";
import { leggiValore, scriviValore } from "../impostazioni.js";
import { inviaATutti } from "../push.js";
import { registra } from "../registro.js";
import { invioPronto, leggiCollegamento, webhookAttivo } from "./collegamento.js";
import type { DipendenzeWhatsapp, Provider } from "./tipi.js";

export const GIORNI_AVVISO_INATTIVITA = 12;
export const TESTO_INTERROTTO = "Il collegamento WhatsApp si è interrotto: apri WhatsApp Business sul telefono.";
export const TESTO_RICOLLEGATO = "WhatsApp è di nuovo collegato a Jarvis.";
/** Eventi che interrompono il collegamento e quelli che lo riaprono. */
export const EVENTI_INTERROTTO = ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"];
export const EVENTI_RICOLLEGATO = ["ACCOUNT_RECONNECTED"];

export interface StatoConnessione {
  provider: Provider;
  /** Id del numero (phone_number_id) quando è noto: un numero diverso = collegamento nuovo. */
  numero: string;
  /** Da quando Jarvis conosce questo collegamento: da qui partono le 24 ore della sincronizzazione. */
  collegatoIl: number;
  stato: "attivo" | "interrotto";
  /** Ultimo evento ricevuto (per esempio ACCOUNT_OFFBOARDED) e quando. */
  evento: string;
  quando: number;
  /**
   * Il numero è in coesistenza con l'app WhatsApp Business? Con 360dialog sì (è il motivo per cui si usa);
   * con Meta diretto solo se la prova lo dice (is_on_biz_app) o se arrivano «eco» dal telefono. null = non si sa.
   */
  coesistenza: boolean | null;
}

export function leggiConnessione(db: Db): StatoConnessione | null {
  const v = leggiValore<Partial<StatoConnessione> | null>(db, "waConnessione");
  if (!v || typeof v.collegatoIl !== "number") return null;
  return {
    provider: v.provider === "meta" ? "meta" : "360dialog", numero: typeof v.numero === "string" ? v.numero : "", collegatoIl: v.collegatoIl,
    stato: v.stato === "interrotto" ? "interrotto" : "attivo", evento: typeof v.evento === "string" ? v.evento : "", quando: Number(v.quando) || 0,
    coesistenza: typeof v.coesistenza === "boolean" ? v.coesistenza : v.provider === "meta" ? null : true,
  };
}
const scriviConnessione = (db: Db, c: StatoConnessione) => scriviValore(db, "waConnessione", c);

/**
 * Il collegamento c'è: se Jarvis non lo conosceva ancora (per esempio un'installazione della parte 1, o un evento arrivato
 * prima di un «Salva») crea la scheda SENZA toccare la sincronizzazione già fatta. Si riparte da capo (sincronizzazione
 * compresa) SOLO se prima c'era una scheda con un fornitore diverso o un altro numero.
 */
export function assicuraConnessione(db: Db, provider: Provider, numero = "", ora = Date.now()): StatoConnessione {
  const prima = leggiConnessione(db);
  const nuova = (): StatoConnessione => ({ provider, numero, collegatoIl: ora, stato: "attivo", evento: "", quando: ora, coesistenza: provider === "360dialog" ? true : null });
  if (!prima) { const c = nuova(); scriviConnessione(db, c); return c; }
  if (prima.provider !== provider || (prima.numero && numero && prima.numero !== numero)) {
    const c = nuova();
    scriviConnessione(db, c);
    scriviValore(db, "waSync", null);
    return c;
  }
  if (!prima.numero && numero) { const c = { ...prima, numero }; scriviConnessione(db, c); return c; }
  return prima;
}

/** Collegamento attuale (dal segreto cifrato) → scheda della connessione, creata se manca. null se non è collegato. */
export function assicuraDaCollegamento(dip: Pick<DipendenzeWhatsapp, "db" | "cifratore" | "ora">): StatoConnessione | null {
  const coll = leggiCollegamento(dip);
  if (!coll || !(invioPronto(coll) || webhookAttivo(coll))) return leggiConnessione(dip.db);
  return assicuraConnessione(dip.db, coll.provider, coll.phoneNumberId, dip.ora?.() ?? Date.now());
}

export function dimenticaConnessione(db: Db): void {
  scriviValore(db, "waConnessione", null);
  scriviValore(db, "waSync", null);
}

/** Ultimo messaggio dal vivo (ricevuto o scritto da Luigi sul telefono): da mostrare in Impostazioni. */
export function ultimaAttivita(db: Db): number {
  const r = db.prepare("SELECT MAX(ricevuto) q FROM wa_messaggi WHERE storico = 0 AND direzione IN ('in','eco')").get() as { q: number | null };
  return r.q ?? 0;
}
/** Ultimo messaggio che Luigi ha scritto dal telefono («eco»): è questo che dice se apre l'app WhatsApp Business. */
export function ultimaEco(db: Db): number {
  const r = db.prepare("SELECT MAX(ricevuto) q FROM wa_messaggi WHERE storico = 0 AND direzione = 'eco'").get() as { q: number | null };
  return r.q ?? 0;
}

/** La prova del collegamento (Meta: is_on_biz_app) dice se il numero è in coesistenza. */
export function segnaCoesistenza(dip: Pick<DipendenzeWhatsapp, "db" | "cifratore" | "ora">, valore: boolean): void {
  const c = assicuraDaCollegamento(dip);
  if (c) scriviConnessione(dip.db, { ...c, coesistenza: valore });
}

/**
 * Un evento «account_update». Interrotto → notifica «apri WhatsApp Business sul telefono» (mai dati personali).
 * Il fornitore è quello configurato (la scheda si crea se manca). Restituisce true se lo stato è cambiato.
 */
export async function applicaEventoAccount(dip: Pick<DipendenzeWhatsapp, "db" | "cifratore" | "invia" | "ora">, evento: string): Promise<boolean> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const coll = leggiCollegamento(dip);
  const c = coll ? assicuraConnessione(db, coll.provider, coll.phoneNumberId, ora) : leggiConnessione(db);
  if (!c) { registra(db, "whatsapp.collegamento", "negato", "sistema", { evento, motivo: "WhatsApp non collegato" }); return false; }
  const interrotto = EVENTI_INTERROTTO.includes(evento), ricollegato = EVENTI_RICOLLEGATO.includes(evento);
  const nuovo: StatoConnessione["stato"] = interrotto ? "interrotto" : ricollegato ? "attivo" : c.stato;
  const cambiato = nuovo !== c.stato;
  scriviConnessione(db, { ...c, stato: nuovo, evento, quando: ora });
  if (!cambiato) return false;
  registra(db, "whatsapp.collegamento", interrotto ? "errore" : "fatto", "sistema", { evento, stato: nuovo });
  if (dip.invia) {
    await inviaATutti(db, dip.invia, interrotto ? "WhatsApp scollegato" : "WhatsApp collegato", interrotto ? TESTO_INTERROTTO : TESTO_RICOLLEGATO,
      "notifica.whatsapp", "/#impostazioni");
  }
  return true;
}

/**
 * Messaggi dal vivo arrivati: se il collegamento risultava interrotto, ora lavora di nuovo (senza notifiche).
 * Un'«eco» (Luigi ha scritto dal telefono) dice anche che il numero è in coesistenza.
 */
export function segnaMessaggiInArrivo(db: Db, eco: boolean, ora = Date.now()): void {
  const c = leggiConnessione(db);
  if (!c) return;
  if (c.stato === "interrotto" || (eco && c.coesistenza !== true)) {
    scriviConnessione(db, { ...c, ...(c.stato === "interrotto" ? { stato: "attivo" as const, evento: "MESSAGGI_IN_ARRIVO", quando: ora } : {}), ...(eco ? { coesistenza: true } : {}) });
  }
}

/**
 * Frasi per il briefing (mai dati personali): collegamento interrotto, oppure nessun messaggio scritto da Luigi sul telefono
 * da 12 giorni. I messaggi dei contatti NON contano (arrivano anche se Luigi non apre l'app). Solo per i numeri in coesistenza.
 */
export function avvisiConnessione(db: Db, ora = Date.now()): string[] {
  const c = leggiConnessione(db);
  if (!c) return [];
  if (c.stato === "interrotto") return [TESTO_INTERROTTO];
  if (c.coesistenza !== true) return [];
  const ultima = Math.max(ultimaEco(db), c.collegatoIl);
  const giorni = Math.floor((ora - ultima) / 864e5);
  if (giorni >= GIORNI_AVVISO_INATTIVITA) {
    return [`WhatsApp: da ${giorni} giorni non scrivi dall'app WhatsApp Business. Aprila sul telefono: va aperta almeno ogni 14 giorni, altrimenti Meta scollega Jarvis.`];
  }
  return [];
}

// ---------------------------------------------------------------- stato della sincronizzazione (una volta sola)
export type PassoSync = "contatti" | "storico";
export interface StatoPasso { stato: "mai" | "fatto" | "errore" | "incerto"; quando: number; esito: string }
export type StatoSync = Record<PassoSync, StatoPasso>;

const MAI: StatoPasso = { stato: "mai", quando: 0, esito: "" };

export function leggiSync(db: Db): StatoSync {
  const v = leggiValore<Partial<StatoSync> | null>(db, "waSync") ?? {};
  return { contatti: v.contatti ?? MAI, storico: v.storico ?? MAI };
}
export function scriviPasso(db: Db, passo: PassoSync, s: StatoPasso): void {
  scriviValore(db, "waSync", { ...leggiSync(db), [passo]: s });
}
export const syncFatta = (s: StatoSync) => s.contatti.stato === "fatto" && s.storico.stato === "fatto";
