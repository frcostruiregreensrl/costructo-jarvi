// Server Costructo FINTO, solo per i test: risponde come il futuro modulo /api/assistente/v1.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "csa_prova_1234567890";

export interface Finto { url: string; richieste: Array<{ percorso: string; auth: string }>; risposte: Record<string, { stato?: number; corpo?: unknown; ritardoMs?: number }>; chiudi: () => Promise<void> }

export async function avviaCostructoFinto(): Promise<Finto> {
  const f: Finto = { url: "", richieste: [], risposte: {}, chiudi: async () => {} };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    f.richieste.push({ percorso: u.pathname + u.search, auth: String(req.headers.authorization || "") });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end("{}"); return; }
    const chiave = u.pathname.replace("/api/assistente/v1", "");
    const r = f.risposte[chiave] ?? { stato: 404, corpo: { errore: "non trovato" } };
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
