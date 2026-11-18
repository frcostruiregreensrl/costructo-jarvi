// Conversazioni: tenute 30 giorni, poi cancellate in automatico.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Vista } from "./memorie.js";

export const CONSERVAZIONE_MS = 30 * 24 * 3600_000;
export interface Messaggio { ruolo: "utente" | "jarvis"; testo: string; creato: number }

export function apriConversazione(db: Db, vista: Vista, id?: string, ora = Date.now()): string {
  if (id) {
    const c = db.prepare("SELECT id FROM conversazioni WHERE id = ? AND spazio = ?").get(id, vista) as { id: string } | undefined;
    if (c) return c.id;
  }
  const nuovo = randomUUID();
  db.prepare("INSERT INTO conversazioni (id, spazio, creata, aggiornata) VALUES (?,?,?,?)").run(nuovo, vista, ora, ora);
  return nuovo;
}

export function aggiungiMessaggio(db: Db, conversazione: string, ruolo: Messaggio["ruolo"], testo: string, ora = Date.now()): void {
  db.prepare("INSERT INTO messaggi (conversazione_id, ruolo, testo, creato) VALUES (?,?,?,?)").run(conversazione, ruolo, testo.slice(0, 8000), ora);
  db.prepare("UPDATE conversazioni SET aggiornata = ? WHERE id = ?").run(ora, conversazione);
}

export function ultimiMessaggi(db: Db, conversazione: string, quanti = 12): Messaggio[] {
  const righe = db.prepare("SELECT ruolo, testo, creato FROM messaggi WHERE conversazione_id = ? ORDER BY id DESC LIMIT ?").all(conversazione, quanti) as Messaggio[];
  return righe.reverse();
}

export function elencaConversazioni(db: Db, vista: Vista, limite = 30) {
  return db.prepare(`SELECT c.id, c.spazio, c.aggiornata,
      (SELECT testo FROM messaggi m WHERE m.conversazione_id = c.id ORDER BY m.id ASC LIMIT 1) AS inizio
    FROM conversazioni c WHERE c.spazio = ? ORDER BY c.aggiornata DESC LIMIT ?`).all(vista, limite);
}

/** Cancella messaggi più vecchi di 30 giorni e conversazioni rimaste vuote. Restituisce quanti messaggi ha tolto. */
export function pulisciConversazioniVecchie(db: Db, ora = Date.now()): number {
  const limite = ora - CONSERVAZIONE_MS;
  return db.transaction(() => {
    const tolti = db.prepare("DELETE FROM messaggi WHERE creato < ?").run(limite).changes;
    db.prepare("DELETE FROM conversazioni WHERE aggiornata < ? AND NOT EXISTS (SELECT 1 FROM messaggi m WHERE m.conversazione_id = conversazioni.id)").run(limite);
    db.prepare("DELETE FROM conferme WHERE creata < ?").run(limite);
    return tolti;
  })();
}
