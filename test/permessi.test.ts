import { test } from "node:test";
import assert from "node:assert/strict";
import { controllaPermesso, haIntenzione } from "../src/permessi.js";
import { dbProvvisorio } from "./aiuto.js";
import { eseguiStrumento } from "../src/strumenti.js";
import { registra, leggiRegistro } from "../src/registro.js";

test("permessi: matrice della Fase 1 (livello 2)", () => {
  const c = (vista: "privato" | "lavoro" | "tutto", messaggioLuigi: string, spazio?: "privato" | "lavoro") => ({ vista, messaggioLuigi, spazio });
  assert.equal(controllaPermesso("costructo.leggi", c("lavoro", "")).esito, "consentito");
  assert.equal(controllaPermesso("costructo.leggi", c("privato", "")).esito, "negato");
  assert.equal(controllaPermesso("costructo.scrivi", c("tutto", "scrivi in costructo")).esito, "negato");
  assert.equal(controllaPermesso("email.invia", c("tutto", "manda la mail")).esito, "negato");
  assert.equal(controllaPermesso("agenda.aggiungi", c("privato", "segna il dentista martedì")).esito, "consentito");
  assert.equal(controllaPermesso("agenda.aggiungi", c("privato", "cosa ho domani?")).esito, "conferma");
  assert.equal(controllaPermesso("agenda.aggiungi", c("lavoro", "segna il dentista")).esito, "negato");
  assert.equal(controllaPermesso("agenda.cancella", c("tutto", "segna la cena")).esito, "conferma", "una richiesta di aggiungere non autorizza a cancellare");
  assert.equal(controllaPermesso("memoria.salva", c("lavoro", "ricordati che", "privato")).esito, "negato");
  assert.equal(controllaPermesso("memoria.salva", c("tutto", "ricordati che", "privato")).esito, "consentito");
  assert.ok(haIntenzione("memoria.salva", "Tieni a mente che il codice del cancello è nuovo"));
  assert.ok(!haIntenzione("memoria.salva", "ti ricordi cosa ti ho detto?"));
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
