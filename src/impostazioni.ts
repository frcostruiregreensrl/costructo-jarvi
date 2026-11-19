// Impostazioni di Jarvis, salvate nel database e sempre validate.
import { z } from "zod";
import type { Db } from "./db.js";
import type { Cifratore } from "./sicurezza/cifra.js";

export const SchemaImpostazioni = z.object({
  comeChiamarmi: z.string().trim().min(1).max(40).default("signore"),
  tettoMensileUsd: z.number().min(0).max(1000).default(10),
  vocePreferita: z.string().max(120).default(""),
  velocitaVoce: z.number().min(0.6).max(1.6).default(1.02),
  leggiRisposteAVoce: z.boolean().default(true),
  paroleRisveglio: z.array(z.string().trim().toLowerCase().min(2).max(30)).min(1).max(5).default(["jarvis", "costructo"]),
  orarioBriefing: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("07:00"),
  briefingPush: z.boolean().default(true),
  meteoCantieri: z.boolean().default(false),
  /** In Fase 1 ElevenLabs resta spento: il campo esiste solo per mostrarlo nelle impostazioni. */
  elevenLabsAttivo: z.literal(false).default(false),
  tema: z.enum(["automatico", "chiaro", "scuro"]).default("automatico"),
  /**
   * Interruttore generale delle conferme di ricezione automatiche (Fase 2). Spento di serie:
   * anche con una casella che le permette, finché questo è spento Jarvis non manda niente.
   */
  confermeAutomaticheAttive: z.boolean().default(false),
  /**
   * Fase 3: conferme di ricezione automatiche su WhatsApp. Spente di serie; anche accese partono solo
   * se tutte le regole lo permettono (mai soldi o impegni, mai gruppi, mai se Luigi ha già risposto…).
   */
  whatsappConfermeAutomatiche: z.boolean().default(false),
  /** Fase 3: nelle notifiche di WhatsApp non mostrare nemmeno il nome del contatto (solo azienda e «messaggio urgente»). */
  whatsappNascondiContenuto: z.boolean().default(false),
  // ---- Fase 3b: le 20 funzioni WhatsApp (tutto spento di serie)
  /** Scaricare foto e PDF (e i vocali da trascrivere) da WhatsApp. Spento di serie: senza, Jarvis vede solo nome e tipo. */
  whatsappScaricaAllegati: z.boolean().default(false),
  /** Trascrizione dei vocali: «nessuno» = spenta (di serie). Le chiavi stanno nel segreto cifrato «trascrizione». */
  trascrizioneFornitore: z.enum(["nessuno", "google", "openai"]).default("nessuno"),
  /** Tipi di proposta che Jarvis manda a Costructo senza chiedere (restano bozze in Costructo). Vuoto di serie. */
  proposteAutomatiche: z.array(z.enum(["ore", "foto", "rinnovo_documento", "carico_magazzino", "richiesta_lavoro", "agenda", "contatto", "documento_fornitore", "diario", "invio_documenti"])).max(10).default([]),
  /** Chat private escluse dalle funzioni (promemoria, compleanni, vocali): id dei contatti WhatsApp. */
  chatPrivateEscluse: z.array(z.string().min(1).max(40)).max(300).default([]),
  /** Preventivi inviati da più di N giorni senza risposta: promemoria nel briefing. */
  giorniPreventiviInAttesa: z.number().int().min(1).max(90).default(7),
  /** Modelli approvati da Meta per i promemoria ai clienti (parte 2). Spento: si usano solo i link wa.me. */
  whatsappModelliAttivi: z.boolean().default(false),
  // ---- Fase 3, parte 2 (360dialog e costi)
  /**
   * Tetto dei messaggi che JARVIS manda con la API in un mese (risposte confermate, conferme automatiche, modelli).
   * Al tetto Jarvis non manda più niente; il telefono di Luigi non è toccato. Di serie 900: resta sotto i 1.000 gratuiti.
   */
  whatsappTettoMessaggiMese: z.number().int().min(0).max(100_000).default(900),
  /** Prezzo stimato di un messaggio oltre i 1.000 gratuiti del mese (euro). È una stima: il conto vero lo fa Meta. */
  whatsappPrezzoMessaggioEur: z.number().min(0).max(1).default(0.0248),
});
export type Impostazioni = z.infer<typeof SchemaImpostazioni>;

export function leggiImpostazioni(db: Db): Impostazioni {
  const righe = db.prepare("SELECT chiave, valore FROM impostazioni").all() as Array<{ chiave: string; valore: string }>;
  const grezze: Record<string, unknown> = {};
  for (const r of righe) { try { grezze[r.chiave] = JSON.parse(r.valore); } catch { /* ignora */ } }
  const ok = SchemaImpostazioni.safeParse(grezze);
  return ok.success ? ok.data : SchemaImpostazioni.parse({});
}

export function salvaImpostazioni(db: Db, modifiche: unknown): Impostazioni {
  const nuove = SchemaImpostazioni.parse({ ...leggiImpostazioni(db), ...(SchemaImpostazioni.partial().parse(modifiche)) });
  const scrivi = db.prepare("INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore");
  db.transaction(() => { for (const [k, v] of Object.entries(nuove)) scrivi.run(k, JSON.stringify(v)); })();
  return nuove;
}

export function leggiValore<T>(db: Db, chiave: string): T | undefined {
  const r = db.prepare("SELECT valore FROM impostazioni WHERE chiave = ?").get(`_${chiave}`) as { valore: string } | undefined;
  return r ? (JSON.parse(r.valore) as T) : undefined;
}
export function scriviValore(db: Db, chiave: string, valore: unknown): void {
  db.prepare("INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore")
    .run(`_${chiave}`, JSON.stringify(valore));
}

// ---------------------------------------------------------------- segreti cifrati (token Costructo, elenco delle aziende con i loro token, link iCal,
// caselle email con le password, Apple ID con la password specifica per le app, collegamento WhatsApp…)
export type NomeSegreto = "costructo_url" | "costructo_token" | "costructo_aziende" | "calendario_ical" | "elevenlabs_chiave" | "posta_caselle" | "calendario_apple" | "whatsapp" | "trascrizione";

export function salvaSegreto(db: Db, c: Cifratore, nome: NomeSegreto, valore: string): void {
  if (!valore) { db.prepare("DELETE FROM segreti WHERE nome = ?").run(nome); return; }
  db.prepare("INSERT INTO segreti (nome, valore) VALUES (?, ?) ON CONFLICT(nome) DO UPDATE SET valore = excluded.valore").run(nome, c.cifra(valore));
}
export function leggiSegreto(db: Db, c: Cifratore, nome: NomeSegreto): string {
  const r = db.prepare("SELECT valore FROM segreti WHERE nome = ?").get(nome) as { valore: string } | undefined;
  if (!r) return "";
  try { return c.decifra(r.valore); } catch { return ""; }
}
/** Per l'interfaccia: mai il segreto, solo se c'è e le ultime 4 cifre. */
export function maschera(valore: string): string {
  if (!valore) return "";
  return valore.length <= 8 ? "••••" : `••••${valore.slice(-4)}`;
}
