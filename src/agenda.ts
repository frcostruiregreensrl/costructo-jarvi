// Agenda privata locale di Jarvis (come l'originale: gli impegni detti a voce restano qui).
// La cancellazione chiede conferma se più impegni corrispondono alla richiesta.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { daOraLocale, inizioGiorno, oraMinuti, descriviGiorno } from "./tempo.js";

export interface Impegno { id: string; titolo: string; inizio: number; minuti: number; tutto_il_giorno: number; creato: number }

export function aggiungiImpegno(db: Db, d: { titolo: string; data: string; ora: string; minuti?: number }, fuso: string, ora = Date.now()): Impegno {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.data);
  if (!m) throw new Error("Data non valida: serve giorno, mese e anno.");
  const oraOk = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(d.ora || "");
  if (d.ora && !oraOk) throw new Error("Ora non valida.");
  const [a, me, g] = [+m[1], +m[2] - 1, +m[3]];
  const controllo = new Date(Date.UTC(a, me, g));
  if (controllo.getUTCMonth() !== me || controllo.getUTCDate() !== g) throw new Error("Data non valida.");
  const inizio = daOraLocale(a, me, g, oraOk ? +oraOk[1] : 0, oraOk ? +oraOk[2] : 0, fuso);
  const titolo = String(d.titolo || "Impegno").replace(/\s+/g, " ").trim().slice(0, 140) || "Impegno";
  const minuti = Math.min(24 * 60, Math.max(5, Math.round(d.minuti || 60)));
  const imp: Impegno = { id: randomUUID(), titolo, inizio, minuti, tutto_il_giorno: oraOk ? 0 : 1, creato: ora };
  db.prepare("INSERT INTO impegni (id, titolo, inizio, minuti, tutto_il_giorno, creato) VALUES (?,?,?,?,?,?)")
    .run(imp.id, imp.titolo, imp.inizio, imp.minuti, imp.tutto_il_giorno, imp.creato);
  return imp;
}

export function impegniTra(db: Db, da: number, a: number): Impegno[] {
  return db.prepare("SELECT * FROM impegni WHERE inizio + minuti * 60000 > ? AND inizio < ? ORDER BY inizio").all(da, a) as Impegno[];
}

export function impegniProssimiGiorni(db: Db, giorni: number, fuso: string, ora = Date.now()): Impegno[] {
  const da = inizioGiorno(ora, fuso);
  return impegniTra(db, da, da + Math.max(1, Math.min(60, giorni)) * 864e5);
}

const normalizza = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Impegni futuri (o di oggi) il cui titolo contiene il testo cercato. */
export function cercaImpegni(db: Db, testo: string, fuso: string, ora = Date.now()): Impegno[] {
  const q = normalizza(testo);
  if (!q) return [];
  const da = inizioGiorno(ora, fuso);
  return (db.prepare("SELECT * FROM impegni WHERE inizio >= ? ORDER BY inizio").all(da) as Impegno[]).filter((i) => normalizza(i.titolo).includes(q));
}

export function cancellaImpegno(db: Db, id: string): Impegno | null {
  const i = db.prepare("SELECT * FROM impegni WHERE id = ?").get(id) as Impegno | undefined;
  if (!i) return null;
  db.prepare("DELETE FROM impegni WHERE id = ?").run(id);
  return i;
}

export function descriviImpegno(i: Impegno, fuso: string): string {
  return `${i.titolo}, ${descriviGiorno(i.inizio, fuso)}${i.tutto_il_giorno ? " (tutto il giorno)" : ` alle ${oraMinuti(i.inizio, fuso)}`}`;
}
