// Meta FINTO (e fornitore finto), solo per i test: riceve gli invii dei messaggi come la Cloud API
// (POST /{versione}/{phone_number_id}/messages oppure {base}/messages) e risponde con un id di messaggio.
// Nessuna rete vera: un fetch finto gira le richieste per graph.facebook.com e per il fornitore a questo server locale.
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface RichiestaFinta { metodo: string; host: string; percorso: string; intestazioni: Record<string, string>; corpo: Record<string, unknown> }
type Risposta = { stato?: number; corpo?: unknown };

export interface MetaFinto {
  url: string;
  richieste: RichiestaFinta[];
  /** Risposte in coda (una per richiesta); finite queste, risponde 200 con un id nuovo. */
  prossime: Risposta[];
  /** fetch da dare a Jarvis: le richieste https verso Meta o il fornitore arrivano qui. */
  fetch: typeof fetch;
  chiudi: () => Promise<void>;
}

export async function avviaMetaFinto(): Promise<MetaFinto> {
  let n = 0;
  const m: MetaFinto = { url: "", richieste: [], prossime: [], fetch: fetch, chiudi: async () => {} };
  const server: Server = createServer((req, res) => {
    let grezzo = "";
    req.on("data", (d) => { grezzo += d; });
    req.on("end", () => {
      let corpo: Record<string, unknown> = {};
      try { corpo = JSON.parse(grezzo); } catch { /* vuoto */ }
      m.richieste.push({
        metodo: req.method || "", host: String(req.headers["x-host-originale"] || ""), percorso: req.url || "",
        intestazioni: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), corpo,
      });
      const r = m.prossime.shift() ?? { corpo: { messaging_product: "whatsapp", contacts: [{ input: corpo.to, wa_id: corpo.to }], messages: [{ id: `wamid.finto.${++n}` }] } };
      res.writeHead(r.stato ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(r.corpo ?? {}));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.protocol !== "https:") throw new Error("solo https");
    const h = new Headers(init?.headers);
    h.set("x-host-originale", u.host);
    return fetch(`${m.url}${u.pathname}${u.search}`, { ...init, headers: h, redirect: "manual" });
  }) as typeof fetch;
  m.chiudi = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return m;
}

/** Firma come la fa Meta: «sha256=» + HMAC-SHA256 esadecimale del corpo grezzo con il segreto dell'app. */
export const firma = (corpo: string | Buffer, segreto: string) => `sha256=${createHmac("sha256", segreto).update(corpo).digest("hex")}`;

export const PHONE_NUMBER_ID = "106540352242922";
export const NUMERO_AZIENDA = "393400000001";

/** Un webhook di Meta con un solo cambiamento. */
export function webhook(field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "102290129340398", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: NUMERO_AZIENDA, phone_number_id: PHONE_NUMBER_ID }, ...value } }] }],
  };
}

let contatore = 0;
/** Un messaggio ricevuto (campo «messages»). */
export function ricevuto(o: { da: string; nome?: string; testo?: string; id?: string; quando?: number; tipo?: string; extra?: Record<string, unknown>; gruppo?: string }) {
  const id = o.id ?? `wamid.in.${++contatore}.${Math.random().toString(36).slice(2)}`;
  const tipo = o.tipo ?? "text";
  return webhook("messages", {
    contacts: [{ profile: { name: o.nome ?? "Mario Rossi" }, wa_id: o.da, user_id: `IT.${o.da}` }],
    messages: [{
      from: o.da, from_user_id: `IT.${o.da}`, id, timestamp: String(Math.floor((o.quando ?? Date.now()) / 1000)), type: tipo,
      ...(o.gruppo ? { group_id: o.gruppo } : {}),
      ...(tipo === "text" ? { text: { body: o.testo ?? "Buongiorno" } } : {}),
      ...(o.extra ?? {}),
    }],
  });
}

/** Un messaggio scritto da Luigi con l'app WhatsApp Business sul telefono (campo «smb_message_echoes»). */
export function eco(o: { a: string; testo?: string; quando?: number; id?: string }) {
  return webhook("smb_message_echoes", {
    contacts: [{ wa_id: o.a, user_id: `IT.${o.a}` }],
    message_echoes: [{ from: NUMERO_AZIENDA, to: o.a, to_user_id: `IT.${o.a}`, id: o.id ?? `wamid.eco.${++contatore}`, timestamp: String(Math.floor((o.quando ?? Date.now()) / 1000)), type: "text", text: { body: o.testo ?? "Arrivo" } }],
  });
}
