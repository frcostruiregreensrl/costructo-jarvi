// Notifiche push (web-push) per il briefing del mattino, all'orario scelto (predefinito 7:00, Europe/Rome).
import webpush from "web-push";
import { z } from "zod";
import type { Db } from "./db.js";
import { registra } from "./registro.js";
import { leggiImpostazioni, leggiValore, scriviValore } from "./impostazioni.js";
import { partiLocali, dataIso } from "./tempo.js";

export const SchemaIscrizione = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith("https://"), "deve essere https"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
}).strip();
export type Iscrizione = z.infer<typeof SchemaIscrizione>;

export function salvaIscrizione(db: Db, i: Iscrizione): void {
  db.prepare("INSERT INTO iscrizioni_push (endpoint, dati, creata) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET dati = excluded.dati")
    .run(i.endpoint, JSON.stringify(i), Date.now());
}
export function togliIscrizione(db: Db, endpoint: string): void {
  db.prepare("DELETE FROM iscrizioni_push WHERE endpoint = ?").run(endpoint);
}

export type Invia = (i: Iscrizione, corpo: string) => Promise<{ statusCode: number }>;

export function creaInvio(vapid: { pubblica: string; privata: string; contatto: string }): Invia | null {
  if (!vapid.pubblica || !vapid.privata) return null;
  webpush.setVapidDetails(vapid.contatto, vapid.pubblica, vapid.privata);
  return (i, corpo) => webpush.sendNotification(i, corpo, { TTL: 3600, urgency: "normal" });
}

export async function inviaATutti(db: Db, invia: Invia, titolo: string, testo: string): Promise<number> {
  const righe = db.prepare("SELECT endpoint, dati FROM iscrizioni_push").all() as Array<{ endpoint: string; dati: string }>;
  let ok = 0;
  for (const r of righe) {
    try {
      await invia(JSON.parse(r.dati), JSON.stringify({ titolo, testo, url: "/" }));
      ok++;
    } catch (e) {
      const codice = (e as { statusCode?: number }).statusCode;
      if (codice === 404 || codice === 410) togliIscrizione(db, r.endpoint); // iscrizione scaduta
    }
  }
  registra(db, "notifica.briefing", ok ? "fatto" : "errore", "sistema", { inviate: ok, iscrizioni: righe.length });
  return ok;
}

/** Da chiamare ogni minuto: se è l'ora del briefing e oggi non è ancora partito, lo manda. */
export async function controllaOraBriefing(db: Db, fuso: string, prepara: () => Promise<string>, invia: Invia | null, ora = Date.now()): Promise<boolean> {
  const imp = leggiImpostazioni(db);
  if (!imp.briefingPush || !invia) return false;
  const p = partiLocali(ora, fuso);
  const [h, m] = imp.orarioBriefing.split(":").map(Number);
  const adesso = p.ora * 60 + p.minuto, previsto = h * 60 + m;
  if (adesso < previsto || adesso >= previsto + 120) return false; // finestra di 2 ore: niente briefing alle 15 se il server era spento
  const oggi = dataIso(ora, fuso);
  if (leggiValore<string>(db, "ultimoBriefingPush") === oggi) return false;
  scriviValore(db, "ultimoBriefingPush", oggi);
  await inviaATutti(db, invia, "Buongiorno da Jarvis", await prepara());
  return true;
}
