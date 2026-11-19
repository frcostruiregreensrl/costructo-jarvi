// Scaricamento di un allegato dalla WhatsApp Business Platform (Cloud API). SPENTO di serie (Impostazioni →
// «Scarica foto e PDF»): senza, Jarvis vede solo tipo, nome del file e didascalia, come nella parte 1.
//   1) GET https://graph.facebook.com/{versione}/{id del media} (stesso token degli invii) → {url, mime_type, sha256, file_size}
//   2) GET {url} con lo stesso token, SUBITO: l'indirizzo vale solo 5 minuti.
// Con 360dialog [non verificato: da controllare al primo allegato vero]:
//   1) GET {indirizzo di 360dialog}/{id del media} con D360-API-KEY → stesse informazioni, con un url di Meta;
//   2) 360dialog fa da tramite: si chiede lo STESSO percorso del file ma sul suo indirizzo (si cambia solo il nome
//      del server: lookaside.fbsbx.com → waba-v2.360dialog.io), sempre con la sua chiave.
//   Un url che non è né di Meta né di 360dialog si rifiuta. La chiave di 360dialog va SOLO a 360dialog.
// Il token di Meta va SOLO a Meta (graph.facebook.com e gli indirizzi dei file di Meta, *.fbsbx.com / *.whatsapp.net).
// Sempre: nessun reindirizzamento, tempo massimo, dimensione massima, impronta del contenuto controllata.
import { createHash } from "node:crypto";
import type { RisolviNome } from "../calendario.js";
import { BASE_META, controllaFornitoreInRete, invioPronto } from "./collegamento.js";
import { intestazioniInvio } from "./invio.js";
import { leggiCorpo, leggiTesto } from "./corpo.js";
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
  // Solo lettere, cifre, «_», «-» e punti singoli: niente «/», niente «..», almeno una lettera o cifra.
  if (!/^[A-Za-z0-9_.\-]{1,100}$/.test(idMedia) || idMedia.includes("..") || !/[A-Za-z0-9]/.test(idMedia)) throw new ErroreWhatsapp("Id dell'allegato non valido.");
  const f = o.fetchFn ?? fetch;
  const max = Math.min(o.maxByte ?? MAX_BYTE_MEDIA, MAX_BYTE_MEDIA);
  const base = c.provider === "360dialog" ? await controllaFornitoreInRete(c.baseUrl, o.risolvi) : `${BASE_META}/${encodeURIComponent(c.versione)}`;
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
  try { info = JSON.parse(await leggiTesto(r1, 64 * 1024)); } catch { /* sotto */ }
  if (typeof info.url !== "string") throw new ErroreWhatsapp("Risposta di WhatsApp non leggibile.", 502);
  if (Number(info.file_size) > max) throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413);
  let u: URL;
  try { u = new URL(info.url); } catch { throw new ErroreWhatsapp("Indirizzo dell'allegato non valido.", 502); }
  if (u.protocol !== "https:" || u.username || u.password) throw new ErroreWhatsapp("Indirizzo dell'allegato non ammesso.", 502);
  let finale: string;
  if (c.provider === "360dialog") {
    // 360dialog fa da tramite: stesso percorso del file, ma sul suo indirizzo (la chiave va solo lì).
    // Ammessi solo url di Meta (si cambia il nome del server) o già di 360dialog; nient'altro.
    const suo = new URL(base);
    if (u.hostname.toLowerCase() !== suo.hostname && !hostMediaAmmesso(u.hostname)) {
      throw new ErroreWhatsapp("Indirizzo dell'allegato fuori da Meta e da 360dialog: non lo scarico.", 502);
    }
    finale = `${suo.origin}${u.pathname}${u.search}`;
  } else {
    if (!hostMediaAmmesso(u.hostname)) throw new ErroreWhatsapp("Indirizzo dell'allegato fuori da Meta: non lo scarico.", 502);
    finale = u.href;
  }
  const r2 = await chiedi(finale, "*/*");
  if (!r2.ok) throw new ErroreWhatsapp(`WhatsApp non ha dato il file (${r2.status}): forse sono passati più di 5 minuti.`, 502);
  if (Number(r2.headers.get("content-length") || 0) > max) throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413);
  // Si legge a pezzi e ci si ferma appena si supera il limite (anche se il server non dice la dimensione).
  let letto;
  try { letto = await leggiCorpo(r2, max); } catch { throw new ErroreWhatsapp("WhatsApp non risponde: allegato non scaricato.", 502); }
  if (letto.troppo) throw new ErroreWhatsapp("Allegato troppo grande: non lo scarico.", 413);
  const dati = letto.dati;
  const sha256 = createHash("sha256").update(dati).digest("hex");
  const atteso = typeof info.sha256 === "string" ? info.sha256.trim() : "";
  if (atteso && atteso.toLowerCase() !== sha256 && atteso !== createHash("sha256").update(dati).digest("base64")) {
    dati.fill(0);
    throw new ErroreWhatsapp("L'allegato scaricato non corrisponde a quello di WhatsApp: scartato.", 502);
  }
  const mime = String(info.mime_type ?? r2.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100);
  return { dati, mime, sha256, dimensione: dati.length };
}
