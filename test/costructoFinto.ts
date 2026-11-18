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
export interface Finto {
  url: string;
  richieste: Array<{ percorso: string; auth: string }>;
  /** Risposte per il primo token (TOKEN). */
  risposte: Record<string, Risposta>;
  /** Risposte per il secondo token (TOKEN_2). */
  risposte2: Record<string, Risposta>;
  chiudi: () => Promise<void>;
}

export async function avviaCostructoFinto(): Promise<Finto> {
  const f: Finto = { url: "", richieste: [], risposte: {}, risposte2: {}, chiudi: async () => {} };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    const auth = String(req.headers.authorization || "");
    f.richieste.push({ percorso: u.pathname + u.search, auth });
    const token = auth.replace(/^Bearer /, "");
    const tabella = auth === `Bearer ${TOKEN}` ? f.risposte : auth === `Bearer ${TOKEN_2}` ? f.risposte2 : null;
    if (!tabella) { res.writeHead(401).end("{}"); return; }
    const chiave = u.pathname.replace("/api/assistente/v1", "");
    const io = { versione: 1, token: { id: 1, etichetta: "Jarvis", ambiti: ["lettura"] }, azienda: AZIENDE_FINTE[token] };
    const r = tabella[chiave] ?? (chiave === "/io" ? { corpo: io } : { stato: 404, corpo: { errore: "non trovato" } });
    setTimeout(() => {
      res.writeHead(r.stato ?? 200, { "Content-Type": "application/json" });
      res.end(typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {}));
    }, r.ritardoMs ?? 0);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.chiudi = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}
