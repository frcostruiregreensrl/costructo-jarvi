// Connettore Costructo: legge dal modulo /api/assistente/v1 con un token Bearer «csa_…».
// Lettura (Fase 1) + Fase 3b: UNA sola scrittura, le PROPOSTE (POST /proposte, ambito «proposte»): bozze innocue che
// Luigi approva in Costructo. Jarvis non scrive mai record definitivi. Il client è tollerante: ogni campo è facoltativo
// e i dati restano DATI (marcati come non attendibili quando vanno all'AI).
import { z } from "zod";

export class ErroreCostructo extends Error {
  constructor(messaggio: string, readonly codice: "non_configurato" | "token" | "permesso" | "non_trovato" | "server" | "rete" | "risposta" | "non_disponibile" | "doppione") {
    super(messaggio);
  }
}

export interface DatiCostructo<T = unknown> {
  fonte: "costructo";
  attendibile: false;
  percorso: string;
  dati: T;
}

const MAX_BYTE = 1024 * 1024;
const testo = z.union([z.string(), z.number()]).transform(String).optional().catch(undefined);
const numero = z.union([z.number(), z.string().transform(Number)]).pipe(z.number().finite()).optional().catch(undefined);

export const SchemaImpegno = z.object({
  id: testo, titolo: testo, inizio: testo, fine: testo, luogo: testo, cantiere: testo, tipo: testo,
  cliente: testo, telefono: testo, controparteId: testo, cantiereId: testo,
}).passthrough();
export const SchemaCantiere = z.object({
  id: testo, nome: testo, indirizzo: testo, stato: testo, cliente: testo, lat: numero, lon: numero,
}).passthrough();
export const SchemaScadenza = z.object({
  id: testo, titolo: testo, descrizione: testo, scadenza: testo, data: testo, importo: numero, tipo: testo,
}).passthrough();
export const SchemaDocumento = z.object({
  id: testo, titolo: testo, nome: testo, scadenza: testo, tipo: testo, intestatario: testo,
}).passthrough();
export const SchemaFattura = z.object({
  id: testo, numero: testo, cliente: testo, importo: numero, residuo: numero, scadenza: testo, telefono: testo, controparteId: testo,
}).passthrough();
// Fase 3b
export const SchemaOperaio = z.object({ id: testo, nome: testo, cognome: testo, attivo: z.boolean().optional().catch(undefined) }).passthrough();
export const SchemaControparte = z.object({ id: testo, nome: testo, ragioneSociale: testo, telefono: testo, email: testo, tipo: testo }).passthrough();
export const SchemaPreventivo = z.object({
  id: testo, numero: testo, titolo: testo, oggetto: testo, cliente: testo, controparteId: testo, telefono: testo, stato: testo, dataInvio: testo, data: testo,
}).passthrough();
export const SchemaVoceDocumento = z.object({
  id: testo, titolo: testo, nome: testo, tipo: testo, tipoDocumento: testo, ditta: testo, intestatario: testo, azienda: testo, aziendaId: testo,
  scadenza: testo, dataScadenza: testo,
}).passthrough();
export const SchemaOreCostructo = z.object({ id: testo, operaioId: testo, cantiereId: testo, data: testo, ore: numero }).passthrough();
export const SchemaPropostaCostructo = z.object({
  id: testo, tipo: testo, titolo: testo, stato: testo, motivo: testo, decisoIl: testo, record: z.unknown().optional(),
}).passthrough();
export const SchemaInventario = z.object({ id: testo, descrizione: testo, nome: testo, unita: testo }).passthrough();
export type Operaio = z.infer<typeof SchemaOperaio>;
export type Controparte = z.infer<typeof SchemaControparte>;
export type VoceDocumento = z.infer<typeof SchemaVoceDocumento>;
export type PropostaCostructo = z.infer<typeof SchemaPropostaCostructo>;

/** Corpo di una proposta per Costructo (contratto di POST /api/assistente/v1/proposte). */
export interface CorpoProposta {
  tipo: string;
  chiaveDoppione: string;
  origine: "whatsapp" | "email" | "jarvis";
  rifEsterno?: string;
  titolo: string;
  dati: Record<string, unknown>;
  allegati?: Array<{ nome: string; mime: string; base64: string }>;
}

/** Accetta sia un array sia un oggetto con l'array sotto una di queste chiavi. */
export function lista<T extends z.ZodTypeAny>(schema: T, chiavi: string[]) {
  return z.unknown().transform((v): Array<z.infer<T>> => {
    let arr: unknown = v;
    if (!Array.isArray(arr) && arr && typeof arr === "object") {
      for (const k of [...chiavi, "elementi", "dati", "items", "risultati"]) {
        const x = (arr as Record<string, unknown>)[k];
        if (Array.isArray(x)) { arr = x; break; }
      }
    }
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 200).map((x) => schema.safeParse(x)).filter((r) => r.success).map((r) => r.data as z.infer<T>);
  });
}

export const SchemaBriefing = z.object({
  impegni: lista(SchemaImpegno, ["impegni", "agenda"]).optional(),
  cantieri: lista(SchemaCantiere, ["cantieri"]).optional(),
  scadenze: lista(SchemaScadenza, ["scadenze"]).optional(),
  documentiInScadenza: lista(SchemaDocumento, ["documenti"]).optional(),
  fattureDaIncassare: lista(SchemaFattura, ["fatture"]).optional(),
}).passthrough();
export type BriefingCostructo = z.infer<typeof SchemaBriefing>;

export interface OpzioniCostructo { url: string; token: string; fetchFn?: typeof fetch; timeoutMs?: number }

export function creaClientCostructo(o: OpzioniCostructo) {
  const f = o.fetchFn ?? fetch;
  const configurato = !!(o.url && o.token);

  async function leggi(percorso: string, parametri: Record<string, string | number> = {}): Promise<DatiCostructo> {
    if (!configurato) throw new ErroreCostructo("Costructo non è ancora collegato.", "non_configurato");
    if (!/^csa_[A-Za-z0-9_\-]{8,}$/.test(o.token)) throw new ErroreCostructo("Il token di Costructo non ha il formato giusto (csa_…).", "token");
    const u = new URL(`${o.url}/api/assistente/v1${percorso}`);
    for (const [k, v] of Object.entries(parametri)) u.searchParams.set(k, String(v));
    let r: Response;
    try {
      r = await f(u, {
        headers: { Authorization: `Bearer ${o.token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
    } catch {
      throw new ErroreCostructo("Costructo non risponde in questo momento.", "rete");
    }
    if (r.status === 401) throw new ErroreCostructo("Costructo non accetta il token: va rigenerato.", "token");
    if (r.status === 403) throw new ErroreCostructo("Il token di Costructo non ha il permesso per questi dati.", "permesso");
    if (r.status === 404) throw new ErroreCostructo("Questa funzione non c'è ancora in Costructo.", "non_trovato");
    if (r.status === 405) throw new ErroreCostructo("Questa funzione non c'è ancora in Costructo.", "non_disponibile");
    if (!r.ok) throw new ErroreCostructo(`Costructo ha avuto un problema (${r.status}).`, "server");
    const lunghezza = Number(r.headers.get("content-length") || 0);
    if (lunghezza > MAX_BYTE) throw new ErroreCostructo("Risposta di Costructo troppo grande.", "risposta");
    const corpo = await r.text();
    if (corpo.length > MAX_BYTE) throw new ErroreCostructo("Risposta di Costructo troppo grande.", "risposta");
    let dati: unknown;
    try { dati = JSON.parse(corpo); } catch { throw new ErroreCostructo("Risposta di Costructo non leggibile.", "risposta"); }
    return { fonte: "costructo", attendibile: false, percorso, dati };
  }

  /**
   * L'unica scrittura: una PROPOSTA. 201 nuova, 200 già esistente (stessa chiaveDoppione), 409 doppione trovato da
   * Costructo (per esempio il rapportino c'è già), 404/405 = la pagina Proposte non c'è ancora, 403 = token senza
   * l'ambito «proposte». Ripetere è sicuro: la chiave doppione rende la richiesta idempotente.
   */
  async function proponi(corpo: CorpoProposta): Promise<{ id: string; stato: string; esistente: boolean }> {
    if (!configurato) throw new ErroreCostructo("Costructo non è ancora collegato.", "non_configurato");
    if (!/^csa_[A-Za-z0-9_\-]{8,}$/.test(o.token)) throw new ErroreCostructo("Il token di Costructo non ha il formato giusto (csa_…).", "token");
    let r: Response;
    try {
      r = await f(new URL(`${o.url}/api/assistente/v1/proposte`), {
        method: "POST",
        headers: { Authorization: `Bearer ${o.token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        redirect: "error",
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch {
      throw new ErroreCostructo("Costructo non risponde in questo momento.", "rete");
    }
    const grezzo = (await r.text().catch(() => "")).slice(0, MAX_BYTE);
    let dati: Record<string, unknown> = {};
    try { const j = JSON.parse(grezzo); if (j && typeof j === "object") dati = j as Record<string, unknown>; } catch { /* non JSON */ }
    if (r.status === 409) throw new ErroreCostructo(String(dati.motivo ?? "già presente in Costructo").slice(0, 300), "doppione");
    if (r.status === 404 || r.status === 405) throw new ErroreCostructo("In attesa della pagina Proposte in Costructo.", "non_disponibile");
    if (r.status === 401) throw new ErroreCostructo("Costructo non accetta il token: va rigenerato.", "token");
    if (r.status === 403) throw new ErroreCostructo("In attesa della pagina Proposte in Costructo (il token non ha l'ambito «proposte»).", "non_disponibile");
    if (r.status === 413) throw new ErroreCostructo("Proposta troppo grande per Costructo (allegati).", "risposta");
    if (!r.ok) throw new ErroreCostructo(`Costructo ha avuto un problema (${r.status}).`, r.status >= 500 ? "server" : "risposta");
    const id = dati.id !== undefined && dati.id !== null ? String(dati.id).slice(0, 80) : "";
    if (!id) throw new ErroreCostructo("Risposta di Costructo non leggibile.", "risposta");
    return { id, stato: String(dati.stato ?? "in_attesa").slice(0, 30), esistente: r.status === 200 };
  }

  return {
    configurato,
    proponi,
    leggiProposta: async (id: string) => {
      const r = await leggi(`/proposte/${encodeURIComponent(id)}`);
      const v = SchemaPropostaCostructo.safeParse(r.dati);
      return v.success ? v.data : null;
    },
    elencaProposte: async (filtro: { stato?: string; dal?: string } = {}) => {
      const p: Record<string, string> = {};
      if (filtro.stato) p.stato = filtro.stato;
      if (filtro.dal) p.dal = filtro.dal;
      const r = await leggi("/proposte", p);
      return lista(SchemaPropostaCostructo, ["proposte"]).parse(r.dati);
    },
    operai: async () => lista(SchemaOperaio, ["operai"]).parse((await leggi("/operai")).dati),
    contropartiLista: async (telefono?: string) => lista(SchemaControparte, ["controparti"]).parse((await leggi("/controparti", telefono ? { telefono } : {})).dati),
    documenti: async () => lista(SchemaVoceDocumento, ["documenti", "voci"]).parse((await leggi("/documenti")).dati),
    oreLista: async (parametri: Record<string, string | number> = {}) => lista(SchemaOreCostructo, ["ore", "rapportini"]).parse((await leggi("/ore", parametri)).dati),
    preventiviLista: async () => lista(SchemaPreventivo, ["preventivi"]).parse((await leggi("/preventivi")).dati),
    inventarioLista: async () => lista(SchemaInventario, ["inventario", "oggetti"]).parse((await leggi("/inventario")).dati),
    agendaLista: async (giorni = 7) => lista(SchemaImpegno, ["impegni", "agenda"]).parse((await leggi("/agenda", { giorni: Math.max(1, Math.min(60, Math.round(giorni))) })).dati),
    io: () => leggi("/io"),
    briefing: async () => {
      const r = await leggi("/briefing");
      const g = (r.dati && typeof r.dati === "object" && !Array.isArray(r.dati) ? r.dati : {}) as Record<string, unknown>;
      const prendi = (...chiavi: string[]) => chiavi.map((k) => g[k]).find((v) => v !== undefined);
      const dati = SchemaBriefing.parse({
        impegni: prendi("impegni", "agenda"),
        cantieri: prendi("cantieri"),
        scadenze: prendi("scadenze", "scadenzario"),
        documentiInScadenza: prendi("documentiInScadenza", "documenti_in_scadenza", "documenti"),
        fattureDaIncassare: prendi("fattureDaIncassare", "fatture_da_incassare", "fatture"),
      });
      return { ...r, dati } as DatiCostructo<BriefingCostructo>;
    },
    agenda: async (giorni = 7) => {
      const r = await leggi("/agenda", { giorni: Math.max(1, Math.min(60, Math.round(giorni))) });
      return { ...r, dati: lista(SchemaImpegno, ["impegni", "agenda"]).parse(r.dati) };
    },
    scadenze: async () => {
      const r = await leggi("/scadenze");
      return { ...r, dati: lista(SchemaScadenza, ["scadenze"]).parse(r.dati) };
    },
    documentiInScadenza: async () => {
      const r = await leggi("/documenti-in-scadenza");
      return { ...r, dati: lista(SchemaDocumento, ["documenti"]).parse(r.dati) };
    },
    cantieri: async () => {
      const r = await leggi("/cantieri");
      return { ...r, dati: lista(SchemaCantiere, ["cantieri"]).parse(r.dati) };
    },
    controparti: () => leggi("/controparti"),
    preventivi: () => leggi("/preventivi"),
    ore: () => leggi("/ore"),
    inventario: () => leggi("/inventario"),
    cerca: (q: string) => {
      const t = q.trim().slice(0, 200);
      if (!t) throw new ErroreCostructo("Cosa devo cercare?", "risposta");
      return leggi("/cerca", { q: t });
    },
  };
}
export type ClientCostructo = ReturnType<typeof creaClientCostructo>;
