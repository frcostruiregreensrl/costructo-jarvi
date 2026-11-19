// 360dialog FINTO, solo per i test (parte 2): nessuna chiamata vera a 360dialog o a Meta.
// Risponde come la API v2 di 360dialog [formati non verificati con un account vero]:
//   POST /v1/configs/webhook     → configurazione del webhook {url, headers}
//   POST /messages               → invio (stesso corpo della Cloud API di Meta), risposta con l'id del messaggio
//   GET  /health_status          → prova del collegamento
//   POST /smb_app_data           → sincronizzazione di contatti e storico (coesistenza)
//   GET  /{id del media}         → informazioni dell'allegato con un url di Meta (lookaside.fbsbx.com)
//   GET  /whatsapp_business/attachments/?mid=… → i byte dell'allegato (360dialog fa da tramite)
// Un fetch finto gira QUALUNQUE indirizzo https a questo server locale e ricorda il nome del server chiesto
// (così i test vedono se una chiave è andata dove non doveva) e l'opzione «redirect» usata.
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export const BASE_360_FINTA = "https://waba-v2.360dialog.io";
export const CHIAVE_360 = "chiave-360dialog-finta-0123456789";

export interface RichiestaD360 { metodo: string; host: string; percorso: string; intestazioni: Record<string, string>; corpo: Record<string, unknown>; redirect: string }
type Risposta = { stato?: number; corpo?: unknown; intestazioni?: Record<string, string> };

export interface D360Finto {
  url: string;
  richieste: RichiestaD360[];
  /** Risposte in coda (una per richiesta, qualunque percorso); finite queste, risposte normali. */
  prossime: Risposta[];
  media: Record<string, { mime: string; dati: Buffer }>;
  /** Url dell'allegato dato da GET /{id} (di serie quello di Meta). */
  urlMedia: (id: string) => string;
  fetch: typeof fetch;
  chiudi: () => Promise<void>;
}

/** Risoluzione dei nomi finta: 360dialog e Meta hanno un indirizzo pubblico (nessun DNS vero). */
export const risolvi360 = async (host: string): Promise<string[]> => {
  if (/(^|\.)360dialog\.io$/.test(host) || /(^|\.)(facebook\.com|fbsbx\.com|whatsapp\.net)$/.test(host)) return ["93.184.216.34"];
  throw Object.assign(new Error("non trovato"), { code: "ENOTFOUND" });
};

export async function avviaD360Finto(): Promise<D360Finto> {
  let n = 0;
  const redirectDi = new Map<string, string>();
  const m: D360Finto = {
    url: "", richieste: [], prossime: [], media: {}, fetch: fetch, chiudi: async () => {},
    urlMedia: (id) => `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${encodeURIComponent(id)}&ext=1`,
  };
  const server: Server = createServer((req, res) => {
    let grezzo = "";
    req.on("data", (d) => { grezzo += d; });
    req.on("end", () => {
      let corpo: Record<string, unknown> = {};
      try { corpo = JSON.parse(grezzo); } catch { /* vuoto */ }
      const segnaposto = String(req.headers["x-segnaposto"] || "");
      m.richieste.push({
        metodo: req.method || "", host: String(req.headers["x-host-originale"] || ""), percorso: req.url || "",
        intestazioni: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== "x-segnaposto").map(([k, v]) => [k, String(v)])), corpo,
        redirect: redirectDi.get(segnaposto) ?? "",
      });
      redirectDi.delete(segnaposto);
      const json = (stato: number, c: unknown, h: Record<string, string> = {}) => res.writeHead(stato, { "Content-Type": "application/json", ...h }).end(JSON.stringify(c));
      const pronta = m.prossime.shift();
      if (pronta) return json(pronta.stato ?? 200, pronta.corpo ?? {}, pronta.intestazioni);
      const u = new URL(req.url || "/", "http://x");
      if (req.method === "POST" && u.pathname === "/v1/configs/webhook") return json(200, { url: corpo.url });
      if (req.method === "POST" && u.pathname.endsWith("/messages")) return json(200, { messaging_product: "whatsapp", contacts: [{ input: corpo.to, wa_id: corpo.to }], messages: [{ id: `wamid.360.${++n}` }] });
      if (req.method === "POST" && u.pathname.endsWith("/smb_app_data")) return json(200, { success: true });
      if (req.method === "GET" && u.pathname === "/health_status") return json(200, { health_status: { can_send_message: "AVAILABLE", entities: [] } });
      if (req.method === "GET" && u.pathname === "/whatsapp_business/attachments/") {
        const f = m.media[u.searchParams.get("mid") ?? ""];
        if (f) { res.writeHead(200, { "Content-Type": f.mime }).end(f.dati); return; }
        return json(404, { error: { code: 100 } });
      }
      if (req.method === "GET") {
        const id = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
        const x = m.media[id];
        if (!x) return json(404, { error: { code: 100 } });
        return json(200, { messaging_product: "whatsapp", url: m.urlMedia(id), mime_type: x.mime, sha256: createHash("sha256").update(x.dati).digest("hex"), file_size: x.dati.length, id });
      }
      json(404, { error: { code: 100, message: "percorso sconosciuto" } });
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let k = 0;
  m.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.protocol !== "https:") throw new Error("solo https");
    const h = new Headers(init?.headers);
    h.set("x-host-originale", u.host);
    const segnaposto = String(++k);
    h.set("x-segnaposto", segnaposto);
    redirectDi.set(segnaposto, String(init?.redirect ?? "follow"));
    // «manual»: il server finto non segue mai i reindirizzamenti; il codice di Jarvis deve rifiutarli da sé.
    return fetch(`${m.url}${u.pathname}${u.search}`, { ...init, headers: h, redirect: "manual" });
  }) as typeof fetch;
  m.chiudi = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return m;
}
