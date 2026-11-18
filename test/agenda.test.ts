import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente, leggiEventi, testoDetto, dbProvvisorio } from "./aiuto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { aggiungiImpegno, impegniProssimiGiorni } from "../src/agenda.js";
import { dataIso, oraMinuti } from "../src/tempo.js";

const domani = () => dataIso(Date.now() + 864e5, "Europe/Rome");

test("agenda: l'ora è nel fuso di Luigi, non in quello del server", () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const i = aggiungiImpegno(db, { titolo: "Dentista", data: "2026-07-01", ora: "15:30" }, "Europe/Rome");
    assert.equal(new Date(i.inizio).toISOString(), "2026-07-01T13:30:00.000Z");
    assert.equal(oraMinuti(i.inizio, "Europe/Rome"), "15:30");
    assert.throws(() => aggiungiImpegno(db, { titolo: "x", data: "2026-02-30", ora: "" }, "Europe/Rome"));
  } finally { chiudi(); }
});

test("agenda via AI: aggiunge, elenca e cancella un impegno unico", async () => {
  const d = domani();
  const copioni: Record<string, Array<{ nome: string; input: unknown }>> = {
    "segna palestra domani alle 18": [{ nome: "agenda_aggiungi", input: { titolo: "Palestra", data: d, ora: "18:00", minuti: 60 } }],
    "cancella la palestra": [{ nome: "agenda_cancella", input: { titolo: "palestra" } }],
  };
  const cervello = creaCervelloFinto((r, n) => {
    const ultimo = r.messaggi[r.messaggi.length - 1];
    if (ultimo.ruolo === "risultati") return { testo: "Fatto, signore." };
    const testo = ultimo.ruolo === "utente" ? ultimo.testo : "";
    const chiave = Object.keys(copioni).find((k) => testo.endsWith(k))!;
    return { chiamate: copioni[chiave].map((c, i) => ({ id: `t${n}-${i}`, ...c })) };
  });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "segna palestra domani alle 18", vista: "privato" } }));
    assert.ok(ev.some((e) => e.tipo === "agenda"));
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 1);
    const lista = await (await a.chiama("/api/agenda?giorni=3")).json();
    assert.equal(lista[0].titolo, "Palestra");
    await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella la palestra", vista: "privato" } }));
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 0);
  } finally { await a.chiudi(); }
});

test("agenda: cancellazione ambigua → chiede quale, non cancella niente; poi «il secondo» cancella quello giusto", async () => {
  const cervello = creaCervelloFinto((r, n) => {
    const ultimo = r.messaggi[r.messaggi.length - 1];
    if (ultimo.ruolo === "risultati") return { testo: "Ce ne sono due: quale?" };
    return { chiamate: [{ id: `t${n}`, nome: "agenda_cancella", input: { titolo: "riunione" } }] };
  });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const d = domani();
    aggiungiImpegno(a.db, { titolo: "Riunione con Rossi", data: d, ora: "09:00" }, "Europe/Rome");
    aggiungiImpegno(a.db, { titolo: "Riunione con Bianchi", data: d, ora: "11:00" }, "Europe/Rome");
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella la riunione", vista: "privato" } }));
    const conferma = ev.find((e) => e.tipo === "conferma") as { id: string; opzioni: Array<{ testo: string }> };
    assert.ok(conferma, "deve chiedere conferma");
    assert.equal(conferma.opzioni.length, 2);
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 2, "niente cancellato");
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    const risposta = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "il secondo", vista: "privato", conversazione: conv } }));
    assert.match(testoDetto(risposta), /Cancellato: Riunione con Bianchi/);
    assert.deepEqual(impegniProssimiGiorni(a.db, 3, "Europe/Rome").map((i) => i.titolo), ["Riunione con Rossi"]);
    assert.equal(cervello.richieste.length, 2, "la risposta «il secondo» non ha chiamato l'AI");
  } finally { await a.chiudi(); }
});

test("agenda: conferma anche con il pulsante (API) e «annulla»", async () => {
  const cervello = creaCervelloFinto((r, n) => {
    const ultimo = r.messaggi[r.messaggi.length - 1];
    if (ultimo.ruolo === "risultati") return { testo: "Quale?" };
    return { chiamate: [{ id: `t${n}`, nome: "agenda_cancella", input: { titolo: "cena" } }] };
  });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    const d = domani();
    aggiungiImpegno(a.db, { titolo: "Cena con Anna", data: d, ora: "20:00" }, "Europe/Rome");
    aggiungiImpegno(a.db, { titolo: "Cena di lavoro", data: d, ora: "21:00" }, "Europe/Rome");
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "elimina la cena", vista: "tutto" } }));
    const c = ev.find((e) => e.tipo === "conferma") as { id: string };
    const r = await (await a.chiama(`/api/conferme/${c.id}`, { method: "POST", json: { scelta: "annulla" } })).json();
    assert.ok(r.ok);
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 2);
    const di_nuovo = await (await a.chiama(`/api/conferme/${c.id}`, { method: "POST", json: { scelta: 0 } })).json();
    assert.equal(di_nuovo.ok, false, "una conferma annullata non si riusa");
  } finally { await a.chiudi(); }
});
