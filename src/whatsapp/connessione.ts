// Stato del collegamento WhatsApp (parte 2, coesistenza con l'app WhatsApp Business):
//  - eventi «account_update» di Meta: PARTNER_REMOVED e ACCOUNT_OFFBOARDED → collegamento interrotto (notifica a Luigi),
//    ACCOUNT_RECONNECTED → di nuovo attivo;
//  - regola dei 14 giorni: se Luigi non apre l'app WhatsApp Business sul telefono per 14 giorni, Meta scollega il numero.
//    Jarvis lo ricorda nel briefing quando non arriva niente (né messaggi né «eco» dal telefono) da 12 giorni;
//  - sincronizzazione di contatti e storico: si fa UNA volta, entro 24 ore dal collegamento (vedi fornitore.ts).
// Qui non ci sono segreti: tutto sta tra i valori interni delle impostazioni (mai restituiti per intero al browser).
import type { Db } from "../db.js";
import { leggiValore, scriviValore } from "../impostazioni.js";
import { inviaATutti } from "../push.js";
import { registra } from "../registro.js";
import type { DipendenzeWhatsapp, Provider } from "./tipi.js";

export const GIORNI_AVVISO_INATTIVITA = 12;
export const TESTO_INTERROTTO = "Il collegamento WhatsApp si è interrotto: apri WhatsApp Business sul telefono.";
export const TESTO_RICOLLEGATO = "WhatsApp è di nuovo collegato a Jarvis.";
/** Eventi che interrompono il collegamento e quelli che lo riaprono. */
export const EVENTI_INTERROTTO = ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"];
export const EVENTI_RICOLLEGATO = ["ACCOUNT_RECONNECTED"];

export interface StatoConnessione {
  provider: Provider;
  /** Quando la chiave (o il token) è stata salvata per questo fornitore: da qui partono le 24 ore della sincronizzazione. */
  collegatoIl: number;
  stato: "attivo" | "interrotto";
  /** Ultimo evento ricevuto (per esempio ACCOUNT_OFFBOARDED) e quando. */
  evento: string;
  quando: number;
}

export function leggiConnessione(db: Db): StatoConnessione | null {
  const v = leggiValore<StatoConnessione | null>(db, "waConnessione");
  return v && typeof v.collegatoIl === "number" ? v : null;
}

/** Il collegamento è appena stato fatto (o è cambiato fornitore): si riparte da capo, sincronizzazione compresa. */
export function segnaCollegato(db: Db, provider: Provider, ora = Date.now()): void {
  const prima = leggiConnessione(db);
  if (prima && prima.provider === provider) return;
  scriviValore(db, "waConnessione", { provider, collegatoIl: ora, stato: "attivo", evento: "", quando: ora } satisfies StatoConnessione);
  scriviValore(db, "waSync", null);
}

export function dimenticaConnessione(db: Db): void {
  scriviValore(db, "waConnessione", null);
  scriviValore(db, "waSync", null);
}

/** Ultimo messaggio dal vivo (ricevuto o scritto da Luigi sul telefono): dice se il collegamento lavora. */
export function ultimaAttivita(db: Db): number {
  const r = db.prepare("SELECT MAX(ricevuto) q FROM wa_messaggi WHERE storico = 0 AND direzione IN ('in','eco')").get() as { q: number | null };
  return r.q ?? 0;
}

/**
 * Un evento «account_update». Interrotto → notifica «apri WhatsApp Business sul telefono» (mai dati personali).
 * Restituisce true se lo stato è cambiato.
 */
export async function applicaEventoAccount(dip: Pick<DipendenzeWhatsapp, "db" | "invia" | "ora">, evento: string): Promise<boolean> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const c = leggiConnessione(db) ?? { provider: "meta" as Provider, collegatoIl: ora, stato: "attivo" as const, evento: "", quando: ora };
  const interrotto = EVENTI_INTERROTTO.includes(evento), ricollegato = EVENTI_RICOLLEGATO.includes(evento);
  const nuovo: StatoConnessione["stato"] = interrotto ? "interrotto" : ricollegato ? "attivo" : c.stato;
  const cambiato = nuovo !== c.stato;
  scriviValore(db, "waConnessione", { ...c, stato: nuovo, evento, quando: ora } satisfies StatoConnessione);
  if (!cambiato) return false;
  registra(db, "whatsapp.collegamento", interrotto ? "errore" : "fatto", "sistema", { evento, stato: nuovo });
  if (dip.invia) {
    await inviaATutti(db, dip.invia, interrotto ? "WhatsApp scollegato" : "WhatsApp collegato", interrotto ? TESTO_INTERROTTO : TESTO_RICOLLEGATO,
      "notifica.whatsapp", "/#impostazioni");
  }
  return true;
}

/** Messaggi dal vivo arrivati: se il collegamento risultava interrotto, ora lavora di nuovo (senza notifiche). */
export function segnaMessaggiInArrivo(db: Db, ora = Date.now()): void {
  const c = leggiConnessione(db);
  if (c && c.stato === "interrotto") scriviValore(db, "waConnessione", { ...c, stato: "attivo", evento: "MESSAGGI_IN_ARRIVO", quando: ora } satisfies StatoConnessione);
}

/** Frasi per il briefing (mai dati personali): collegamento interrotto, oppure niente da 12 giorni. */
export function avvisiConnessione(db: Db, ora = Date.now()): string[] {
  const c = leggiConnessione(db);
  if (!c) return [];
  if (c.stato === "interrotto") return [TESTO_INTERROTTO];
  const ultima = Math.max(ultimaAttivita(db), c.collegatoIl);
  const giorni = Math.floor((ora - ultima) / 864e5);
  if (giorni >= GIORNI_AVVISO_INATTIVITA) {
    return [`WhatsApp: niente di nuovo da ${giorni} giorni. Apri WhatsApp Business sul telefono: va aperta almeno ogni 14 giorni, altrimenti Meta scollega Jarvis.`];
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
