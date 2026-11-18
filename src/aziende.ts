// Più aziende in Costructo: ogni token «csa_…» appartiene a UNA sola azienda.
// Jarvis conserva fino a 5 token (cifrati, segreto «costructo_aziende») con il nome dell'azienda,
// letto da Costructo (/io) quando il token viene aggiunto. L'indirizzo di Costructo resta uno solo.
// Compatibilità: il vecchio token unico («costructo_token» o COSTRUCTO_TOKEN) vale come prima azienda.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.js";
import type { Cifratore } from "./sicurezza/cifra.js";
import { creaClientCostructo, ErroreCostructo, type ClientCostructo } from "./costructo.js";
import { leggiSegreto, salvaSegreto, leggiValore, scriviValore, maschera } from "./impostazioni.js";

export const MAX_AZIENDE = 5;
/** Id dell'azienda che arriva dal vecchio token unico. */
export const ID_PRINCIPALE = "principale";
const NOME_PRINCIPALE = "Azienda principale";
const FORMATO_TOKEN = /^csa_[A-Za-z0-9_\-]{8,}$/;

export interface AziendaSalvata {
  id: string;
  nome: string;
  token: string;
  /** Id dell'azienda dentro Costructo (da /io), per non aggiungere due volte la stessa. */
  aziendaId?: string;
}
/** Un'azienda pronta per leggere Costructo. */
export interface AziendaCollegata { id: string; nome: string; client: ClientCostructo }
/** Per l'interfaccia: mai il token, solo le ultime cifre. */
export interface AziendaVisibile { id: string; nome: string; token: string }

export class ErroreAziende extends Error {
  constructor(messaggio: string, readonly stato = 400) { super(messaggio); }
}

export interface FonteAziende {
  db: Db;
  cifratore: Cifratore;
  /** COSTRUCTO_URL e COSTRUCTO_TOKEN dalle variabili del server (ripiego). */
  urlAmbiente: string;
  tokenAmbiente: string;
  fetchFn?: typeof fetch;
}

/** Nome pulito: niente caratteri di controllo né < >, al massimo 60 caratteri. */
export function pulisciNome(n: unknown): string {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

const SchemaSalvata = z.object({
  id: z.string().min(1).max(40),
  nome: z.string().min(1).max(60),
  token: z.string().regex(FORMATO_TOKEN),
  aziendaId: z.string().max(80).optional(),
});
const SchemaElenco = z.array(SchemaSalvata).max(MAX_AZIENDE);

const SchemaIo = z.object({
  azienda: z.object({
    id: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
    nome: z.string().optional().catch(undefined),
  }).passthrough().optional().catch(undefined),
}).passthrough();

// ---------------------------------------------------------------- lettura e scrittura

/** Elenco salvato (senza il vecchio token unico). */
function elencoSalvato(f: FonteAziende): AziendaSalvata[] {
  const grezzo = leggiSegreto(f.db, f.cifratore, "costructo_aziende");
  if (!grezzo) return [];
  try {
    const ok = SchemaElenco.safeParse(JSON.parse(grezzo));
    return ok.success ? ok.data : [];
  } catch { return []; }
}
function salvaElenco(f: FonteAziende, elenco: AziendaSalvata[]): void {
  salvaSegreto(f.db, f.cifratore, "costructo_aziende", elenco.length ? JSON.stringify(elenco) : "");
}

interface InfoPrincipale { nome?: string; aziendaId?: string }

/** Il vecchio token unico, se c'è (prima quello salvato, poi quello del server, se non è stato tolto). */
function tokenPrincipale(f: FonteAziende): { token: string; daAmbiente: boolean } | null {
  const salvato = leggiSegreto(f.db, f.cifratore, "costructo_token");
  if (salvato) return { token: salvato, daAmbiente: false };
  if (f.tokenAmbiente && !leggiValore<boolean>(f.db, "costructoAmbienteTolto")) return { token: f.tokenAmbiente, daAmbiente: true };
  return null;
}

/**
 * Tutte le aziende, compreso il vecchio token unico come prima azienda quando l'elenco è vuoto
 * (così chi aveva già collegato Costructo non perde niente).
 */
export function leggiAziende(f: FonteAziende): AziendaSalvata[] {
  const elenco = elencoSalvato(f);
  if (elenco.length) return elenco;
  const p = tokenPrincipale(f);
  if (!p) return [];
  const info = leggiValore<InfoPrincipale>(f.db, "aziendaPrincipale") ?? {};
  return [{ id: ID_PRINCIPALE, nome: info.nome || NOME_PRINCIPALE, token: p.token, aziendaId: info.aziendaId }];
}

export function urlCostructo(f: FonteAziende): string {
  return leggiSegreto(f.db, f.cifratore, "costructo_url") || f.urlAmbiente;
}

export function aziendeVisibili(f: FonteAziende): AziendaVisibile[] {
  return leggiAziende(f).map((a) => ({ id: a.id, nome: a.nome, token: maschera(a.token) }));
}

/** Le aziende pronte per leggere Costructo (vuoto se manca l'indirizzo). */
export function aziendeCollegate(f: FonteAziende): AziendaCollegata[] {
  const url = urlCostructo(f);
  if (!url) return [];
  return leggiAziende(f).map((a) => ({ id: a.id, nome: a.nome, client: creaClientCostructo({ url, token: a.token, fetchFn: f.fetchFn }) }));
}

/** Chiede a Costructo di chi è il token. Se Costructo non lo accetta, l'errore è chiaro. */
async function chiediIo(url: string, token: string, fetchFn?: typeof fetch): Promise<InfoPrincipale> {
  try {
    const r = await creaClientCostructo({ url, token, fetchFn }).io();
    const io = SchemaIo.safeParse(r.dati);
    const az = io.success ? io.data.azienda : undefined;
    return { nome: pulisciNome(az?.nome) || undefined, aziendaId: az?.id };
  } catch (e) {
    const motivo = e instanceof ErroreCostructo ? e.message : "errore sconosciuto";
    throw new ErroreAziende(`Costructo non ha accettato questo token: ${motivo}`);
  }
}

/** Trasforma il vecchio token unico in una voce dell'elenco (serve prima di aggiungere, rinominare o togliere). */
async function elencoConPrincipale(f: FonteAziende, url: string): Promise<AziendaSalvata[]> {
  const elenco = elencoSalvato(f);
  if (elenco.length) return elenco;
  const p = tokenPrincipale(f);
  if (!p) return [];
  const info = leggiValore<InfoPrincipale>(f.db, "aziendaPrincipale") ?? {};
  let nome = info.nome, aziendaId = info.aziendaId;
  if (!nome || !aziendaId) {
    try { const io = await chiediIo(url, p.token, f.fetchFn); nome ||= io.nome; aziendaId ||= io.aziendaId; } catch { /* resta il nome generico */ }
  }
  return [{ id: ID_PRINCIPALE, nome: nome || NOME_PRINCIPALE, token: p.token, ...(aziendaId ? { aziendaId } : {}) }];
}
/** Dopo aver spostato il vecchio token nell'elenco, il vecchio segreto non serve più. */
function chiudiPrincipale(f: FonteAziende, elenco: AziendaSalvata[]): void {
  salvaElenco(f, elenco);
  salvaSegreto(f.db, f.cifratore, "costructo_token", "");
  if (f.tokenAmbiente && elenco.some((a) => a.token === f.tokenAmbiente)) scriviValore(f.db, "costructoAmbienteTolto", true);
}

// ---------------------------------------------------------------- modifiche (da Impostazioni)

export async function aggiungiAzienda(f: FonteAziende, dati: { token: string; nome?: string }): Promise<AziendaSalvata> {
  const token = dati.token.trim();
  if (!FORMATO_TOKEN.test(token)) throw new ErroreAziende("Il token di Costructo deve iniziare con csa_.");
  const url = urlCostructo(f);
  if (!url) throw new ErroreAziende("Prima salva l'indirizzo di Costructo.");
  const elenco = await elencoConPrincipale(f, url);
  if (elenco.some((a) => a.token === token)) throw new ErroreAziende("Questo token è già collegato.");
  if (elenco.length >= MAX_AZIENDE) throw new ErroreAziende(`Puoi collegare al massimo ${MAX_AZIENDE} aziende.`);
  const io = await chiediIo(url, token, f.fetchFn);
  if (io.aziendaId) {
    const doppia = elenco.find((a) => a.aziendaId === io.aziendaId);
    if (doppia) throw new ErroreAziende(`Questa azienda è già collegata (${doppia.nome}).`);
  }
  const nome = pulisciNome(dati.nome) || io.nome || `Azienda ${elenco.length + 1}`;
  if (elenco.some((a) => a.nome.toLowerCase() === nome.toLowerCase())) throw new ErroreAziende(`C'è già un'azienda che si chiama «${nome}»: scegli un altro nome.`);
  const nuova: AziendaSalvata = { id: `a${randomBytes(4).toString("hex")}`, nome, token, ...(io.aziendaId ? { aziendaId: io.aziendaId } : {}) };
  chiudiPrincipale(f, [...elenco, nuova]);
  return nuova;
}

export async function rimuoviAzienda(f: FonteAziende, id: string): Promise<AziendaSalvata> {
  const elenco = await elencoConPrincipale(f, urlCostructo(f));
  const tolta = elenco.find((a) => a.id === id);
  if (!tolta) throw new ErroreAziende("Azienda non trovata.", 404);
  const resto = elenco.filter((a) => a.id !== id);
  chiudiPrincipale(f, resto);
  if (tolta.token === f.tokenAmbiente) scriviValore(f.db, "costructoAmbienteTolto", true);
  return tolta;
}

export async function rinominaAzienda(f: FonteAziende, id: string, nome: string): Promise<AziendaSalvata> {
  const n = pulisciNome(nome);
  if (!n) throw new ErroreAziende("Scrivi un nome.");
  const elenco = await elencoConPrincipale(f, urlCostructo(f));
  const a = elenco.find((x) => x.id === id);
  if (!a) throw new ErroreAziende("Azienda non trovata.", 404);
  if (elenco.some((x) => x.id !== id && x.nome.toLowerCase() === n.toLowerCase())) throw new ErroreAziende(`C'è già un'azienda che si chiama «${n}».`);
  a.nome = n;
  chiudiPrincipale(f, elenco);
  return a;
}

/** Il vecchio campo «token» unico (PUT /api/collegamenti): vale solo finché non ci sono più aziende nell'elenco. */
export function salvaTokenPrincipale(f: FonteAziende, token: string): void {
  if (elencoSalvato(f).length) throw new ErroreAziende("Ci sono già aziende collegate: usa «Aggiungi» o «Rimuovi».");
  const t = token.trim();
  if (t && !FORMATO_TOKEN.test(t)) throw new ErroreAziende("Il token di Costructo deve iniziare con csa_.");
  salvaSegreto(f.db, f.cifratore, "costructo_token", t);
  scriviValore(f.db, "aziendaPrincipale", {});
  if (t) scriviValore(f.db, "costructoAmbienteTolto", false);
}

/** «Prova il collegamento»: chiede /io per ogni azienda. Per il vecchio token impara anche il nome. */
export async function provaAziende(f: FonteAziende): Promise<Array<{ id: string; nome: string; ok: boolean; messaggio: string }>> {
  const url = urlCostructo(f);
  const elenco = leggiAziende(f);
  return Promise.all(elenco.map(async (a) => {
    if (!url) return { id: a.id, nome: a.nome, ok: false, messaggio: "Manca l'indirizzo di Costructo." };
    try {
      const io = await chiediIo(url, a.token, f.fetchFn);
      let nome = a.nome;
      if (a.id === ID_PRINCIPALE && !elencoSalvato(f).length && (io.nome || io.aziendaId)) {
        nome = a.nome === NOME_PRINCIPALE && io.nome ? io.nome : a.nome;
        scriviValore(f.db, "aziendaPrincipale", { nome, aziendaId: io.aziendaId });
      }
      return { id: a.id, nome, ok: true, messaggio: "Collegamento riuscito." };
    } catch (e) {
      return { id: a.id, nome: a.nome, ok: false, messaggio: (e as Error).message };
    }
  }));
}

// ---------------------------------------------------------------- per gli strumenti dell'AI

const normalizza = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Trova le aziende che corrispondono a quello che ha detto Luigi (id, oppure nome contenuto). */
export function trovaAziende<T extends { id: string; nome: string }>(aziende: T[], richiesta: string): T[] {
  const r = normalizza(richiesta);
  if (!r) return [];
  const perId = aziende.filter((a) => a.id.toLowerCase() === r);
  if (perId.length) return perId;
  const esatte = aziende.filter((a) => normalizza(a.nome) === r);
  if (esatte.length) return esatte;
  return aziende.filter((a) => { const n = normalizza(a.nome); return n.includes(r) || r.includes(n); });
}

/** Elenco dei nomi da dire a voce: «Edilgreen o Rossi Costruzioni». */
export function nomiAziende(aziende: Array<{ nome: string }>, congiunzione = "o"): string {
  const n = aziende.map((a) => a.nome);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} ${congiunzione} ${n.at(-1)}`;
}
