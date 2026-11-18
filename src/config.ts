// Configurazione letta dalle variabili d'ambiente. Nessuna chiave è scritta nel codice.
import { resolve } from "node:path";

export interface Config {
  porta: number;
  host: string;
  cartellaDati: string;
  fileDb: string;
  /** Indirizzo pubblico dell'app (es. https://jarvis.esempio.it): serve per il controllo Origin. */
  origineAmmessa: string[];
  /** true in produzione: cookie "secure" obbligatorio. */
  produzione: boolean;
  /** JARVIS_PROXY=1: il server sta dietro UN proxy (Railway) e ne legge l'IP vero del visitatore. */
  fidatiProxy: boolean;
  /** Chiave (32 byte, base64 o hex) per cifrare i segreti salvati nel database. */
  chiaveCifratura: string;
  fusoOrario: string;
  modelloPredefinito: string;
  modelloApprofondito: string;
  anthropicApiKey: string;
  costructoUrl: string;
  costructoToken: string;
  vapidPubblica: string;
  vapidPrivata: string;
  vapidContatto: string;
  /** JARVIS_CODICE_PRIMO_ACCESSO: codice monouso per creare l'utente dal browser quando il database è vuoto (es. su Railway). */
  codicePrimoAccesso: string;
}

export function leggiConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cartellaDati = resolve(env.JARVIS_DATI || "data");
  const produzione = env.NODE_ENV === "production";
  const porta = Number(env.PORT) || 4180;
  return {
    porta,
    host: env.JARVIS_HOST || (produzione ? "0.0.0.0" : "127.0.0.1"),
    cartellaDati,
    fileDb: env.JARVIS_DB || resolve(cartellaDati, "jarvis.db"),
    origineAmmessa: (env.JARVIS_ORIGINE || `http://localhost:${porta},http://127.0.0.1:${porta}`)
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
    produzione,
    fidatiProxy: env.JARVIS_PROXY === "1",
    chiaveCifratura: env.JARVIS_CHIAVE_CIFRATURA || "",
    fusoOrario: env.JARVIS_FUSO || "Europe/Rome",
    modelloPredefinito: env.JARVIS_MODELLO || "claude-haiku-5-5",
    modelloApprofondito: env.JARVIS_MODELLO_APPROFONDITO || "claude-sonnet-5-5",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    costructoUrl: (env.COSTRUCTO_URL || "").replace(/\/$/, ""),
    costructoToken: env.COSTRUCTO_TOKEN || "",
    vapidPubblica: env.VAPID_PUBLIC_KEY || "",
    vapidPrivata: env.VAPID_PRIVATE_KEY || "",
    vapidContatto: env.VAPID_CONTATTO || "mailto:assistenza@example.invalid",
    codicePrimoAccesso: env.JARVIS_CODICE_PRIMO_ACCESSO || "",
  };
}
