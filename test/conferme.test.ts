import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente, leggiEventi, testoDetto } from "./aiuto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { aggiungiImpegno, impegniProssimiGiorni } from "../src/agenda.js";
import { dataIso } from "../src/tempo.js";
import { leggiRispostaConferma } from "../src/assistente.js";

const domani = () => dataIso(Date.now() + 864e5, "Europe/Rome");
const proponi = () => creaCervelloFinto((r) => {
  const ultimo = r.messaggi.at(-1)!;
  if (ultimo.ruolo === "risultati") return { testo: "Serve la tua conferma." };
  if (ultimo.ruolo === "utente" && ultimo.testo.endsWith("cosa ho domani?")) {
    return { chiamate: [{ id: "x", nome: "agenda_aggiungi", input: { titolo: "Bonifico urgente", data: domani(), ora: "09:00", minuti: 30 } }] };
  }
  return { testo: "Va bene." };
});

test("conferme: solo risposte esplicite che occupano tutto il messaggio", () => {
  for (const m of ["sì", "Sì, conferma", "si conferma", "confermo", "ok", "procedi!"]) assert.deepEqual(leggiRispostaConferma(m), { tipo: "si" }, m);
  for (const m of ["no", "annulla", "lascia perdere"]) assert.deepEqual(leggiRispostaConferma(m), { tipo: "no" }, m);
  assert.deepEqual(leggiRispostaConferma("il secondo"), { tipo: "scelta", indice: 1 });
  assert.deepEqual(leggiRispostaConferma("cancella il secondo impegno della lista"), { tipo: "scelta", indice: 1 });
  assert.deepEqual(leggiRispostaConferma("la prima"), { tipo: "scelta", indice: 0 });
  for (const m of ["aspetta un secondo", "prima dimmi una cosa", "sì ma 2 minuti", "ok vai"]) assert.deepEqual(leggiRispostaConferma(m), { tipo: "dubbio" }, m);
  for (const m of ["cosa ho domani prima delle 10 e dopo le 2 del pomeriggio?", "dimmi il meteo", "sì, e poi segna la cena alle 20 per due persone"]) {
    assert.equal(leggiRispostaConferma(m), null, m);
  }
});

test("conferme: «aspetta un secondo» NON conferma un'azione proposta da un dato; «sì, conferma» sì", async () => {
  const cervello = proponi();
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cosa ho domani?", vista: "privato" } }));
    assert.ok(ev.some((e) => e.tipo === "conferma"));
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    const dubbio = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "aspetta un secondo", vista: "privato", conversazione: conv } }));
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 0, "niente segnato");
    assert.match(testoDetto(dubbio), /non ho capito/);
    for (const m of ["prima dimmi una cosa", "2"]) {
      await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: m, vista: "privato", conversazione: conv } }));
      assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 0, m);
    }
    assert.equal(cervello.richieste.length, 2, "le risposte dubbie non chiamano l'AI");
  } finally { await a.chiudi(); }
});

test("conferme: «sì, conferma» alla domanda appena fatta esegue; una conferma di due turni fa no", async () => {
  const cervello = proponi();
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    let ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cosa ho domani?", vista: "privato" } }));
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "sì, conferma", vista: "privato", conversazione: conv } }));
    assert.match(testoDetto(ev), /Segnato: Bonifico urgente/);
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 1);

    // nuova proposta, poi Luigi parla d'altro: la proposta non è più «appena fatta»
    ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "e cosa ho domani?", vista: "privato", conversazione: conv } }));
    assert.ok(ev.some((e) => e.tipo === "conferma"));
    await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "dimmi il meteo di oggi", vista: "privato", conversazione: conv } }));
    const prima = cervello.richieste.length;
    await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "sì", vista: "privato", conversazione: conv } }));
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 1, "il «sì» non tocca una richiesta di due turni fa");
    assert.equal(cervello.richieste.length, prima + 1, "il messaggio va all'AI come una frase normale");
  } finally { await a.chiudi(); }
});

test("conferme: «cancella il secondo impegno della lista» sceglie tra impegni simili", async () => {
  const cervello = creaCervelloFinto((r, n) => (r.messaggi.at(-1)!.ruolo === "risultati" ? { testo: "Quale?" } : { chiamate: [{ id: `t${n}`, nome: "agenda_cancella", input: { titolo: "riunione" } }] }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    aggiungiImpegno(a.db, { titolo: "Riunione con Rossi", data: domani(), ora: "09:00" }, "Europe/Rome");
    aggiungiImpegno(a.db, { titolo: "Riunione con Bianchi", data: domani(), ora: "11:00" }, "Europe/Rome");
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella la riunione", vista: "privato" } }));
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    const si = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "sì", vista: "privato", conversazione: conv } }));
    assert.match(testoDetto(si), /quale/, "un «sì» non basta per scegliere");
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 2);
    const r = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella il secondo impegno della lista", vista: "privato", conversazione: conv } }));
    assert.match(testoDetto(r), /Cancellato: Riunione con Bianchi/);
  } finally { await a.chiudi(); }
});
