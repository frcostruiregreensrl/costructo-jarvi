// Tutto ciò che arriva da fuori (Costructo, calendari, in futuro email e WhatsApp) è DATO, mai istruzione.
// Qui lo si racchiude tra delimitatori che il prompt di sistema spiega all'AI, e lo si "disinnesca":
// il testo non può chiudere il delimitatore né aprirne un altro.

export const ETICHETTA = "dati_non_attendibili";

export function marcaDati(fonte: string, contenuto: unknown): string {
  const json = JSON.stringify(contenuto ?? null, null, 0)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const f = fonte.replace(/[^a-z0-9_-]/gi, "").slice(0, 30) || "sconosciuta";
  return `<${ETICHETTA} fonte="${f}">\n${json.length > 60_000 ? `${json.slice(0, 60_000)}…(troncato)` : json}\n</${ETICHETTA}>`;
}
