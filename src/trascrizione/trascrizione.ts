// Trascrizione dei vocali (funzione 1). SPENTA di serie («nessuno»): un vocale resta «vocale ricevuto, trascrizione spenta».
// Fornitori previsti (NON collegati: si accendono da Impostazioni, con la chiave di Luigi, dopo la sua decisione):
//  - google: Speech-to-Text v1 REST, POST https://speech.googleapis.com/v1/speech:recognize (chiave nell'intestazione X-Goog-Api-Key);
//            la richiesta sincrona accetta al massimo circa 1 minuto di audio;
//  - openai: POST https://api.openai.com/v1/audio/transcriptions (multipart, modello gpt-4o-mini-transcribe), al massimo 25 MB.
// Le chiavi stanno nel segreto cifrato «trascrizione» e non tornano mai al browser (solo «impostata sì/no»).
// L'audio non si salva mai: si trascrive dalla memoria e il buffer si azzera subito dopo. Resta solo il testo (30 giorni).
// Il costo si stima prima (dalla dimensione del file) e si conta nella spesa del mese, sotto lo stesso tetto.
import { z } from "zod";
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import { leggiSegreto, salvaSegreto } from "../impostazioni.js";
import { meseDi } from "../consumi.js";

export type Fornitore = "nessuno" | "google" | "openai";

/** Listino (dollari al minuto) letto il 18/11/2026 dalla documentazione pubblica dei fornitori: da ricontrollare prima di accendere. */
export const LISTINO_TRASCRIZIONE: Record<Exclude<Fornitore, "nessuno">, { alMinuto: number; nota: string }> = {
  google: { alMinuto: 0.024, nota: "Speech-to-Text v1, modello standard, arrotondato ai 15 secondi" },
  openai: { alMinuto: 0.003, nota: "gpt-4o-mini-transcribe" },
};
export const INDIRIZZI = {
  google: "https://speech.googleapis.com/v1/speech:recognize",
  openai: "https://api.openai.com/v1/audio/transcriptions",
} as const;
export const MODELLO_OPENAI = "gpt-4o-mini-transcribe";
/** Limiti: Google sincrono circa 1 minuto (si sta larghi: 10 MB), OpenAI 25 MB. */
export const MAX_BYTE: Record<Exclude<Fornitore, "nessuno">, number> = { google: 10 * 1024 * 1024, openai: 25 * 1024 * 1024 };
export const SPENTA = "Vocale ricevuto, trascrizione spenta.";

export interface EsitoTrascrizione { testo: string; secondi: number }
export interface Trascrittore { fornitore: Exclude<Fornitore, "nessuno">; trascrivi(audio: Buffer, mime: string): Promise<EsitoTrascrizione> }

export class ErroreTrascrizione extends Error {}

/** Secondi stimati di un vocale di WhatsApp (Opus a circa 16 kbit/s ≈ 2 KB al secondo): stima prudente per eccesso. */
export const secondiStimati = (byte: number) => Math.max(1, Math.ceil(byte / 1500));
export const costoTrascrizione = (f: Exclude<Fornitore, "nessuno">, secondi: number) =>
  (f === "google" ? Math.ceil(secondi / 15) * 15 : secondi) / 60 * LISTINO_TRASCRIZIONE[f].alMinuto;

const SchemaChiavi = z.object({ google: z.string().max(400).optional(), openai: z.string().max(400).optional() });
export type Chiavi = z.infer<typeof SchemaChiavi>;

export function leggiChiavi(db: Db, c: Cifratore): Chiavi {
  const g = leggiSegreto(db, c, "trascrizione");
  if (!g) return {};
  try { const v = SchemaChiavi.safeParse(JSON.parse(g)); return v.success ? v.data : {}; } catch { return {}; }
}
/** Salva una chiave (vuota = toglierla). Mai restituita. */
export function salvaChiave(db: Db, c: Cifratore, fornitore: Exclude<Fornitore, "nessuno">, chiave: string): void {
  const t = chiave.trim();
  if (t && !/^[A-Za-z0-9_\-.]{16,400}$/.test(t)) throw new ErroreTrascrizione("La chiave ha un formato non valido.");
  const k = { ...leggiChiavi(db, c), [fornitore]: t || undefined };
  salvaSegreto(db, c, "trascrizione", k.google || k.openai ? JSON.stringify(k) : "");
}

async function chiama(f: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let r: Response;
  try { r = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(60_000) }); } catch { throw new ErroreTrascrizione("Il servizio di trascrizione non risponde."); }
  const grezzo = (await r.text().catch(() => "")).slice(0, 256 * 1024);
  if (r.status === 401 || r.status === 403) throw new ErroreTrascrizione("Il servizio di trascrizione non accetta la chiave.");
  if (r.status === 429) throw new ErroreTrascrizione("Troppe trascrizioni in poco tempo: riprovo più tardi.");
  if (!r.ok) throw new ErroreTrascrizione(`Il servizio di trascrizione ha risposto con un errore (${r.status}).`);
  try { return JSON.parse(grezzo) as Record<string, unknown>; } catch { throw new ErroreTrascrizione("Risposta della trascrizione non leggibile."); }
}

/** Google Speech-to-Text v1 (riconoscimento sincrono, italiano, punteggiatura automatica). */
export function trascrittoreGoogle(chiave: string, fetchFn: typeof fetch = fetch): Trascrittore {
  return {
    fornitore: "google",
    async trascrivi(audio, mime) {
      if (audio.length > MAX_BYTE.google) throw new ErroreTrascrizione("Vocale troppo lungo per la trascrizione di Google.");
      const encoding = /ogg|opus/.test(mime) ? "OGG_OPUS" : /amr/.test(mime) ? "AMR" : /mpeg|mp3/.test(mime) ? "MP3" : "ENCODING_UNSPECIFIED";
      const j = await chiama(fetchFn, INDIRIZZI.google, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": chiave },
        body: JSON.stringify({ config: { encoding, ...(encoding === "OGG_OPUS" ? { sampleRateHertz: 16000 } : {}), languageCode: "it-IT", enableAutomaticPunctuation: true }, audio: { content: audio.toString("base64") } }),
      });
      const risultati = Array.isArray(j.results) ? j.results as Array<{ alternatives?: Array<{ transcript?: unknown }> }> : [];
      const testo = risultati.map((x) => String(x.alternatives?.[0]?.transcript ?? "")).join(" ").replace(/\s+/g, " ").trim();
      const fatturati = /^(\d+(?:\.\d+)?)s$/.exec(String(j.totalBilledTime ?? ""));
      return { testo, secondi: fatturati ? Number(fatturati[1]) : secondiStimati(audio.length) };
    },
  };
}

/** OpenAI Audio Transcriptions (multipart, italiano). */
export function trascrittoreOpenai(chiave: string, fetchFn: typeof fetch = fetch): Trascrittore {
  return {
    fornitore: "openai",
    async trascrivi(audio, mime) {
      if (audio.length > MAX_BYTE.openai) throw new ErroreTrascrizione("Vocale troppo grande per la trascrizione.");
      const modulo = new FormData();
      modulo.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/ogg" }), /mpeg|mp3/.test(mime) ? "vocale.mp3" : /mp4|m4a|aac/.test(mime) ? "vocale.m4a" : "vocale.ogg");
      modulo.append("model", MODELLO_OPENAI);
      modulo.append("language", "it");
      modulo.append("response_format", "json");
      const j = await chiama(fetchFn, INDIRIZZI.openai, { method: "POST", headers: { Authorization: `Bearer ${chiave}` }, body: modulo });
      return { testo: String(j.text ?? "").replace(/\s+/g, " ").trim(), secondi: secondiStimati(audio.length) };
    },
  };
}

/** Il trascrittore scelto da Luigi, oppure null (spento o chiave mancante). */
export function trascrittoreScelto(fornitore: Fornitore, chiavi: Chiavi, fetchFn?: typeof fetch): Trascrittore | null {
  if (fornitore === "google" && chiavi.google) return trascrittoreGoogle(chiavi.google, fetchFn);
  if (fornitore === "openai" && chiavi.openai) return trascrittoreOpenai(chiavi.openai, fetchFn);
  return null;
}

/** La trascrizione conta nella spesa del mese (stessa tabella dei consumi dell'AI, stesso tetto). */
export function registraCostoTrascrizione(db: Db, f: Exclude<Fornitore, "nessuno">, secondi: number, fuso: string, ora = Date.now()): number {
  const costo = costoTrascrizione(f, secondi);
  db.prepare(`INSERT INTO consumi (quando, mese, modello, token_ingresso, token_uscita, costo_usd) VALUES (?,?,?,0,0,?)`).run(ora, meseDi(ora, fuso), `trascrizione-${f}`, costo);
  return costo;
}

/** Minuti e spesa delle trascrizioni nel mese (per Impostazioni). */
export function spesaTrascrizioniMese(db: Db, fuso: string, ora = Date.now()): { richieste: number; spesaUsd: number } {
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(costo_usd), 0) s FROM consumi WHERE mese = ? AND modello LIKE 'trascrizione-%'").get(meseDi(ora, fuso)) as { n: number; s: number };
  return { richieste: r.n, spesaUsd: r.s };
}
