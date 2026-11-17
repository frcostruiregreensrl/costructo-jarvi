// Limite di tentativi (accesso): dopo troppi errori la chiave resta bloccata per un po'.
import type { Db } from "../db.js";

export interface RegolaLimite { massimo: number; finestraMs: number; bloccoMs: number }

export const REGOLA_ACCESSO_IP: RegolaLimite = { massimo: 5, finestraMs: 15 * 60_000, bloccoMs: 15 * 60_000 };
export const REGOLA_ACCESSO_GLOBALE: RegolaLimite = { massimo: 20, finestraMs: 60 * 60_000, bloccoMs: 60 * 60_000 };

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
