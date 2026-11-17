import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente, leggiEventi, testoDetto } from "./aiuto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { registraConsumo, riepilogoMese, costoUsd } from "../src/consumi.js";
import { salvaImpostazioni } from "../src/impostazioni.js";

test("costi: listino Haiku e Sonnet 5.5", () => {
  assert.equal(costoUsd("claude-haiku-5-5", { ingresso: 1_000_000, uscita: 1_000_000, cacheLettura: 0, cacheScrittura: 0 }), 0.6);
  assert.equal(costoUsd("claude-sonnet-5-5", { ingresso: 1_000_000, uscita: 0, cacheLettura: 1_000_000, cacheScrittura: 0 }), 2.1);
  assert.ok(costoUsd("modello-sconosciuto", { ingresso: 1_000_000, uscita: 0, cacheLettura: 0, cacheScrittura: 0 }) >= 4, "prezzo prudente");
});

test("tetto di spesa: sotto il limite il cervello risponde e il consumo è registrato", async () => {
  const cervello = creaCervelloFinto(() => ({ testo: "Tutto in ordine, signore.", uso: { ingresso: 2000, uscita: 300, cacheLettura: 0, cacheScrittura: 0 } }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "come va la giornata?", vista: "privato" } }));
    assert.equal(testoDetto(ev), "Tutto in ordine, signore.");
    assert.equal(cervello.richieste.length, 1);
    assert.equal(cervello.richieste[0].modello, "claude-haiku-5-5");
    const r = riepilogoMese(a.db, 10, "Europe/Rome");
    assert.equal(r.richieste, 1);
    assert.ok(Math.abs(r.spesaUsd - (2000 * 0.1 + 300 * 0.5) / 1e6) < 1e-12);
  } finally { await a.chiudi(); }
});

test("tetto di spesa: al limite Jarvis si ferma, avvisa e il cervello NON viene chiamato", async () => {
  const cervello = creaCervelloFinto(() => ({ testo: "non dovrei parlare" }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    salvaImpostazioni(a.db, { tettoMensileUsd: 1 });
    registraConsumo(a.db, "claude-sonnet-5-5", { ingresso: 400_000, uscita: 30_000, cacheLettura: 0, cacheScrittura: 0 }, "Europe/Rome"); // 0,8 + 0,3 = 1,1 $
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "riassumimi la settimana", vista: "tutto" } }));
    assert.equal(cervello.richieste.length, 0, "nessuna chiamata all'AI");
    assert.match(testoDetto(ev), /tetto di spesa/);
    assert.ok(ev.some((e) => e.tipo === "avviso"));
    const reg = a.db.prepare("SELECT esito, dettagli FROM registro WHERE azione = 'ai.chiamata'").get() as { esito: string; dettagli: string };
    assert.equal(reg.esito, "negato");
    // la calcolatrice funziona lo stesso (nessun costo)
    const conto = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "quanto fa 7 per 8", vista: "tutto" } }));
    assert.match(testoDetto(conto), /Fa 56/);
    assert.equal(cervello.richieste.length, 0);
  } finally { await a.chiudi(); }
});

test("«pensaci bene» usa Sonnet; il tetto si ricontrolla tra un passo e l'altro", async () => {
  let passo = 0;
  const cervello = creaCervelloFinto(() => {
    passo++;
    return passo === 1
      ? { chiamate: [{ id: "t1", nome: "mostra_numero", input: { etichetta: "x", valore: 1, suffisso: "" } }], uso: { ingresso: 600_000, uscita: 0, cacheLettura: 0, cacheScrittura: 0 } }
      : { testo: "secondo passo" };
  });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    salvaImpostazioni(a.db, { tettoMensileUsd: 1 });
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "pensaci bene: conviene il ponteggio nuovo?", vista: "lavoro" } }));
    assert.equal(cervello.richieste[0].modello, "claude-sonnet-5-5");
    assert.equal(cervello.richieste.length, 1, "dopo il primo passo (1,2 $) il tetto è superato: niente secondo passo");
    assert.match(testoDetto(ev), /tetto di spesa/);
  } finally { await a.chiudi(); }
});
