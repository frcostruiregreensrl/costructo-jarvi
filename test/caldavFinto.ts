// iCloud CalDAV FINTO, solo per i test: un server http locale che risponde come caldav.icloud.com,
// e un fetch che manda lì le richieste dirette a *.icloud.com (registrando tutto). Nessuna rete vera.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const APPLE_ID = "luigi@icloud.example";
export const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

export interface CaldavFinto {
  richieste: Array<{ metodo: string; host: string; percorso: string; corpo: string; depth: string; auth: boolean }>;
  /** Host chiamati dal fetch finto (per controllare che non si esca mai da *.icloud.com). */
  host: string[];
  fetch: typeof fetch;
  /** Se impostato, la prima PROPFIND risponde con un reindirizzamento qui. */
  reindirizza?: string;
  /** Eventi (testo VEVENT) per calendario. */
  eventi: Record<string, string[]>;
  /** Calendari che rispondono con un errore. */
  guasti: Set<string>;
  chiudi: () => Promise<void>;
}

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function avviaCaldavFinto(): Promise<CaldavFinto> {
  const f: CaldavFinto = { richieste: [], host: [], fetch: fetch, eventi: { casa: [], lavoro: [] }, guasti: new Set(), chiudi: async () => {} };
  const server: Server = createServer((req, res) => {
    let corpo = "";
    req.on("data", (d) => { corpo += d; });
    req.on("end", () => {
      const percorso = new URL(req.url || "/", "http://x").pathname;
      const host = String(req.headers["x-host-originale"] || "");
      const auth = req.headers.authorization === `Basic ${Buffer.from(`${APPLE_ID}:${APP_PASSWORD}`).toString("base64")}`;
      f.richieste.push({ metodo: req.method || "", host, percorso, corpo, depth: String(req.headers.depth || ""), auth });
      if (!auth) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="iCloud"' }).end(); return; }
      if (f.reindirizza && percorso === "/" && f.richieste.length === 1) { res.writeHead(301, { Location: f.reindirizza }).end(); return; }
      const multi = (risposte: string) => {
        res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:">${risposte}</multistatus>`);
      };
      if (req.method === "PROPFIND" && percorso === "/") {
        return multi(`<response><href>/</href><propstat><prop><current-user-principal><href>/123456/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
      }
      if (req.method === "PROPFIND" && percorso === "/123456/principal/") {
        return multi(`<response><href>/123456/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p99-caldav.icloud.com:443/123456/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`);
      }
      if (req.method === "PROPFIND" && percorso === "/123456/calendars/") {
        const cal = (id: string, nome: string, colore: string, comp: string) => `<response><href>/123456/calendars/${id}/</href><propstat><prop>
          <displayname>${xml(nome)}</displayname><resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype>
          <A:calendar-color xmlns:A="http://apple.com/ns/ical/">${colore}</A:calendar-color>
          <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="${comp}"/></C:supported-calendar-component-set>
          </prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
        return multi(`<response><href>/123456/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
          + cal("casa", "Casa & famiglia", "#FF2968FF", "VEVENT") + cal("lavoro", "Lavoro EG", "#1BADF8", "VEVENT") + cal("promemoria", "Promemoria", "#CC73E1", "VTODO"));
      }
      const m = /^\/123456\/calendars\/(\w+)\/$/.exec(percorso);
      if (req.method === "REPORT" && m && f.guasti.has(m[1])) { res.writeHead(500).end(); return; }
      if (req.method === "REPORT" && m) {
        const ev = f.eventi[m[1]] ?? [];
        return multi(ev.map((e, i) => `<response><href>/123456/calendars/${m[1]}/e${i}.ics</href><propstat><prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${xml(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${e}\r\nEND:VCALENDAR`)}</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`).join(""));
      }
      res.writeHead(404).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const porta = (server.address() as AddressInfo).port;
  f.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    f.host.push(u.hostname);
    if (!u.hostname.endsWith(".icloud.com") && u.hostname !== "icloud.com") throw new Error(`nel test non si esce: ${u.hostname}`);
    const headers = new Headers(init.headers);
    headers.set("x-host-originale", u.hostname);
    return fetch(`http://127.0.0.1:${porta}${u.pathname}${u.search}`, { ...init, headers });
  }) as typeof fetch;
  f.chiudi = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

/** Ora in formato iCal UTC (20261118T090000Z). */
export const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
