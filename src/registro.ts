// Registro di tutte le azioni: ogni strumento, accesso e modifica lascia una riga qui.
// Il registro NON conserva i testi personali: di titoli, ricordi e ricerche resta solo un'impronta
// (per riconoscere la stessa azione) e un estratto brevissimo, che dopo 30 giorni viene tolto
// insieme all'indirizzo IP. Coerente con «memoria cancellabile, conversazioni 30 giorni».
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { CONSERVAZIONE_MS } from "./conversazioni.js";

export type Esito = "fatto" | "negato" | "errore" | "richiesta_conferma";
export type Origine = "luigi" | "jarvis" | "sistema";

export interface VoceRegistro { id: number; quando: number; azione: string; esito: Esito; origine: Origine; dettagli: Record<string, unknown> }

/** Campi che possono contenere testi personali: non si salvano mai per intero. */
const TESTUALI = new Set(["input", "cercato", "testo", "titolo"]);
/** Campi tolti dopo 30 giorni (dati personali brevi). */
const DA_TOGLIERE_DOPO_30_GIORNI = ["estratto", "ip", "origin", "messaggio", "input", "cercato", "testo", "titolo"];
const LUNGHEZZA_ESTRATTO = 24;
const LUNGHEZZA_TESTO = 120;

function testoPrincipale(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["titolo", "testo"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return JSON.stringify(v ?? "");
}

/** Toglie i testi personali dai dettagli: restano impronta ed estratto brevissimo. */
export function pulisciDettagli(dettagli: Record<string, unknown>): Record<string, unknown> {
  const fuori: Record<string, unknown> = {};
  const testi: unknown[] = [];
  for (const [k, v] of Object.entries(dettagli)) {
    if (TESTUALI.has(k)) testi.push(v);
    else fuori[k] = typeof v === "string" ? v.slice(0, LUNGHEZZA_TESTO) : v;
  }
  if (testi.length) {
    fuori.impronta = createHash("sha256").update(JSON.stringify(testi)).digest("hex").slice(0, 12);
    const t = testi.map(testoPrincipale).join(" ").replace(/\s+/g, " ").trim();
    fuori.estratto = t.length > LUNGHEZZA_ESTRATTO ? `${t.slice(0, LUNGHEZZA_ESTRATTO)}…` : t;
  }
  return fuori;
}

/**
 * Quando Luigi cancella un ricordo o un impegno, dal registro sparisce anche il suo estratto
 * (resta l'impronta, che da sola non dice niente).
 */
export function dimenticaNelRegistro(db: Db, testo: string): number {
  const estratto = (pulisciDettagli({ testo }).estratto as string) || "";
  if (!estratto) return 0;
  return db.prepare("UPDATE registro SET dettagli = json_remove(dettagli, '$.estratto') WHERE json_valid(dettagli) AND json_extract(dettagli, '$.estratto') = ?")
    .run(estratto).changes;
}

/** Toglie estratti, IP e altri dati personali brevi dalle righe più vecchie di 30 giorni. Restituisce quante righe ha toccato. */
export function pulisciRegistroVecchio(db: Db, ora = Date.now()): number {
  const percorsi = DA_TOGLIERE_DOPO_30_GIORNI.map((k) => `'$.${k}'`).join(", ");
  const condizione = DA_TOGLIERE_DOPO_30_GIORNI.map((k) => `json_type(dettagli, '$.${k}') IS NOT NULL`).join(" OR ");
  return db.prepare(`UPDATE registro SET dettagli = json_remove(dettagli, ${percorsi}) WHERE quando < ? AND json_valid(dettagli) AND (${condizione})`)
    .run(ora - CONSERVAZIONE_MS).changes;
}

export function registra(db: Db, azione: string, esito: Esito, origine: Origine, dettagli: Record<string, unknown> = {}, ora = Date.now()): void {
  const testo = JSON.stringify(pulisciDettagli(dettagli));
  db.prepare("INSERT INTO registro (quando, azione, esito, origine, dettagli) VALUES (?,?,?,?,?)")
    .run(ora, azione.slice(0, 80), esito, origine, testo.length > 4000 ? testo.slice(0, 4000) : testo);
}

export function leggiRegistro(db: Db, limite = 100, primaDi?: number): VoceRegistro[] {
  const righe = (primaDi
    ? db.prepare("SELECT * FROM registro WHERE id < ? ORDER BY id DESC LIMIT ?").all(primaDi, limite)
    : db.prepare("SELECT * FROM registro ORDER BY id DESC LIMIT ?").all(limite)) as Array<Omit<VoceRegistro, "dettagli"> & { dettagli: string }>;
  return righe.map((r) => {
    let dettagli: Record<string, unknown> = {};
    try { dettagli = JSON.parse(r.dettagli); } catch { /* riga vecchia o troncata */ }
    return { ...r, dettagli };
  });
}
