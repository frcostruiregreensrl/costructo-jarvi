// Scaricamento di un allegato dalla WhatsApp Business Platform (Cloud API). SPENTO di serie (Impostazioni →
// «Scarica foto e PDF»): senza, Jarvis vede solo tipo, nome del file e didascalia, come nella parte 1.
//   1) GET https://graph.facebook.com/{versione}/{id del media} (stesso token degli invii) → {url, mime_type, sha256, file_size}
//   2) GET {url} con lo stesso token, SUBITO: l'indirizzo vale solo 5 minuti.
// Con un fornitore (BSP, per esempio 360dialog) le stesse richieste passano dal suo indirizzo, con la sua chiave.
// Il token va SOLO a Meta (graph.facebook.com e gli indirizzi dei file di Meta, *.fbsbx.com / *.whatsapp.net) o al fornitore
// configurato: nessun reindirizzamento, tempo massimo, dimensione massima, impronta del contenuto controllata.
import { createHash } from "node:crypto";
import type { RisolviNome } from "../calendario.js";
import { BASE_META, controllaFornitoreInRete, invioPronto } from "./collegamento.js";
import { intestazioniInvio } from "./invio.js";
import { ErroreWhatsapp, type CollegamentoWa } from "./tipi.js";

/** WhatsApp: al massimo 16 MB per audio e video, 100 MB per i documenti. Jarvis ne prende al massimo 16. */
export const MAX_BYTE_MEDIA = 16 * 1024 * 1024;

export interface MediaScaricato { dati: Buffer; mime: string; sha256: string; dimensione: number }
export interface OpzioniMedia { fetchFn?: typeof fetch; risolvi?: RisolviNome; maxByte?: number; timeoutMs?: number }

/** Indirizzi dei file di Meta a cui si può mandare il token. */
export function hostMediaAmmesso(host: string): boolean {
  const h = host.toLowerCase();
  return h === "graph.facebook.com" || h === "lookaside.fbsbx.com" || h.endsWith(".fbsbx.com") || h.endsWith(".whatsapp.net");
}

export async function scaricaMedia(c: CollegamentoWa | null, idMedia: string, o: OpzioniMedia = {}): Promise<MediaScaricato> {
  if (!invioPronto(c)) throw new ErroreWhatsapp("WhatsApp non è collegato: non posso scaricare l'allegato.");
  if (!/^[A-Za-z0-9_.\-]{1,100}$/.test(idMedia)) throw new ErroreWhatsapp("Id dell'allegato non valido.");
  const f = o.fetchFn ?? fetch;
  const max = Math.min(o.maxByte ?? MAX_BYTE_MEDIA, MAX_BYTE_MEDIA);
  const base = c.provider === "bsp" ? await controllaFornitoreInRete(c.baseUrl, o.risolvi) : `${BASE_META}/${encodeURIComponent(c.versione)}`;
  const intestazioni = intestazioniInvio(c);
  delete intestazioni["Content-Type"];
  const chiedi = async (url: string, accetta: string) => {
    try {
      return await f(url, { headers: { ...intestazioni, Accept: accetta }, redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
    } catch { throw new ErroreWhatsapp("WhatsApp non risponde: allegato non scaricato.", 502); }
  };
  const r1 = await chiedi(`${base}/${encodeURIComponent(idMedia)}`, "application/json");
  if (!r1.ok) throw new ErroreWhatsapp(r1.status === 404 ? "Allegato non più disponibile su WhatsApp." : `WhatsApp non ha dato l'allegato (${r1.status}).`, 502);
  let info: { url?: unknown; mime_type?: unknown; sha256?: unknown; file_size?: unknown } = {};
  try { info = JSON.parse((await r1.text()).slice(0, 64 * 1024)); } catch { /* sotto */ }
  if (typeof info.url !== "string") throw new ErroreWhatsapp("Risposta di WhatsApp non leggibile.", 502);
  if (Number(info.file_size) > max) throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413);
  let u: URL;
  try { u = new URL(info.url); } catch { throw new ErroreWhatsapp("Indirizzo dell'allegato non valido.", 502); }
  if (u.protocol !== "https:" || u.username || u.password) throw new ErroreWhatsapp("Indirizzo dell'allegato non ammesso.", 502);
  let finale: string;
  if (c.provider === "bsp") {
    // Il fornitore fa da tramite: stesso percorso del file, ma sul suo indirizzo (la chiave va solo lì).
    finale = `${new URL(base).origin}${u.pathname}${u.search}`;
  } else {
    if (!hostMediaAmmesso(u.hostname)) throw new ErroreWhatsapp("Indirizzo dell'allegato fuori da Meta: non lo scarico.", 502);
    finale = u.href;
  }
  const r2 = await chiedi(finale, "*/*");
  if (!r2.ok) throw new ErroreWhatsapp(`WhatsApp non ha dato il file (${r2.status}): forse sono passati più di 5 minuti.`, 502);
  if (Number(r2.headers.get("content-length") || 0) > max) throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413);
  const dati = Buffer.from(await r2.arrayBuffer());
  if (dati.length > max) { dati.fill(0); throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413); }
  const sha256 = createHash("sha256").update(dati).digest("hex");
  const atteso = typeof info.sha256 === "string" ? info.sha256.trim() : "";
  if (atteso && atteso.toLowerCase() !== sha256 && atteso !== createHash("sha256").update(dati).digest("base64")) {
    dati.fill(0);
    throw new ErroreWhatsapp("L'allegato scaricato non corrisponde a quello di WhatsApp: scartato.", 502);
  }
  const mime = String(info.mime_type ?? r2.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100);
  return { dati, mime, sha256, dimensione: dati.length };
}
