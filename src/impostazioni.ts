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

// ---------------------------------------------------------------- segreti cifrati (token Costructo, elenco delle aziende con i loro token, link iCal…)
export type NomeSegreto = "costructo_url" | "costructo_token" | "costructo_aziende" | "calendario_ical" | "elevenlabs_chiave";

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
