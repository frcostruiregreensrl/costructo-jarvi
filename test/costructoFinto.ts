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
 * Fase 3b: la pagina Proposte di Costructo, finta. POST /proposte: 201 nuova, 200 con la stessa chiaveDoppione,
 * 409 se `doppione(corpo)` dice che il record c'è già. GET /proposte/:id dà lo stato (cambiabile dal test).
 */
export function propostePagina(doppione: (corpo: Record<string, unknown>) => string | null = () => null) {
  const ricevute: Array<Record<string, unknown> & { id: string; stato: string }> = [];
  let n = 0;
  const gestisci = (r: RichiestaFinta): Risposta => {
    if (r.metodo === "POST" && r.percorso === "/proposte") {
      const c = r.corpo as Record<string, unknown>;
      const gia = ricevute.find((x) => x.chiaveDoppione === c.chiaveDoppione);
      if (gia) return { stato: 200, corpo: { id: gia.id, stato: gia.stato } };
      const motivo = doppione(c);
      if (motivo) return { stato: 409, corpo: { motivo } };
      const nuova = { ...c, id: `P${++n}`, stato: "in_attesa" };
      ricevute.push(nuova);
      return { stato: 201, corpo: { id: nuova.id, stato: nuova.stato } };
    }
    if (r.metodo === "GET" && r.percorso.startsWith("/proposte/")) {
      const x = ricevute.find((p) => p.id === r.percorso.split("/")[2]);
      return x ? { corpo: { id: x.id, tipo: x.tipo, titolo: x.titolo, stato: x.stato, motivo: x.motivo ?? "", decisoIl: x.decisoIl ?? "", record: null } } : { stato: 404 };
    }
    return { stato: 405 };
  };
  return { ricevute, gestisci };
}
