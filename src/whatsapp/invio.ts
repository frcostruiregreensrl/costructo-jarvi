// Invio di un messaggio di testo con la WhatsApp Business Platform (Cloud API), direttamente con Meta
// oppure tramite un fornitore (BSP, per esempio 360dialog) che usa lo stesso formato dei messaggi.
//   meta: POST https://graph.facebook.com/{versione}/{phone_number_id}/messages, Authorization: Bearer {token}
//   bsp:  POST {indirizzo}/messages (oppure {indirizzo}/{phone_number_id}/messages se l'id c'è),
//         con l'intestazione scelta (per 360dialog «D360-API-KEY: {chiave}»)
// Corpo: {"messaging_product":"whatsapp","recipient_type":"individual","to":…,"type":"text","text":{…}}.
// Jarvis NON segna mai i messaggi come letti (niente «spunte blu»): Luigi li legge sul telefono.
// Qui non c'è nessuna funzione per farlo, e nessun altro tipo di richiesta verso Meta.
import type { RisolviNome } from "../calendario.js";
import { BASE_META, controllaFornitoreInRete } from "./collegamento.js";
import { spiegaErroreMeta } from "./elabora.js";
import { ErroreWhatsapp, InvioIncerto, MAX_TESTO_RISPOSTA, type CollegamentoWa } from "./tipi.js";

export interface Destinatario { waId: string; userId: string }
export interface OpzioniInvio { fetchFn?: typeof fetch; attesa?: (ms: number) => Promise<void>; timeoutMs?: number; risolvi?: RisolviNome }

const MAX_RISPOSTA_BYTE = 64 * 1024;
/**
 * Tentativi in tutto (1 + 2 ripetizioni). Si ripete SOLO quando si è sicuri che il messaggio non è partito:
 * risposta 429 (WhatsApp non l'ha accettato) o collegamento mai aperto (indirizzo che non risponde o nome non trovato).
 * Tempo scaduto, connessione caduta a metà o errore 5xx: esito INCERTO, nessuna ripetizione (niente doppioni).
 */
export const TENTATIVI = 3;
const PRIMA_DI_PARTIRE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/;

/** Codice dell'errore di rete (fetch di Node lo mette in «cause»). */
function codiceRete(e: unknown): string {
  const x = e as { code?: string; cause?: { code?: string; cause?: { code?: string } } };
  return String(x?.cause?.code ?? x?.cause?.cause?.code ?? x?.code ?? "");
}

export function indirizzoInvio(c: CollegamentoWa): string {
  if (c.provider === "meta") return `${BASE_META}/${encodeURIComponent(c.versione)}/${encodeURIComponent(c.phoneNumberId)}/messages`;
  return `${c.baseUrl.replace(/\/+$/, "")}${c.phoneNumberId ? `/${encodeURIComponent(c.phoneNumberId)}` : ""}/messages`;
}

export function intestazioniInvio(c: CollegamentoWa): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (c.provider === "meta") h.Authorization = `Bearer ${c.token}`;
  else h[c.intestazione] = c.token;
  return h;
}

/** Il corpo standard di un messaggio di testo (al numero se c'è, altrimenti all'id utente di WhatsApp). */
export function corpoTesto(d: Destinatario, testo: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...(d.waId ? { to: d.waId } : { recipient: d.userId }),
    type: "text",
    text: { preview_url: false, body: testo },
  };
}

/** Manda un testo. Restituisce l'id del messaggio di WhatsApp. Gli errori sono in italiano. */
export async function mandaTesto(c: CollegamentoWa, d: Destinatario, testo: string, o: OpzioniInvio = {}): Promise<string> {
  const corpo = testo.trim();
  if (!corpo) throw new ErroreWhatsapp("Il messaggio è vuoto.");
  if (corpo.length > MAX_TESTO_RISPOSTA) throw new ErroreWhatsapp("Il messaggio è troppo lungo (al massimo 4000 caratteri).");
  if (!d.waId && !d.userId) throw new ErroreWhatsapp("Non so a chi mandarlo: manca il numero del contatto.");
  // Il token va SOLO all'indirizzo configurato: per un fornitore si ricontrolla ogni volta che il nome non porti alla rete interna.
  if (c.provider === "bsp") await controllaFornitoreInRete(c.baseUrl, o.risolvi);
  const f = o.fetchFn ?? fetch;
  const attesa = o.attesa ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let ultimo = "WhatsApp non risponde in questo momento.";
  for (let i = 0; i < TENTATIVI; i++) {
    if (i) await attesa(i === 1 ? 1000 : 4000);
    let r: Response;
    try {
      r = await f(indirizzoInvio(c), {
        method: "POST", headers: intestazioniInvio(c), body: JSON.stringify(corpoTesto(d, corpo)),
        redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      if (PRIMA_DI_PARTIRE.test(codiceRete(e))) { ultimo = "WhatsApp non risponde in questo momento (rete)."; continue; }
      throw new InvioIncerto();
    }
    const grezzo = (await r.text().catch(() => "")).slice(0, MAX_RISPOSTA_BYTE);
    let dati: { messages?: Array<{ id?: unknown }>; error?: { code?: number; message?: string; error_data?: { details?: string } } } = {};
    try { dati = JSON.parse(grezzo); } catch { /* risposta non JSON */ }
    if (r.ok) {
      const id = dati.messages?.[0]?.id;
      if (typeof id === "string" && id) return id.slice(0, 300);
      throw new InvioIncerto();
    }
    if (r.status === 401 || r.status === 403) throw new ErroreWhatsapp(spiegaErroreMeta(dati.error?.code ?? 190));
    ultimo = dati.error ? spiegaErroreMeta(dati.error.code, dati.error.message) : `WhatsApp ha risposto con un errore (${r.status}).`;
    if (r.status >= 500) throw new InvioIncerto();
    if (r.status !== 429) throw new ErroreWhatsapp(ultimo);
  }
  throw new ErroreWhatsapp(ultimo, 502);
}
