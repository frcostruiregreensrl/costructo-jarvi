// Limite di tentativi (accesso).
// - Per indirizzo IP: dopo 5 errori in 15 minuti quell'indirizzo resta bloccato 15 minuti.
// - In totale NON c'è blocco (altrimenti chiunque potrebbe chiudere fuori Luigi sbagliando apposta):
//   oltre 20 errori in un'ora ogni tentativo viene solo rallentato, con un ritardo che cresce fino a 5 secondi.
// Dietro un proxy (Railway) l'IP vero arriva solo con JARVIS_PROXY=1: vedi docs/SICUREZZA.md.
import type { Db } from "../db.js";

export interface RegolaLimite { massimo: number; finestraMs: number; bloccoMs: number }

export const REGOLA_ACCESSO_IP: RegolaLimite = { massimo: 5, finestraMs: 15 * 60_000, bloccoMs: 15 * 60_000 };
/** Conteggio globale degli errori: non blocca mai, serve solo per il ritardo crescente. */
export const REGOLA_ACCESSO_GLOBALE: RegolaLimite = { massimo: Infinity, finestraMs: 60 * 60_000, bloccoMs: 0 };
export const CHIAVE_GLOBALE = "accesso:tutti";
const SOGLIA_RITARDO = 20;
const PASSO_RITARDO_MS = 250;
const RITARDO_MASSIMO_MS = 5_000;

/** Millisecondi da attendere prima di valutare un tentativo di accesso (0 finché gli errori totali sono pochi). */
export function ritardoAccesso(db: Db, ora = Date.now()): number {
  const r = db.prepare("SELECT conteggio, inizio FROM tentativi WHERE chiave = ?").get(CHIAVE_GLOBALE) as { conteggio: number; inizio: number } | undefined;
  if (!r || ora - r.inizio >= REGOLA_ACCESSO_GLOBALE.finestraMs) return 0;
  return Math.min(RITARDO_MASSIMO_MS, Math.max(0, r.conteggio - SOGLIA_RITARDO) * PASSO_RITARDO_MS);
}

/** Millisecondi di blocco rimasti (0 = libero). */
export function bloccatoPer(db: Db, chiave: string, ora = Date.now()): number {
  const r = db.prepare("SELECT bloccato_fino FROM tentativi WHERE chiave = ?").get(chiave) as { bloccato_fino: number } | undefined;
  return r && r.bloccato_fino > ora ? r.bloccato_fino - ora : 0;
}

export function registraErrore(db: Db, chiave: string, regola: RegolaLimite, ora = Date.now()): void {
  const r = db.prepare("SELECT conteggio, inizio FROM tentativi WHERE chiave = ?").get(chiave) as { conteggio: number; inizio: number } | undefined;
  let conteggio = 1, inizio = ora;
  if (r && ora - r.inizio < regola.finestraMs) { conteggio = r.conteggio + 1; inizio = r.inizio; }
  const bloccato = conteggio >= regola.massimo ? ora + regola.bloccoMs : 0;
  db.prepare(`INSERT INTO tentativi (chiave, conteggio, inizio, bloccato_fino) VALUES (?,?,?,?)
    ON CONFLICT(chiave) DO UPDATE SET conteggio = excluded.conteggio, inizio = excluded.inizio, bloccato_fino = excluded.bloccato_fino`)
    .run(chiave, bloccato ? 0 : conteggio, bloccato ? ora : inizio, bloccato);
}

export function azzera(db: Db, chiave: string): void {
  db.prepare("DELETE FROM tentativi WHERE chiave = ?").run(chiave);
}
