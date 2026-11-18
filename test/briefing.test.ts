import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio, avviaAmbiente } from "./aiuto.js";
import { creaBriefing, testoNotifica } from "../src/briefing.js";
import { creaClientCostructo } from "../src/costructo.js";
import { aggiungiImpegno } from "../src/agenda.js";
import { salvaImpostazioni } from "../src/impostazioni.js";
import { controllaOraBriefing, salvaIscrizione, type Invia } from "../src/push.js";
import { dataIso, daOraLocale } from "../src/tempo.js";
import { avviaCostructoFinto, TOKEN } from "./costructoFinto.js";

test("briefing: impegni, cantieri, scadenze, documenti, fatture e meteo (Open-Meteo finto), senza AI", async () => {
  const { db, chiudi } = dbProvvisorio();
  const f = await avviaCostructoFinto();
  try {
    const oggi = dataIso(Date.now(), "Europe/Rome");
    aggiungiImpegno(db, { titolo: "Dentista", data: oggi, ora: "23:59" }, "Europe/Rome");
    f.risposte["/briefing"] = { corpo: {
      impegni: [{ titolo: "Sopralluogo Villa Verdi", inizio: new Date(Date.now() + 3600_000).toISOString() }],
      cantieri: [{ nome: "Villa Verdi", lat: 45.4, lon: 11.2 }, { nome: "Scuola" }],
      scadenze: [{ titolo: "F24 di novembre", scadenza: "2026-11-30" }],
      documentiInScadenza: [{ titolo: "DURC", scadenza: "2026-11-25" }],
      fattureDaIncassare: [{ cliente: "Rossi", residuo: 1200 }, { cliente: "Bianchi", importo: 800 }],
    } };
    salvaImpostazioni(db, { meteoCantieri: true, comeChiamarmi: "Luigi" });
    const meteoFinto = (async (u: URL | string) => {
      assert.match(String(u), /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=45\.4000/);
      return Response.json({ daily: { precipitation_probability_max: [80], temperature_2m_max: [12], temperature_2m_min: [5] } });
    }) as unknown as typeof fetch;
    const b = await creaBriefing({ db, fuso: "Europe/Rome", costructo: creaClientCostructo({ url: f.url, token: TOKEN }), linkCalendario: "", fetchFn: meteoFinto });
    const testo = b.righe.map((r) => r.testo).join(" ");
    assert.match(testo, /Buongiorno Luigi/);
    assert.match(testo, /2 impegni/);
    assert.match(testo, /Cantieri aperti: 2/);
    assert.match(testo, /F24 di novembre/);
    assert.match(testo, /DURC/);
    assert.match(testo, /per 2\.?000\s€/);
    assert.match(testo, /pioggia su: Villa Verdi/);
    assert.equal(b.adesso.length, 3);
    assert.ok(testoNotifica(b).length <= 180);
  } finally { chiudi(); await f.chiudi(); }
});

test("briefing: se Costructo non risponde lo dice, ma il resto funziona", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const b = await creaBriefing({ db, fuso: "Europe/Rome", costructo: creaClientCostructo({ url: "http://127.0.0.1:1", token: TOKEN }), linkCalendario: "" });
    assert.match(b.avvisi[0], /Costructo/);
    assert.match(b.righe[1].testo, /libera/);
  } finally { chiudi(); }
});

test("notifica push del mattino: una sola volta al giorno, all'orario scelto, nella finestra di 2 ore", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const inviate: string[] = [];
    const invia: Invia = async (_i, corpo) => { inviate.push(corpo); return { statusCode: 201 }; };
    salvaIscrizione(db, { endpoint: "https://push.example/abc", keys: { p256dh: "chiave-finta-p256dh", auth: "auth-finta" } });
    const giorno = (h: number, m: number) => daOraLocale(2026, 10, 18, h, m, "Europe/Rome");
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", async () => "testo", invia, giorno(6, 59)), false);
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", async () => "testo", invia, giorno(7, 0)), true);
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", async () => "testo", invia, giorno(7, 1)), false, "non due volte");
    assert.equal(inviate.length, 1);
    assert.equal(JSON.parse(inviate[0]).titolo, "Buongiorno da Jarvis");
    salvaImpostazioni(db, { orarioBriefing: "06:30" });
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", async () => "t", invia, daOraLocale(2026, 10, 19, 15, 0, "Europe/Rome")), false, "fuori finestra");
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", async () => "t", null, daOraLocale(2026, 10, 20, 6, 30, "Europe/Rome")), false, "senza chiavi VAPID niente invio");
  } finally { chiudi(); }
});

test("impostazioni via API: valide salvate, sbagliate rifiutate, ElevenLabs resta spento", async () => {
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const ok = await a.chiama("/api/impostazioni", { method: "PUT", json: { tettoMensileUsd: 5, orarioBriefing: "06:45", paroleRisveglio: ["jarvis", "costructo"] } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).impostazioni.tettoMensileUsd, 5);
    assert.equal((await a.chiama("/api/impostazioni", { method: "PUT", json: { orarioBriefing: "25:00" } })).status, 400);
    assert.equal((await a.chiama("/api/impostazioni", { method: "PUT", json: { elevenLabsAttivo: true } })).status, 400);
    const col = await a.chiama("/api/collegamenti", { method: "PUT", json: { calendarioIcal: "http://192.168.1.2/x.ics" } });
    assert.equal(col.status, 400);
    const spesa = await (await a.chiama("/api/spesa")).json();
    assert.equal(spesa.tettoUsd, 5);
    assert.equal(spesa.modelloPredefinito, "claude-haiku-5-5");
  } finally { await a.chiudi(); }
});
