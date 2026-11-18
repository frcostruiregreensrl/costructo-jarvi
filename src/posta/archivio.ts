// Archivio delle mail lette da Jarvis (tabella posta_messaggi): al massimo 30 giorni, poi si cancella tutto.
// Si salvano solo intestazioni, un testo breve (4 KB), i nomi degli allegati e i campi di Jarvis.
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { CONSERVAZIONE_MS } from "../conversazioni.js";
import type { MailLetta } from "./analisi.js";
import type { MessaggioPosta, Segni } from "./tipi.js";

export function nuovoId(prefisso: string): string { return `${prefisso}${randomBytes(5).toString("hex")}`; }

export interface DatiNuovo { casellaId: string; uid: number; uidValidity: string; spazio: string; nuova: boolean; mail: MailLetta }

/** Salva una mail (una sola volta per casella + UIDVALIDITY + UID). Restituisce l'id oppure null se c'era già. */
export function salvaMessaggio(db: Db, d: DatiNuovo, ora = Date.now()): string | null {
  const id = nuovoId("m");
  const m = d.mail;
  const r = db.prepare(`INSERT OR IGNORE INTO posta_messaggi (id, casella_id, uid, uid_validity, message_id, riferimenti, da_nome, da_indirizzo, rispondi_a,
      a, oggetto, data, estratto, allegati, segni, spazio, nuova, salvato) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, d.casellaId, d.uid, d.uidValidity, m.messageId, m.riferimenti, m.daNome, m.daIndirizzo, m.rispondiA, m.a, m.oggetto, m.data,
      m.estratto, JSON.stringify(m.allegati), JSON.stringify(m.segni), d.spazio, d.nuova ? 1 : 0, ora);
  return r.changes ? id : null;
}

/**
 * Se la casella ha già una mail con lo stesso Message-ID (per esempio dopo un cambio di UIDVALIDITY sul server),
 * non se ne crea una copia: si aggiornano solo UID e UIDVALIDITY. Restituisce true se l'ha trovata.
 */
export function riallineaMessaggio(db: Db, casellaId: string, messageId: string, uid: number, uidValidity: string): boolean {
  if (!messageId) return false;
  const r = db.prepare("SELECT id FROM posta_messaggi WHERE casella_id = ? AND message_id = ? ORDER BY salvato LIMIT 1").get(casellaId, messageId) as { id: string } | undefined;
  if (!r) return false;
  db.prepare("UPDATE OR IGNORE posta_messaggi SET uid = ?, uid_validity = ? WHERE id = ?").run(uid, uidValidity, r.id);
  return true;
}

export function leggiMessaggio(db: Db, id: string): MessaggioPosta | undefined {
  return db.prepare("SELECT * FROM posta_messaggi WHERE id = ?").get(id) as MessaggioPosta | undefined;
}

export const segniDi = (m: Pick<MessaggioPosta, "segni">): Segni => { try { return JSON.parse(m.segni) as Segni; } catch { return {}; } };
export const allegatiDi = (m: Pick<MessaggioPosta, "allegati">): Array<{ nome: string; dimensione: number }> => { try { return JSON.parse(m.allegati); } catch { return []; } };

export interface Filtri {
  /** Spazi ammessi (id delle aziende e/o «privato»). */
  spazi: string[];
  caselle?: string[];
  soloUrgenti?: boolean;
  giorni?: number;
  testo?: string;
  mittente?: string;
  limite?: number;
}

/** Elenco delle mail (dalla più recente) secondo i filtri. Senza spazi ammessi non restituisce niente. */
export function elencaMessaggi(db: Db, f: Filtri, ora = Date.now()): MessaggioPosta[] {
  if (!f.spazi.length) return [];
  const dove: string[] = [`spazio IN (${f.spazi.map(() => "?").join(",")})`];
  const valori: unknown[] = [...f.spazi];
  if (f.caselle?.length) { dove.push(`casella_id IN (${f.caselle.map(() => "?").join(",")})`); valori.push(...f.caselle); }
  if (f.soloUrgenti) dove.push("urgente = 1");
  if (f.giorni) { dove.push("data >= ?"); valori.push(ora - f.giorni * 864e5); }
  const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (f.testo?.trim()) {
    for (const parola of f.testo.trim().split(/\s+/).slice(0, 6)) {
      dove.push("(oggetto LIKE ? ESCAPE '\\' OR da_nome LIKE ? ESCAPE '\\' OR da_indirizzo LIKE ? ESCAPE '\\' OR estratto LIKE ? ESCAPE '\\' OR riassunto LIKE ? ESCAPE '\\')");
      const l = like(parola);
      valori.push(l, l, l, l, l);
    }
  }
  if (f.mittente?.trim()) {
    dove.push("(da_nome LIKE ? ESCAPE '\\' OR da_indirizzo LIKE ? ESCAPE '\\')");
    valori.push(like(f.mittente.trim()), like(f.mittente.trim()));
  }
  const limite = Math.max(1, Math.min(200, f.limite ?? 30));
  return db.prepare(`SELECT * FROM posta_messaggi WHERE ${dove.join(" AND ")} ORDER BY data DESC LIMIT ${limite}`).all(...valori) as MessaggioPosta[];
}

/** Cancella le mail (e le bozze, e le tracce delle conferme automatiche) più vecchie di 30 giorni. */
export function pulisciPostaVecchia(db: Db, ora = Date.now()): number {
  const limite = ora - CONSERVAZIONE_MS;
  return db.transaction(() => {
    const tolti = db.prepare("DELETE FROM posta_messaggi WHERE salvato < ?").run(limite).changes;
    db.prepare("DELETE FROM posta_bozze WHERE creata < ?").run(limite);
    db.prepare("DELETE FROM posta_risposte_auto WHERE quando < ?").run(limite);
    return tolti;
  })();
}

// ---------------------------------------------------------------- stato della lettura per casella
export interface StatoLettura { uidValidity: string; ultimoUid: number; ultimaNotifica: number }

export function leggiStatoLettura(db: Db, casellaId: string): StatoLettura | null {
  const r = db.prepare("SELECT uid_validity, ultimo_uid, ultima_notifica FROM posta_stato WHERE casella_id = ?").get(casellaId) as { uid_validity: string; ultimo_uid: number; ultima_notifica: number } | undefined;
  return r ? { uidValidity: r.uid_validity, ultimoUid: r.ultimo_uid, ultimaNotifica: r.ultima_notifica } : null;
}
export function scriviStatoLettura(db: Db, casellaId: string, s: { uidValidity?: string; ultimoUid?: number; esito: "ok" | "errore"; messaggio: string }, ora = Date.now()): void {
  db.prepare(`INSERT INTO posta_stato (casella_id, uid_validity, ultimo_uid, ultimo_controllo, esito, messaggio) VALUES (?,?,?,?,?,?)
    ON CONFLICT(casella_id) DO UPDATE SET uid_validity = COALESCE(?, uid_validity), ultimo_uid = COALESCE(?, ultimo_uid),
    ultimo_controllo = excluded.ultimo_controllo, esito = excluded.esito, messaggio = excluded.messaggio`)
    .run(casellaId, s.uidValidity ?? "", s.ultimoUid ?? 0, ora, s.esito, s.messaggio.slice(0, 300), s.uidValidity ?? null, s.ultimoUid ?? null);
}
export function segnaNotifica(db: Db, casellaId: string, ora = Date.now()): void {
  db.prepare("UPDATE posta_stato SET ultima_notifica = ? WHERE casella_id = ?").run(ora, casellaId);
}
