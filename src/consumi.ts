// Consumi dell'AI: token e costo stimato del mese, con il tetto di spesa scelto da Luigi.
import type { Db } from "./db.js";
import { partiLocali } from "./tempo.js";

/** Prezzi di listino Anthropic (USD per milione di token), novembre 2026. */
export const LISTINO: Record<string, { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number }> = {
  "claude-haiku-5-5": { ingresso: 0.1, uscita: 0.5, cacheLettura: 0.01, cacheScrittura: 0.125 },
  "claude-sonnet-5-5": { ingresso: 2, uscita: 10, cacheLettura: 0.1, cacheScrittura: 2.5 },
};
/**
 * Haiku 5.5 costa di più quando una singola richiesta supera i 100.000 token in ingresso
 * ($0,50 / $2,50 per milione invece di $0,10 / $0,50). La cache segue la stessa proporzione.
 */
export const SOGLIA_LUNGA = 100_000;
export const LISTINO_LUNGO: Record<string, { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number }> = {
  "claude-haiku-5-5": { ingresso: 0.5, uscita: 2.5, cacheLettura: 0.05, cacheScrittura: 0.625 },
};
/** Modello sconosciuto: si usa il prezzo più alto noto, per non sottostimare. */
const PREZZO_PRUDENTE = { ingresso: 4, uscita: 20, cacheLettura: 0.2, cacheScrittura: 5 };

export interface Uso { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number }

export function costoUsd(modello: string, u: Uso): number {
  const lunga = u.ingresso + u.cacheLettura + u.cacheScrittura > SOGLIA_LUNGA;
  const p = (lunga && LISTINO_LUNGO[modello]) || LISTINO[modello] || PREZZO_PRUDENTE;
  return (u.ingresso * p.ingresso + u.uscita * p.uscita + u.cacheLettura * p.cacheLettura + u.cacheScrittura * p.cacheScrittura) / 1_000_000;
}

/** Stima prudente dei token di un testo (circa 3 caratteri per token: in italiano di solito sono di più). */
export function stimaToken(testo: string): number {
  return Math.ceil(testo.length / 3);
}

export function meseDi(ms: number, fuso: string): string {
  const p = partiLocali(ms, fuso);
  return `${p.anno}-${String(p.mese + 1).padStart(2, "0")}`;
}

export function registraConsumo(db: Db, modello: string, u: Uso, fuso: string, ora = Date.now()): number {
  const costo = costoUsd(modello, u);
  db.prepare(`INSERT INTO consumi (quando, mese, modello, token_ingresso, token_uscita, token_cache_lettura, token_cache_scrittura, costo_usd)
    VALUES (?,?,?,?,?,?,?,?)`).run(ora, meseDi(ora, fuso), modello, u.ingresso, u.uscita, u.cacheLettura, u.cacheScrittura, costo);
  return costo;
}

export interface RiepilogoMese {
  mese: string; spesaUsd: number; tettoUsd: number; richieste: number;
  tokenIngresso: number; tokenUscita: number; perModello: Array<{ modello: string; richieste: number; spesaUsd: number }>;
  raggiunto: boolean; quasi: boolean;
}

export function riepilogoMese(db: Db, tettoUsd: number, fuso: string, ora = Date.now()): RiepilogoMese {
  const mese = meseDi(ora, fuso);
  const tot = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(costo_usd),0) spesa, COALESCE(SUM(token_ingresso + token_cache_lettura + token_cache_scrittura),0) ti,
    COALESCE(SUM(token_uscita),0) tu FROM consumi WHERE mese = ?`).get(mese) as { n: number; spesa: number; ti: number; tu: number };
  const perModello = db.prepare("SELECT modello, COUNT(*) richieste, SUM(costo_usd) spesaUsd FROM consumi WHERE mese = ? GROUP BY modello ORDER BY spesaUsd DESC").all(mese) as RiepilogoMese["perModello"];
  return {
    mese, spesaUsd: tot.spesa, tettoUsd, richieste: tot.n, tokenIngresso: tot.ti, tokenUscita: tot.tu, perModello,
    raggiunto: tot.spesa >= tettoUsd,
    quasi: tot.spesa >= tettoUsd * 0.8,
  };
}

// ---------------------------------------------------------------- coda delle chiamate all'AI
// Le chiamate al cervello passano una per volta (Jarvis ha un solo utente): prima di ognuna chi chiama
// ricontrolla la spesa del mese più una stima prudente del costo; il consumo vero si registra prima di
// lasciare il posto alla successiva. Vale per le domande di Luigi E per la classificazione della posta:
// dieci richieste in parallelo non sfondano il tetto.
const code = new WeakMap<Db, Promise<void>>();

export async function inCoda<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const prima = code.get(db) ?? Promise.resolve();
  let libera!: () => void;
  const mia = new Promise<void>((r) => { libera = r; });
  code.set(db, prima.then(() => mia));
  await prima;
  try { return await fn(); } finally { libera(); }
}
