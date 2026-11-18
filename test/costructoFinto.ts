// Server Costructo FINTO, solo per i test: risponde come il futuro modulo /api/assistente/v1.
// Due token finti = due aziende finte, ognuna con le sue risposte. /io dice di quale azienda è il token.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "csa_prova_1234567890";
/** Token della seconda azienda finta. */
export const TOKEN_2 = "csa_seconda_azienda_4321";
/** Le aziende finte dietro ai due token (come /io di Costructo). */
export const AZIENDE_FINTE: Record<string, { id: number; nome: string }> = {
  [TOKEN]: { id: 11, nome: "Edilgreen" },
  [TOKEN_2]: { id: 22, nome: "Rossi Costruzioni" },
};

type Risposta = { stato?: number; corpo?: unknown; ritardoMs?: number };
/** Fase 3b: una risposta può essere calcolata dalla richiesta (metodo, corpo JSON, parametri). */
export type RichiestaFinta = { metodo: string; corpo: unknown; parametri: URLSearchParams; percorso: string };
type Voce = Risposta | ((r: RichiestaFinta) => Risposta);
export interface Finto {
  url: string;
  richieste: Array<{ percorso: string; auth: string; metodo: string; corpo: unknown }>;
  /** Risposte per il primo token (TOKEN). */
  risposte: Record<string, Voce>;
  /** Risposte per il secondo token (TOKEN_2). */
  risposte2: Record<string, Voce>;
  chiudi: () => Promise<void>;
}

export async function avviaCostructoFinto(): Promise<Finto> {
  const f: Finto = { url: "", richieste: [], risposte: {}, risposte2: {}, chiudi: async () => {} };
  const server: Server = createServer((req, res) => {
    const pezzi: Buffer[] = [];
    req.on("data", (d: Buffer) => pezzi.push(d));
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://x");
      const auth = String(req.headers.authorization || "");
      let corpo: unknown = null;
      if (pezzi.length) { try { corpo = JSON.parse(Buffer.concat(pezzi).toString("utf8")); } catch { corpo = Buffer.concat(pezzi).toString("utf8"); } }
      const metodo = req.method || "GET";
      f.richieste.push({ percorso: u.pathname + u.search, auth, metodo, corpo });
      const token = auth.replace(/^Bearer /, "");
      const tabella = auth === `Bearer ${TOKEN}` ? f.risposte : auth === `Bearer ${TOKEN_2}` ? f.risposte2 : null;
      if (!tabella) { res.writeHead(401).end("{}"); return; }
      const chiave = u.pathname.replace("/api/assistente/v1", "");
      const io = { versione: 1, token: { id: 1, etichetta: "Jarvis", ambiti: ["lettura"] }, azienda: AZIENDE_FINTE[token] };
      // «/proposte/123» usa la voce «/proposte/:id» se c'è.
      const voce = tabella[chiave] ?? (/^\/proposte\/[^/]+$/.test(chiave) ? tabella["/proposte/:id"] : undefined);
      const r: Risposta = typeof voce === "function" ? voce({ metodo, corpo, parametri: u.searchParams, percorso: chiave })
        : voce ?? (chiave === "/io" ? { corpo: io } : { stato: 404, corpo: { errore: "non trovato" } });
      setTimeout(() => {
        res.writeHead(r.stato ?? 200, { "Content-Type": "application/json" });
        res.end(typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {}));
      }, r.ritardoMs ?? 0);
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.chiudi = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

/**
 * Fase 3b: la pagina Proposte di Costructo, finta, con il contratto come l'ha fatto Costructo (zod stretto: campi in più → 400).
 * POST /proposte: 201 con la vista; 200 con la stessa vista e `doppione: true` (stessa chiaveDoppione); 409 {error, motivo} se
 * `doppione(corpo)` dice che il record c'è già; 400 {error, campi}. GET /proposte/:id → {proposta}; GET /proposte → {proposte}.
 */
const CAMPI_CORPO = new Set(["tipo", "chiaveDoppione", "origine", "rifEsterno", "titolo", "dati", "allegati"]);
const CAMPI_DATI: Record<string, string[]> = {
  ore: ["operaioId", "cantiereId", "data", "ore", "oreEconomia", "descrizione"],
  foto: ["cantiereId", "data", "tipo", "descrizione"],
  rinnovo_documento: ["voceId", "ditta", "tipoDocumento", "dataScadenza"],
  carico_magazzino: ["cantiereId", "fornitore", "righe"],
  richiesta_lavoro: ["nome", "telefono", "email", "indirizzo", "descrizione", "sopralluogo"],
  agenda: ["data", "ora", "titolo", "descrizione", "cantiereId"],
  contatto: ["controparteId", "telefono"],
  documento_fornitore: ["fornitore", "piva", "numero", "data", "importo", "tipo"],
  diario: ["cantiereId", "data", "testo"],
  invio_documenti: ["voceIds", "destinatario", "controparteId"],
};
const FIRME: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/heic": (b) => b.subarray(4, 8).toString("latin1") === "ftyp",
};

export function controllaCorpo(c: Record<string, unknown>): string[] {
  const campi: string[] = [];
  for (const k of Object.keys(c)) if (!CAMPI_CORPO.has(k)) campi.push(k);
  if (typeof c.chiaveDoppione !== "string" || !/^\S{1,120}$/.test(c.chiaveDoppione)) campi.push("chiaveDoppione");
  if (!["whatsapp", "email", "jarvis"].includes(String(c.origine))) campi.push("origine");
  if (typeof c.titolo !== "string" || !c.titolo || c.titolo.length > 140) campi.push("titolo");
  const ammessi = CAMPI_DATI[String(c.tipo)];
  if (!ammessi) campi.push("tipo");
  else for (const k of Object.keys((c.dati ?? {}) as object)) if (!ammessi.includes(k)) campi.push(`dati.${k}`);
  const allegati = (c.allegati ?? []) as Array<{ nome?: unknown; mime?: unknown; base64?: unknown }>;
  if (!Array.isArray(allegati) || allegati.length > 5) campi.push("allegati");
  else allegati.forEach((a, i) => {
    if (Object.keys(a).some((k) => !["nome", "mime", "base64"].includes(k))) campi.push(`allegati.${i}`);
    const firma = FIRME[String(a.mime)];
    const b = Buffer.from(String(a.base64 ?? ""), "base64");
    if (!firma || !firma(b) || b.length > 10 * 1024 * 1024) campi.push(`allegati.${i}.base64`);
  });
  return campi;
}

export function propostePagina(doppione: (corpo: Record<string, unknown>) => string | null = () => null) {
  const ricevute: Array<Record<string, unknown> & { id: string; stato: string }> = [];
  let n = 0;
  const vista = (x: Record<string, unknown>) => ({
    id: x.id, tipo: x.tipo, titolo: x.titolo, stato: x.stato, motivo: x.motivo ?? null, origine: x.origine, rifEsterno: x.rifEsterno ?? null,
    chiaveDoppione: x.chiaveDoppione, creatoIl: x.creatoIl, decisoIl: x.decisoIl ?? null, record: null,
    allegati: ((x.allegati ?? []) as Array<{ nome: string; mime: string }>).map((a) => ({ nome: a.nome, mime: a.mime })), avvisi: [],
  });
  const gestisci = (r: RichiestaFinta): Risposta => {
    if (r.metodo === "POST" && r.percorso === "/proposte") {
      const c = (r.corpo ?? {}) as Record<string, unknown>;
      const campi = controllaCorpo(c);
      if (campi.length) return { stato: 400, corpo: { error: "Dati della proposta non validi", campi } };
      const gia = ricevute.find((x) => x.chiaveDoppione === c.chiaveDoppione);
      if (gia) return { stato: 200, corpo: { ...vista(gia), doppione: true } };
      const motivo = doppione(c);
      if (motivo) return { stato: 409, corpo: { error: "Doppione", motivo } };
      const nuova = { ...c, id: `P${++n}`, stato: "in_attesa", creatoIl: new Date().toISOString() };
      ricevute.push(nuova);
      return { stato: 201, corpo: vista(nuova) };
    }
    if (r.metodo === "GET" && /^\/proposte\/[^/]+$/.test(r.percorso)) {
      const x = ricevute.find((p) => p.id === r.percorso.split("/")[2]);
      return x ? { corpo: { proposta: vista(x) } } : { stato: 404, corpo: { error: "Proposta non trovata", campo: "id" } };
    }
    if (r.metodo === "GET" && r.percorso === "/proposte") {
      const stato = r.parametri.get("stato"), tipo = r.parametri.get("tipo");
      return { corpo: { proposte: ricevute.filter((x) => (!stato || x.stato === stato) && (!tipo || x.tipo === tipo)).map(vista) } };
    }
    return { stato: 405, corpo: { error: "Metodo non ammesso" } };
  };
  return { ricevute, gestisci };
}

/** Risposta di /v1/ore come la dà Costructo: verifica per operaio, cantiere e giorno. */
export const verificaOre = (esiste: boolean) => ({ corpo: { verifica: { esiste, registrazioni: esiste ? [{ id: 1, ore: 8 }] : [], rapportini: [] } } });
