// Chiamate al server di Jarvis. Stessa origine: il browser manda da solo Origin e cookie.
export class NonAutenticato extends Error {}

export async function api(percorso, { metodo = "GET", corpo } = {}) {
  const r = await fetch(percorso, {
    method: metodo,
    credentials: "same-origin",
    headers: corpo !== undefined ? { "Content-Type": "application/json" } : {},
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  if (r.status === 401 && percorso !== "/api/accesso") throw new NonAutenticato();
  const tipo = r.headers.get("content-type") || "";
  const dati = tipo.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((dati && dati.errore) || `Errore ${r.status}`);
  return dati;
}

/** Domanda a Jarvis: legge lo stream di eventi (delta, conferma, agenda, numero, fine…). */
export async function chiedi({ messaggio, vista, conversazione }, suEvento, segnale) {
  const r = await fetch("/api/chiedi", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaggio, vista, conversazione }),
    signal: segnale,
  });
  if (r.status === 401) throw new NonAutenticato();
  if (!r.ok || !r.body) throw new Error("Jarvis non risponde.");
  const lettore = r.body.getReader(), dec = new TextDecoder();
  let grezzo = "";
  for (;;) {
    const { value, done } = await lettore.read();
    if (done) break;
    grezzo += dec.decode(value, { stream: true });
    let i;
    while ((i = grezzo.indexOf("\n\n")) >= 0) {
      const riga = grezzo.slice(0, i).replace(/^data:\s*/, "");
      grezzo = grezzo.slice(i + 2);
      try { suEvento(JSON.parse(riga)); } catch { /* riga incompleta */ }
    }
  }
}
