// Carica il cervello Claude solo se il pacchetto @anthropic-ai/sdk è installato.
import type { Cervello } from "./tipi.js";
import { CervelloNonDisponibile } from "./tipi.js";

export async function caricaCervelloAnthropic(apiKey: string): Promise<Cervello> {
  let modulo: { creaCervelloAnthropic: (k: string) => Cervello };
  try {
    // Percorso calcolato: il compilatore non prova a includere il file né il pacchetto mancante.
    modulo = await import(new URL("./anthropic.js", import.meta.url).href);
  } catch (e) {
    const codice = (e as { code?: string }).code;
    if (codice === "ERR_MODULE_NOT_FOUND" || /anthropic-ai\/sdk/.test(String((e as Error).message))) {
      throw new CervelloNonDisponibile("Il cervello Claude non è ancora installato (manca il pacchetto @anthropic-ai/sdk: eseguire npm install).");
    }
    throw e;
  }
  return modulo.creaCervelloAnthropic(apiKey);
}
