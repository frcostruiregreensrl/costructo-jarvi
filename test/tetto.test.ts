import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente, leggiEventi, testoDetto } from "./aiuto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { registraConsumo, riepilogoMese, costoUsd } from "../src/consumi.js";
import { salvaImpostazioni } from "../src/impostazioni.js";
import { PassoInterrotto, type RichiestaPasso } from "../src/cervello/tipi.js";

test("costi: listino Haiku e Sonnet 5.5", () => {
  assert.ok(Math.abs(costoUsd("claude-haiku-5-5", { ingresso: 100_000, uscita: 1_000_000, cacheLettura: 0, cacheScrittura: 0 }) - 0.51) < 1e-12);
  // oltre 100.000 token in ingresso nella stessa richiesta Haiku costa $0,50 / $2,50 per milione
  assert.ok(Math.abs(costoUsd("claude-haiku-5-5", { ingresso: 200_000, uscita: 1_000_000, cacheLettura: 0, cacheScrittura: 0 }) - 2.6) < 1e-12);
  assert.ok(Math.abs(costoUsd("claude-haiku-5-5", { ingresso: 50_000, uscita: 0, cacheLettura: 60_000, cacheScrittura: 0 }) - (50_000 * 0.5 + 60_000 * 0.05) / 1e6) < 1e-12, "la cache conta per la soglia");
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

const lento = (ms: number, uso: { ingresso: number; uscita: number; cacheLettura: number; cacheScrittura: number }) => {
  let chiamate = 0;
  return {
    get chiamate() { return chiamate; },
    nome: "lento",
    async passo() { chiamate++; await new Promise((r) => setTimeout(r, ms)); return { testo: "ok", chiamate: [], fine: "fine" as const, uso }; },
  };
};

test("tetto di spesa: 10 richieste in parallelo con tetto basso non lo superano", async () => {
  // consumo realistico (entro i token massimi): 1000 in ingresso, 4000 in uscita = 0,0021 $ con Haiku
  const cervello = lento(50, { ingresso: 1000, uscita: 4000, cacheLettura: 0, cacheScrittura: 0 });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    salvaImpostazioni(a.db, { tettoMensileUsd: 0.01 });
    const tutte = await Promise.all(Array.from({ length: 10 }, () => a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "ciao", vista: "privato" } }).then(leggiEventi)));
    const r = riepilogoMese(a.db, 0.01, "Europe/Rome");
    assert.ok(r.spesaUsd <= 0.01, `spesa ${r.spesaUsd} oltre il tetto`);
    assert.equal(cervello.chiamate, 4, "dopo 4 chiamate la successiva potrebbe superare il tetto: non parte");
    assert.equal(tutte.filter((ev) => /tetto di spesa/.test(testoDetto(ev))).length, 6);
  } finally { await a.chiudi(); }
});

test("tetto di spesa: un cervello che consuma molto più del previsto supera il tetto al massimo di una chiamata (prova della revisione)", async () => {
  const cervello = lento(100, { ingresso: 0, uscita: 1_000_000, cacheLettura: 0, cacheScrittura: 0 }); // 0,50 $
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    salvaImpostazioni(a.db, { tettoMensileUsd: 1 });
    await Promise.all(Array.from({ length: 10 }, () => a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "ciao", vista: "privato" } }).then(leggiEventi)));
    assert.ok(riepilogoMese(a.db, 1, "Europe/Rome").spesaUsd <= 1);
    assert.equal(cervello.chiamate, 2);
  } finally { await a.chiudi(); }
});

test("consumo: una risposta interrotta con stop viene registrata lo stesso (stima prudente)", async () => {
  const cervello = {
    nome: "interrompibile",
    async passo(r: RichiestaPasso, suTesto: (p: string) => void) {
      suTesto("Sto pensando a ");
      await new Promise((ok, ko) => { const t = setTimeout(ok, 2000); r.segnale?.addEventListener("abort", () => { clearTimeout(t); ko(new Error("abort")); }); });
      return { testo: "ok", chiamate: [], fine: "fine" as const, uso: { ingresso: 1, uscita: 1, cacheLettura: 0, cacheScrittura: 0 } };
    },
  };
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ctrl = new AbortController();
    const p = a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "ciao", vista: "privato" }, signal: ctrl.signal }).then((r) => r.text()).catch(() => {});
    setTimeout(() => ctrl.abort(), 150);
    await p;
    await new Promise((r) => setTimeout(r, 200));
    const r = riepilogoMese(a.db, 10, "Europe/Rome");
    assert.equal(r.richieste, 1);
    assert.ok(r.tokenIngresso > 500, "ingresso stimato dal testo della richiesta");
    const reg = a.db.prepare("SELECT dettagli FROM registro WHERE azione = 'ai.chiamata'").get() as { dettagli: string };
    assert.match(reg.dettagli, /interrotta da Luigi/);
  } finally { await a.chiudi(); }
});

test("consumo: con il consumo comunicato dal fornitore si usa quello; rete e problemi imprevisti hanno messaggi diversi", async () => {
  let modo = "rete";
  const cervello = {
    nome: "fragile",
    async passo(_r: RichiestaPasso, suTesto: (p: string) => void): Promise<never> {
      suTesto("Allora");
      if (modo === "rete") throw new PassoInterrotto("rete", { ingresso: 5000, uscita: 20, cacheLettura: 0, cacheScrittura: 0 });
      throw new Error("guasto strano");
    },
  };
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ev1 = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "ciao", vista: "privato" } }));
    assert.match(testoDetto(ev1), /connessione con Claude si è interrotta/);
    let r = riepilogoMese(a.db, 10, "Europe/Rome");
    assert.equal(r.richieste, 1);
    assert.equal(r.tokenIngresso, 5000);
    modo = "altro";
    const ev2 = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "ciao", vista: "privato" } }));
    assert.match(testoDetto(ev2), /problema tecnico imprevisto/);
    r = riepilogoMese(a.db, 10, "Europe/Rome");
    assert.equal(r.richieste, 2, "anche qui il consumo stimato è registrato");
  } finally { await a.chiudi(); }
});

test("rifiuto a metà risposta: il testo parziale non si salva come risposta e viene segnalato", async () => {
  const cervello = creaCervelloFinto(() => ({ testo: "Ecco come si fa: prima", fine: "rifiuto" }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "spiegami una cosa", vista: "privato" } }));
    assert.ok(ev.some((e) => e.tipo === "scarta" && e.testo === ""));
    assert.ok(ev.some((e) => e.tipo === "avviso"));
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    const salvato = a.db.prepare("SELECT testo FROM messaggi WHERE conversazione_id = ? AND ruolo = 'jarvis'").get(conv) as { testo: string };
    assert.equal(salvato.testo, "Su questo non posso aiutarti, signore.");
    assert.equal(riepilogoMese(a.db, 10, "Europe/Rome").richieste, 1, "il passo rifiutato costa e si registra");
  } finally { await a.chiudi(); }
});

test("consumo: se nello stesso passo lavorano due modelli (ripiego), ognuno si conta al suo prezzo", async () => {
  const cervello = creaCervelloFinto(() => ({
    testo: "ok",
    consumi: [
      { modello: "claude-sonnet-5-5", uso: { ingresso: 1000, uscita: 10, cacheLettura: 0, cacheScrittura: 0 } },
      { modello: "claude-sonnet-5", uso: { ingresso: 1000, uscita: 200, cacheLettura: 0, cacheScrittura: 0 } },
    ],
  }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "pensaci bene: ciao", vista: "privato" } }));
    const r = riepilogoMese(a.db, 10, "Europe/Rome");
    assert.deepEqual(r.perModello.map((m) => m.modello).sort(), ["claude-sonnet-5", "claude-sonnet-5-5"]);
  } finally { await a.chiudi(); }
});
