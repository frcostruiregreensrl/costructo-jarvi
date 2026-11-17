// Connettore Costructo: legge dal modulo /api/assistente/v1 con un token Bearer «csa_…».
// SOLA LETTURA in Fase 1. Il client è tollerante: ogni campo è facoltativo e i dati restano DATI
// (marcati come non attendibili quando vanno all'AI).
import { z } from "zod";

export class ErroreCostructo extends Error {
  constructor(messaggio: string, readonly codice: "non_configurato" | "token" | "permesso" | "non_trovato" | "server" | "rete" | "risposta") {
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
  id: testo, numero: testo, cliente: testo, importo: numero, residuo: numero, scadenza: testo,
}).passthrough();

/** Accetta sia un array sia un oggetto con l'array sotto una di queste chiavi. */
function lista<T extends z.ZodTypeAny>(schema: T, chiavi: string[]) {
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
    if (!r.ok) throw new ErroreCostructo(`Costructo ha avuto un problema (${r.status}).`, "server");
    const lunghezza = Number(r.headers.get("content-length") || 0);
    if (lunghezza > MAX_BYTE) throw new ErroreCostructo("Risposta di Costructo troppo grande.", "risposta");
    const corpo = await r.text();
    if (corpo.length > MAX_BYTE) throw new ErroreCostructo("Risposta di Costructo troppo grande.", "risposta");
    let dati: unknown;
    try { dati = JSON.parse(corpo); } catch { throw new ErroreCostructo("Risposta di Costructo non leggibile.", "risposta"); }
    return { fonte: "costructo", attendibile: false, percorso, dati };
  }

  return {
    configurato,
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
