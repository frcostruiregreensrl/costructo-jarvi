// Letture di Costructo che servono alle funzioni (cantieri, operai, controparti, documenti), con una piccola memoria
// di qualche minuto per azienda: un giro di WhatsApp non chiede a Costructo le stesse cose a ogni messaggio.
// Un errore non resta in memoria (al giro dopo si riprova). I dati restano DATI.
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import type { Controparte, VoceDocumento } from "../costructo.js";
import { registra } from "../registro.js";
import { distanzaMetri, normalizza } from "./date.js";
import { normalizzaTelefono } from "../whatsapp/telefono.js";

export const VALIDITA_MS = 10 * 60_000;
const memoria = new WeakMap<Db, Map<string, { quando: number; valore: unknown }>>();

async function ricorda<T>(db: Db, chiave: string, ora: number, leggi: () => Promise<T>): Promise<T> {
  let m = memoria.get(db);
  if (!m) { m = new Map(); memoria.set(db, m); }
  const c = m.get(chiave);
  if (c && ora - c.quando < VALIDITA_MS) return c.valore as T;
  const valore = await leggi();
  m.set(chiave, { quando: ora, valore });
  return valore;
}
export const dimenticaLetture = (db: Db) => { memoria.delete(db); };

export interface CantiereNoto { id: string; nome: string; indirizzo: string; cliente: string; lat?: number; lon?: number; aziendaId: string }
export interface OperaioNoto { id: string; nome: string; attivo: boolean }

/** Legge senza far cadere il giro: in caso di errore lista vuota (e una riga nel registro). */
async function sicura<T>(db: Db, a: AziendaCollegata, percorso: string, f: () => Promise<T[]>): Promise<T[]> {
  try { return await f(); } catch (e) {
    registra(db, "costructo.leggi", "errore", "sistema", { percorso, azienda: a.nome, motivo: (e as Error).message?.slice(0, 120) });
    throw e;
  }
}

export async function cantieriDi(db: Db, a: AziendaCollegata, ora = Date.now()): Promise<CantiereNoto[]> {
  return ricorda(db, `cantieri:${a.id}`, ora, async () => (await sicura(db, a, "/cantieri", async () => (await a.client.cantieri()).dati)).filter((c) => c.id && c.nome)
    .map((c) => ({ id: String(c.id), nome: String(c.nome), indirizzo: c.indirizzo ?? "", cliente: c.cliente ?? "", lat: c.lat, lon: c.lon, aziendaId: a.id })));
}

export async function operaiDi(db: Db, a: AziendaCollegata, ora = Date.now()): Promise<OperaioNoto[]> {
  return ricorda(db, `operai:${a.id}`, ora, async () => (await sicura(db, a, "/operai", () => a.client.operai())).filter((o) => o.id)
    .map((o) => ({ id: String(o.id), nome: [o.nome, o.cognome].filter(Boolean).join(" ").trim() || `Operaio ${o.id}`, attivo: o.attivo !== false })));
}

export async function contropartiDi(db: Db, a: AziendaCollegata, ora = Date.now()): Promise<Controparte[]> {
  return ricorda(db, `controparti:${a.id}`, ora, () => sicura(db, a, "/controparti", () => a.client.contropartiLista()));
}

export async function documentiDi(db: Db, a: AziendaCollegata, ora = Date.now()): Promise<VoceDocumento[]> {
  return ricorda(db, `documenti:${a.id}`, ora, () => sicura(db, a, "/documenti", () => a.client.documenti()));
}

/** Prova una lettura: errore = lista vuota (per i briefing e le funzioni che possono farne a meno). */
export async function oVuoto<T>(p: Promise<T[]>): Promise<T[]> { try { return await p; } catch { return []; } }

// ---------------------------------------------------------------- confronto dei nomi
const GENERICHE = new Set(["cantiere", "cantieri", "lavori", "lavoro", "via", "viale", "piazza", "corso", "casa", "condominio", "villa", "impresa", "srl", "spa", "snc", "sas", "della", "dello", "delle", "degli", "del", "dei", "presso"]);
const paroleDi = (t: string) => normalizza(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !GENERICHE.has(p));

/**
 * Cantieri citati nel testo: prima il nome intero; poi le parole caratteristiche del nome («cantiere Rossi» → «Casa Rossi»).
 * Più di uno = ambiguo: chi chiama chiede a Luigi.
 */
export function cantieriCitati(testo: string, cantieri: CantiereNoto[]): CantiereNoto[] {
  const t = ` ${normalizza(testo).replace(/[^a-z0-9]+/g, " ")} `;
  if (!t.trim()) return [];
  const interi = cantieri.filter((c) => { const n = normalizza(c.nome).replace(/[^a-z0-9]+/g, " ").trim(); return n.length >= 4 && t.includes(` ${n} `); });
  if (interi.length) return interi;
  const parole = new Set(t.trim().split(" "));
  return cantieri.filter((c) => paroleDi(`${c.nome} ${c.cliente}`).some((p) => p.length >= 4 && parole.has(p)));
}

/** Il cantiere più vicino a un punto (solo cantieri con coordinate). */
export function cantierePiuVicino(punto: { lat: number; lon: number }, cantieri: CantiereNoto[]): { cantiere: CantiereNoto; metri: number } | null {
  let migliore: { cantiere: CantiereNoto; metri: number } | null = null;
  for (const c of cantieri) {
    if (typeof c.lat !== "number" || typeof c.lon !== "number") continue;
    const metri = distanzaMetri(punto, { lat: c.lat, lon: c.lon });
    if (!migliore || metri < migliore.metri) migliore = { cantiere: c, metri };
  }
  return migliore;
}

/** Controparti con lo stesso nome (rubrica WhatsApp o nome detto da Luigi). */
export function contropartiPerNome(nome: string, lista: Controparte[]): Controparte[] {
  const n = normalizza(nome).trim();
  if (!n) return [];
  const nomeDi = (c: Controparte) => normalizza(c.nome || c.ragioneSociale || "");
  const esatte = lista.filter((c) => nomeDi(c) === n);
  if (esatte.length) return esatte;
  const p = paroleDi(nome);
  return lista.filter((c) => { const q = paroleDi(c.nome || c.ragioneSociale || ""); return p.length > 0 && p.every((x) => q.includes(x)); });
}

/** Numero di una controparte (il primo che si legge). */
export function telefonoDi(c: Pick<Controparte, "telefono">): string | null {
  for (const pezzo of String(c.telefono ?? "").split(/[,;/]|\s{2,}/)) { const n = normalizzaTelefono(pezzo); if (n) return n; }
  return null;
}
