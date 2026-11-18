// Archivio di WhatsApp in Jarvis: contatti, messaggi (testo breve), risposte, domande. Al massimo 30 giorni.
// Lo stesso messaggio (stesso id di WhatsApp) non si salva mai due volte: i webhook ripetuti non fanno danni.
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { CONSERVAZIONE_MS } from "../conversazioni.js";
import { PRIVATO, FINESTRA_MS, type AziendaWa, type ContattoWa, type MediaWa, type MessaggioWa, type RispostaWa } from "./tipi.js";
import { mascheraTelefono } from "./telefono.js";

export const nuovoId = (prefisso: string) => `${prefisso}${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------- contatti
export interface DatiContatto { waId?: string; userId?: string; nomeProfilo?: string; nomeRubrica?: string | null; gruppo?: boolean }

/** Chiave del contatto: il numero se c'è, altrimenti l'id utente di WhatsApp; per i gruppi l'id del gruppo. */
export function chiaveContatto(d: { waId?: string; userId?: string; gruppoId?: string }): string | null {
  if (d.gruppoId) return `g:${d.gruppoId}`;
  if (d.waId) return d.waId;
  if (d.userId) return `u:${d.userId}`;
  return null;
}

export function leggiContatto(db: Db, id: string): ContattoWa | undefined {
  return db.prepare("SELECT * FROM wa_contatti WHERE id = ?").get(id) as ContattoWa | undefined;
}

/**
 * Trova o crea il contatto. Se c'è il numero ma il contatto era noto solo con l'id utente (o viceversa),
 * si ricongiungono. Aggiorna i nomi quando arrivano.
 */
export function salvaContatto(db: Db, d: DatiContatto & { gruppoId?: string }, ora = Date.now()): ContattoWa | null {
  const chiave = chiaveContatto(d);
  if (!chiave) return null;
  let c = db.prepare("SELECT * FROM wa_contatti WHERE chiave = ?").get(chiave) as ContattoWa | undefined;
  // Numero e id utente portano a due contatti diversi (prima noto solo con l'id, poi con il numero): si uniscono.
  if (c && !d.gruppoId && d.waId && d.userId) {
    const doppio = db.prepare("SELECT * FROM wa_contatti WHERE user_id = ? AND gruppo = 0 AND id <> ?").get(d.userId, c.id) as ContattoWa | undefined;
    if (doppio) c = unisciContatti(db, c, doppio, ora);
  }
  if (!c && !d.gruppoId && d.waId && d.userId) c = db.prepare("SELECT * FROM wa_contatti WHERE user_id = ? AND gruppo = 0").get(d.userId) as ContattoWa | undefined;
  if (!c && !d.gruppoId && d.userId && !d.waId) c = db.prepare("SELECT * FROM wa_contatti WHERE user_id = ? AND gruppo = 0").get(d.userId) as ContattoWa | undefined;
  if (!c) {
    const id = nuovoId("c");
    db.prepare(`INSERT INTO wa_contatti (id, chiave, wa_id, user_id, nome_profilo, nome_rubrica, gruppo, creato, aggiornato) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, chiave, d.waId ?? "", d.userId ?? "", d.nomeProfilo ?? "", d.nomeRubrica ?? "", d.gruppo || d.gruppoId ? 1 : 0, ora, ora);
    return leggiContatto(db, id)!;
  }
  const waId = c.wa_id || d.waId || "";
  db.prepare(`UPDATE OR IGNORE wa_contatti SET wa_id = ?, user_id = ?, chiave = ?, nome_profilo = ?, nome_rubrica = ?, aggiornato = ? WHERE id = ?`)
    .run(waId, c.user_id || d.userId || "", c.gruppo ? c.chiave : (waId || c.chiave), d.nomeProfilo || c.nome_profilo,
      d.nomeRubrica === null ? "" : d.nomeRubrica || c.nome_rubrica, ora, c.id);
  return leggiContatto(db, c.id)!;
}

/**
 * Unisce `doppio` dentro `tenuto` (quello con il numero): messaggi, risposte, conferme e domande passano a `tenuto`,
 * poi `doppio` si cancella. La scelta di Luigi sull'azienda resta: se ne ha fatta una sola, vale quella; se sono due
 * diverse, si tiene quella del contatto con il numero e si apre una domanda «Di quale azienda è…?».
 */
export function unisciContatti(db: Db, tenuto: ContattoWa, doppio: ContattoWa, ora = Date.now()): ContattoWa {
  db.transaction(() => {
    for (const t of ["wa_messaggi", "wa_risposte", "wa_conferme_auto", "wa_domande"]) db.prepare(`UPDATE ${t} SET contatto_id = ? WHERE contatto_id = ?`).run(tenuto.id, doppio.id);
    const luigiT = tenuto.fonte_spazio === "luigi", luigiD = doppio.fonte_spazio === "luigi";
    let spazio = tenuto.spazio, fonte = tenuto.fonte_spazio;
    if (!luigiT && (luigiD || (!spazio && doppio.spazio))) { spazio = doppio.spazio; fonte = doppio.fonte_spazio; }
    db.prepare(`UPDATE wa_contatti SET user_id = ?, nome_profilo = ?, nome_rubrica = ?, spazio = ?, fonte_spazio = ?, proposta_spazio = ?,
        ultima_notifica = ?, aggiornato = ? WHERE id = ?`)
      .run(tenuto.user_id || doppio.user_id, tenuto.nome_profilo || doppio.nome_profilo, tenuto.nome_rubrica || doppio.nome_rubrica, spazio, fonte,
        tenuto.proposta_spazio || doppio.proposta_spazio, Math.max(tenuto.ultima_notifica, doppio.ultima_notifica), ora, tenuto.id);
    db.prepare("DELETE FROM wa_contatti WHERE id = ?").run(doppio.id);
    // Doppioni di domande aperte: ne resta una.
    const aperte = db.prepare("SELECT id FROM wa_domande WHERE contatto_id = ? AND stato = 'aperta' ORDER BY creata").all(tenuto.id) as Array<{ id: string }>;
    for (const a of aperte.slice(1)) db.prepare("DELETE FROM wa_domande WHERE id = ?").run(a.id);
    if (luigiT && luigiD && tenuto.spazio !== doppio.spazio && !aperte.length) {
      db.prepare("INSERT INTO wa_domande (id, contatto_id, creata, stato) VALUES (?,?,?, 'aperta')").run(nuovoId("d"), tenuto.id, ora);
    }
  })();
  return leggiContatto(db, tenuto.id)!;
}

/** Nome da mostrare: rubrica di Luigi, poi profilo WhatsApp, poi numero mascherato. */
export function nomeContatto(c: Pick<ContattoWa, "nome_rubrica" | "nome_profilo" | "wa_id" | "gruppo">): string {
  return c.nome_rubrica || c.nome_profilo || (c.gruppo ? "Gruppo WhatsApp" : c.wa_id ? `Numero ${mascheraTelefono(c.wa_id)}` : "Contatto senza nome");
}

export function nomeSpazio(spazio: string, aziende: AziendaWa[]): string {
  if (spazio === PRIVATO) return "Privato";
  if (!spazio) return "Da assegnare";
  return aziende.find((a) => a.id === spazio)?.nome ?? "Azienda non più collegata";
}

export function assegnaSpazio(db: Db, contattoId: string, spazio: string, fonte: "luigi" | "costructo", ora = Date.now()): void {
  db.prepare("UPDATE wa_contatti SET spazio = ?, fonte_spazio = ?, aggiornato = ? WHERE id = ?").run(spazio, fonte, ora, contattoId);
  db.prepare("UPDATE wa_domande SET stato = 'risposta', risposta = ? WHERE contatto_id = ? AND stato = 'aperta'").run(spazio, contattoId);
}

// ---------------------------------------------------------------- messaggi
export interface DatiMessaggio {
  wamid: string;
  contattoId: string;
  gruppoId?: string;
  direzione: MessaggioWa["direzione"];
  tipo: string;
  quando: number;
  testo: string;
  media?: MediaWa;
  storico?: boolean;
  automatico?: boolean;
  /** Stato iniziale (i ricevuti dal vivo vanno classificati). */
  stato?: MessaggioWa["stato"];
}

/** Salva il messaggio una sola volta (per id di WhatsApp). Restituisce l'id oppure null se c'era già. */
export function salvaMessaggio(db: Db, d: DatiMessaggio, ora = Date.now()): string | null {
  const id = nuovoId("w");
  const r = db.prepare(`INSERT OR IGNORE INTO wa_messaggi (id, wamid, contatto_id, gruppo_id, direzione, tipo, quando, ricevuto, testo, media, storico, automatico, stato)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, d.wamid, d.contattoId, d.gruppoId ?? "", d.direzione, d.tipo, d.quando, ora, d.testo, JSON.stringify(d.media ?? {}), d.storico ? 1 : 0, d.automatico ? 1 : 0, d.stato ?? "nessuno");
  return r.changes ? id : null;
}

export const mediaDi = (m: Pick<MessaggioWa, "media">): MediaWa => { try { return JSON.parse(m.media) as MediaWa; } catch { return {}; } };

export function leggiMessaggio(db: Db, id: string): MessaggioWa | undefined {
  return db.prepare("SELECT * FROM wa_messaggi WHERE id = ?").get(id) as MessaggioWa | undefined;
}

/** Gli ultimi `quanti` messaggi di un contatto, dal più vecchio al più recente. */
export function ultimiMessaggi(db: Db, contattoId: string, quanti = 30, prima?: number): MessaggioWa[] {
  const righe = (prima
    ? db.prepare("SELECT * FROM wa_messaggi WHERE contatto_id = ? AND quando < ? ORDER BY quando DESC, ricevuto DESC LIMIT ?").all(contattoId, prima, quanti)
    : db.prepare("SELECT * FROM wa_messaggi WHERE contatto_id = ? ORDER BY quando DESC, ricevuto DESC LIMIT ?").all(contattoId, quanti)) as MessaggioWa[];
  return righe.reverse();
}

export interface StatoChat {
  /** Ultimo messaggio ricevuto dal vivo (non dallo storico), 0 se nessuno. */
  ultimoRicevuto: number;
  /** Ultima risposta vera (di Luigi dal telefono o mandata da Jarvis dopo la sua conferma; non le conferme automatiche). */
  ultimaRisposta: number;
  senzaRisposta: boolean;
  /** Dentro la finestra di 24 ore di WhatsApp (si può rispondere con un testo libero). */
  dentroFinestra: boolean;
}

export function statoChat(db: Db, contattoId: string, ora = Date.now()): StatoChat {
  const r = db.prepare(`SELECT
      (SELECT MAX(quando) FROM wa_messaggi WHERE contatto_id = ? AND direzione = 'in' AND tipo <> 'reaction' AND revocato = 0) AS ultimo_in,
      (SELECT MAX(quando) FROM wa_messaggi WHERE contatto_id = ? AND direzione = 'in' AND storico = 0
        AND tipo NOT IN ('reaction','unsupported','revoke','edit') AND revocato = 0) AS ultimo_in_vivo,
      (SELECT MAX(quando) FROM wa_messaggi WHERE contatto_id = ? AND direzione IN ('out','eco') AND automatico = 0 AND tipo <> 'reaction'
        AND stato_invio <> 'failed') AS ultima_risposta`)
    .get(contattoId, contattoId, contattoId) as { ultimo_in: number | null; ultimo_in_vivo: number | null; ultima_risposta: number | null };
  const ultimoRicevuto = r.ultimo_in ?? 0, ultimaRisposta = r.ultima_risposta ?? 0;
  // La finestra si apre solo con un vero messaggio del contatto arrivato dal vivo (non storico, reazioni, cancellati o
  // messaggi di sistema); un messaggio di Jarvis non consegnato («failed») non vale come risposta.
  return { ultimoRicevuto, ultimaRisposta, senzaRisposta: ultimoRicevuto > ultimaRisposta, dentroFinestra: !!r.ultimo_in_vivo && ora - r.ultimo_in_vivo < FINESTRA_MS };
}

// ---------------------------------------------------------------- elenco delle chat
export interface FiltriChat {
  /** Spazi ammessi: id delle aziende, «privato» e/o '' (non ancora assegnati). */
  spazi: string[];
  giorni?: number;
  soloUrgenti?: boolean;
  testo?: string;
  contatti?: string[];
  limite?: number;
}

export interface RigaChat { contatto: ContattoWa; ultimo: MessaggioWa; urgenti: number; stato: StatoChat; storico: boolean }

/** Le chat (un contatto ciascuna), dalla più recente. Senza spazi ammessi non restituisce niente. */
export function elencaChat(db: Db, f: FiltriChat, ora = Date.now()): RigaChat[] {
  if (!f.spazi.length) return [];
  const dove = [`c.spazio IN (${f.spazi.map(() => "?").join(",")})`];
  const valori: unknown[] = [...f.spazi];
  if (f.giorni) { dove.push("m.quando >= ?"); valori.push(ora - f.giorni * 864e5); }
  if (f.contatti?.length) { dove.push(`c.id IN (${f.contatti.map(() => "?").join(",")})`); valori.push(...f.contatti); }
  const like = (t: string) => `%${t.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
  if (f.testo?.trim()) {
    for (const p of f.testo.trim().split(/\s+/).slice(0, 6)) {
      dove.push("(m.testo LIKE ? ESCAPE '\\' OR m.riassunto LIKE ? ESCAPE '\\' OR c.nome_profilo LIKE ? ESCAPE '\\' OR c.nome_rubrica LIKE ? ESCAPE '\\' OR m.media LIKE ? ESCAPE '\\')");
      const l = like(p);
      valori.push(l, l, l, l, l);
    }
  }
  const righe = db.prepare(`SELECT c.id AS cid, MAX(m.quando) AS ultimo, SUM(CASE WHEN m.urgente = 1 AND m.direzione = 'in' THEN 1 ELSE 0 END) AS urgenti,
      MIN(m.storico) AS solo_storico
    FROM wa_contatti c JOIN wa_messaggi m ON m.contatto_id = c.id WHERE ${dove.join(" AND ")} GROUP BY c.id ORDER BY ultimo DESC LIMIT ?`)
    .all(...valori, Math.max(1, Math.min(300, f.limite ?? 50))) as Array<{ cid: string; ultimo: number; urgenti: number; solo_storico: number }>;
  const out: RigaChat[] = [];
  for (const r of righe) {
    const contatto = leggiContatto(db, r.cid)!;
    const ultimo = db.prepare("SELECT * FROM wa_messaggi WHERE contatto_id = ? ORDER BY quando DESC, ricevuto DESC LIMIT 1").get(r.cid) as MessaggioWa;
    const stato = statoChat(db, r.cid, ora);
    if (f.soloUrgenti && !r.urgenti) continue;
    out.push({ contatto, ultimo, urgenti: r.urgenti, stato, storico: r.solo_storico === 1 });
  }
  return out;
}

/** Contatti che corrispondono a un nome detto da Luigi (rubrica o profilo), solo negli spazi ammessi. */
export function cercaContatti(db: Db, nome: string, spazi: string[]): ContattoWa[] {
  const t = nome.trim().toLowerCase();
  if (!t || !spazi.length) return [];
  const like = `%${t.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
  const tutti = db.prepare(`SELECT * FROM wa_contatti WHERE spazio IN (${spazi.map(() => "?").join(",")})
      AND (lower(nome_rubrica) LIKE ? ESCAPE '\\' OR lower(nome_profilo) LIKE ? ESCAPE '\\') ORDER BY aggiornato DESC LIMIT 20`)
    .all(...spazi, like, like) as ContattoWa[];
  const esatti = tutti.filter((c) => c.nome_rubrica.toLowerCase() === t || c.nome_profilo.toLowerCase() === t);
  return esatti.length ? esatti : tutti;
}

// ---------------------------------------------------------------- risposte
export function leggiRisposta(db: Db, id: string): RispostaWa | undefined {
  return db.prepare("SELECT * FROM wa_risposte WHERE id = ?").get(id) as RispostaWa | undefined;
}
export function risposteAperte(db: Db, contattoId: string): RispostaWa[] {
  return db.prepare("SELECT * FROM wa_risposte WHERE contatto_id = ? AND stato IN ('proposta','bozza','in_invio','errore','incerto') ORDER BY creata DESC LIMIT 10").all(contattoId) as RispostaWa[];
}

// ---------------------------------------------------------------- pulizia (30 giorni)
/**
 * Cancella messaggi, risposte, domande e conferme automatiche più vecchi di 30 giorni, e i contatti rimasti
 * senza messaggi (tranne quelli che Luigi ha assegnato lui a un'azienda o al privato: la sua scelta si ricorda).
 */
export function pulisciWhatsappVecchio(db: Db, ora = Date.now()): number {
  const limite = ora - CONSERVAZIONE_MS;
  return db.transaction(() => {
    // Vale sia la data di arrivo in Jarvis sia la data del messaggio (lo storico importato può essere vecchio).
    const tolti = db.prepare("DELETE FROM wa_messaggi WHERE ricevuto < ? OR quando < ?").run(limite, limite).changes;
    db.prepare("DELETE FROM wa_risposte WHERE creata < ?").run(limite);
    db.prepare("DELETE FROM wa_conferme_auto WHERE quando < ?").run(limite);
    db.prepare("DELETE FROM wa_domande WHERE creata < ?").run(limite);
    db.prepare(`DELETE FROM wa_contatti WHERE aggiornato < ? AND fonte_spazio <> 'luigi'
      AND NOT EXISTS (SELECT 1 FROM wa_messaggi m WHERE m.contatto_id = wa_contatti.id)`).run(limite);
    return tolti;
  })();
}
