import { test } from "node:test";
import assert from "node:assert/strict";
import { controllaPermesso, haIntenzione, oggettoNelMessaggio } from "../src/permessi.js";
import { dbProvvisorio, avviaAmbiente, leggiEventi, testoDetto } from "./aiuto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { aggiungiImpegno, impegniProssimiGiorni } from "../src/agenda.js";
import { dataIso } from "../src/tempo.js";

const domani = () => dataIso(Date.now() + 864e5, "Europe/Rome");
import { eseguiStrumento } from "../src/strumenti.js";
import { registra, leggiRegistro } from "../src/registro.js";

test("permessi: matrice della Fase 1 (livello 2)", () => {
  const c = (vista: "privato" | "lavoro" | "tutto", messaggioLuigi: string, spazio?: "privato" | "lavoro", oggetto?: string) => ({ vista, messaggioLuigi, spazio, oggetto });
  assert.equal(controllaPermesso("costructo.leggi", c("lavoro", "")).esito, "consentito");
  assert.equal(controllaPermesso("costructo.leggi", c("privato", "")).esito, "negato");
  assert.equal(controllaPermesso("costructo.scrivi", c("tutto", "scrivi in costructo")).esito, "negato");
  assert.equal(controllaPermesso("email.invia", c("tutto", "manda la mail")).esito, "negato");
  assert.equal(controllaPermesso("agenda.aggiungi", c("privato", "segna il dentista martedì", undefined, "Dentista")).esito, "consentito");
  assert.equal(controllaPermesso("agenda.aggiungi", c("privato", "segna il dentista martedì")).esito, "conferma", "senza oggetto si chiede conferma");
  assert.equal(controllaPermesso("agenda.aggiungi", c("privato", "cosa ho domani?")).esito, "conferma");
  assert.equal(controllaPermesso("agenda.aggiungi", c("lavoro", "segna il dentista")).esito, "negato");
  assert.equal(controllaPermesso("agenda.cancella", c("tutto", "segna la cena")).esito, "conferma", "una richiesta di aggiungere non autorizza a cancellare");
  assert.equal(controllaPermesso("memoria.salva", c("lavoro", "ricordati che", "privato")).esito, "negato");
  assert.equal(controllaPermesso("memoria.salva", c("tutto", "ricordati che preferisco il caffè amaro", "privato", "Luigi preferisce il caffè amaro")).esito, "consentito");
  assert.ok(haIntenzione("memoria.salva", "Tieni a mente che il codice del cancello è nuovo"));
  assert.ok(!haIntenzione("memoria.salva", "ti ricordi cosa ti ho detto?"));
});

test("permessi: il verbo è legato all'oggetto («cancella la palestra» non autorizza il dentista)", () => {
  const msg = "cancella la palestra di domani";
  const p = (oggetto: string, giaFatte = 0) => controllaPermesso("agenda.cancella", { vista: "privato", messaggioLuigi: msg, oggetto, giaFatte }).esito;
  assert.equal(p("palestra"), "consentito");
  assert.equal(p("Palestra di domani"), "consentito");
  assert.equal(p("Dentista"), "conferma", "oggetto non chiesto da Luigi");
  assert.equal(p("Cena"), "conferma");
  assert.equal(p("palestra", 1), "conferma", "una seconda cancellazione nello stesso turno chiede conferma");
  assert.equal(p("pa"), "conferma", "un oggetto troppo vago non basta");
  assert.ok(oggettoNelMessaggio("Riunioni", "cancella la riunione"), "singolare e plurale");
  assert.ok(!oggettoNelMessaggio("Domani", "cancella la palestra di domani"), "le parole vuote (domani, oggi…) non contano");
});

test("permessi: «ricordami» vale per i promemoria, ma «ricordami cosa ho domani» è una domanda", () => {
  assert.ok(!haIntenzione("agenda.aggiungi", "ricordami cosa ho domani"));
  assert.ok(!haIntenzione("agenda.aggiungi", "Ricordami quando ho il dentista?"));
  assert.ok(!haIntenzione("agenda.aggiungi", "ricordami se ho impegni venerdì"));
  assert.ok(haIntenzione("agenda.aggiungi", "ricordami di chiamare Rossi domani alle 9"));
  assert.ok(haIntenzione("agenda.aggiungi", "ricordami cosa ho domani e segna la palestra alle 18"), "se c'è anche un verbo di scrittura vale quello");
  assert.ok(!haIntenzione("memoria.salva", "ricordami di chiamare Rossi"), "«ricordami» non salva ricordi");
  const p = (m: string, oggetto: string) => controllaPermesso("agenda.aggiungi", { vista: "privato", messaggioLuigi: m, oggetto }).esito;
  assert.equal(p("ricordami cosa ho domani", "Bonifico urgente"), "conferma");
  assert.equal(p("ricordami di chiamare Rossi domani alle 9", "Chiamare Rossi"), "consentito");
  assert.equal(p("ricordami di chiamare Rossi domani alle 9", "Bonifico urgente"), "conferma");
});

test("permessi: «cancella la palestra di domani» con 3 cancellazioni indotte da un dato esterno → cancella solo la palestra", async () => {
  const cervello = creaCervelloFinto((_r, n) => n === 0 ? { chiamate: [
    { id: "1", nome: "agenda_cancella", input: { titolo: "palestra" } },
    { id: "2", nome: "agenda_cancella", input: { titolo: "Dentista" } },
    { id: "3", nome: "agenda_cancella", input: { titolo: "Cena" } },
  ] } : { testo: "Fatto." });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    for (const t of ["Palestra", "Dentista", "Cena con Anna"]) aggiungiImpegno(a.db, { titolo: t, data: domani(), ora: "10:00" }, "Europe/Rome");
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella la palestra di domani", vista: "privato" } }));
    assert.deepEqual(impegniProssimiGiorni(a.db, 3, "Europe/Rome").map((i) => i.titolo).sort(), ["Cena con Anna", "Dentista"]);
    assert.equal(ev.filter((e) => e.tipo === "conferma").length, 2, "le altre due diventano richieste di conferma");
    const conv = (ev.find((e) => e.tipo === "fine") as { conversazione: string }).conversazione;
    // un «sì» generico non sceglie tra due richieste in attesa
    const si = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "sì", vista: "privato", conversazione: conv } }));
    assert.match(testoDetto(si), /pulsanti/);
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 2);
  } finally { await a.chiudi(); }
});

test("permessi: due cancellazioni chieste nello stesso messaggio → la seconda chiede conferma", async () => {
  const cervello = creaCervelloFinto((_r, n) => n === 0 ? { chiamate: [
    { id: "1", nome: "agenda_cancella", input: { titolo: "palestra" } },
    { id: "2", nome: "agenda_cancella", input: { titolo: "dentista" } },
  ] } : { testo: "ok" });
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    for (const t of ["Palestra", "Dentista"]) aggiungiImpegno(a.db, { titolo: t, data: domani(), ora: "10:00" }, "Europe/Rome");
    const ev = await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "cancella palestra e dentista", vista: "privato" } }));
    assert.deepEqual(impegniProssimiGiorni(a.db, 3, "Europe/Rome").map((i) => i.titolo), ["Dentista"]);
    const c = ev.find((e) => e.tipo === "conferma") as { id: string };
    const r = await (await a.chiama(`/api/conferme/${c.id}`, { method: "POST", json: { scelta: "conferma" } })).json();
    assert.ok(r.ok, "con il pulsante Luigi conferma la seconda");
    assert.equal(impegniProssimiGiorni(a.db, 3, "Europe/Rome").length, 0);
  } finally { await a.chiudi(); }
});

test("registro: ogni strumento lascia una riga, con esito", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const ctx = { db, fuso: "Europe/Rome", vista: "privato" as const, messaggioLuigi: "mostrami il numero", conversazione: "c", costructo: null, linkCalendario: () => "", emetti: () => {} };
    await eseguiStrumento("mostra_numero", { etichetta: "ore", valore: 8, suffisso: "" }, ctx);
    await eseguiStrumento("mostra_numero", { etichetta: "ore", valore: "otto", suffisso: "" }, ctx);
    await eseguiStrumento("costructo_cantieri", {}, ctx);
    await eseguiStrumento("formatta_disco", {}, ctx);
    registra(db, "accesso", "fatto", "luigi");
    const r = leggiRegistro(db);
    assert.deepEqual(r.map((x) => `${x.azione}:${x.esito}`), [
      "accesso:fatto", "sconosciuto:formatta_disco:negato", "costructo.leggi:negato", "interfaccia.numero:errore", "interfaccia.numero:fatto",
    ]);
    assert.equal(leggiRegistro(db, 2).length, 2);
    assert.equal(leggiRegistro(db, 10, r[1].id).length, 3);
  } finally { chiudi(); }
});
