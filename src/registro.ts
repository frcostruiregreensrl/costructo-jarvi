// Registro di tutte le azioni: ogni strumento, accesso e modifica lascia una riga qui.
import type { Db } from "./db.js";

export type Esito = "fatto" | "negato" | "errore" | "richiesta_conferma";
export type Origine = "luigi" | "jarvis" | "sistema";

export interface VoceRegistro { id: number; quando: number; azione: string; esito: Esito; origine: Origine; dettagli: Record<string, unknown> }

export function registra(db: Db, azione: string, esito: Esito, origine: Origine, dettagli: Record<string, unknown> = {}, ora = Date.now()): void {
  const testo = JSON.stringify(dettagli);
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
