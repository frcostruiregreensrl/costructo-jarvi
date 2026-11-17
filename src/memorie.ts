// Memoria di Jarvis divisa in due spazi: PRIVATO e LAVORO. Luigi la vede, la corregge e la cancella.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export type Spazio = "privato" | "lavoro";
export type Vista = Spazio | "tutto";
export interface Memoria { id: string; spazio: Spazio; testo: string; origine: "luigi" | "jarvis"; creato: number; aggiornato: number }

const pulisci = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 500);

export function spaziDellaVista(v: Vista): Spazio[] {
  return v === "tutto" ? ["privato", "lavoro"] : [v];
}

export function elencaMemorie(db: Db, vista: Vista): Memoria[] {
  const spazi = spaziDellaVista(vista);
  return db.prepare(`SELECT * FROM memorie WHERE spazio IN (${spazi.map(() => "?").join(",")}) ORDER BY aggiornato DESC`).all(...spazi) as Memoria[];
}

export function aggiungiMemoria(db: Db, spazio: Spazio, testo: string, origine: Memoria["origine"], ora = Date.now()): Memoria {
  const t = pulisci(testo);
  if (!t) throw new Error("Il ricordo è vuoto.");
  const doppione = db.prepare("SELECT * FROM memorie WHERE spazio = ? AND lower(testo) = lower(?)").get(spazio, t) as Memoria | undefined;
  if (doppione) return doppione;
  const m: Memoria = { id: randomUUID(), spazio, testo: t, origine, creato: ora, aggiornato: ora };
  db.prepare("INSERT INTO memorie (id, spazio, testo, origine, creato, aggiornato) VALUES (?,?,?,?,?,?)").run(m.id, m.spazio, m.testo, m.origine, m.creato, m.aggiornato);
  return m;
}

export function correggiMemoria(db: Db, id: string, modifiche: { testo?: string; spazio?: Spazio }, ora = Date.now()): Memoria | null {
  const m = db.prepare("SELECT * FROM memorie WHERE id = ?").get(id) as Memoria | undefined;
  if (!m) return null;
  const testo = modifiche.testo !== undefined ? pulisci(modifiche.testo) : m.testo;
  if (!testo) throw new Error("Il ricordo è vuoto.");
  const spazio = modifiche.spazio ?? m.spazio;
  db.prepare("UPDATE memorie SET testo = ?, spazio = ?, origine = 'luigi', aggiornato = ? WHERE id = ?").run(testo, spazio, ora, id);
  return { ...m, testo, spazio, origine: "luigi", aggiornato: ora };
}

export function cancellaMemoria(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM memorie WHERE id = ?").run(id).changes > 0;
}

export function cancellaTutteLeMemorie(db: Db, spazio: Spazio): number {
  return db.prepare("DELETE FROM memorie WHERE spazio = ?").run(spazio).changes;
}

/** Testo leggibile (Markdown) come il vecchio JARVIS-MEMORIA.md, per esportare. */
export function esportaMemorie(db: Db): string {
  const parti = (["privato", "lavoro"] as Spazio[]).map((s) => {
    const m = elencaMemorie(db, s);
    return `## ${s === "privato" ? "Privato" : "Lavoro"}\n${m.length ? m.map((x) => `- ${x.testo}`).join("\n") : "- (niente)"}`;
  });
  return `# Memoria di J.A.R.V.I.S.\n\n${parti.join("\n\n")}\n`;
}
