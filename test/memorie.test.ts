import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio, avviaAmbiente } from "./aiuto.js";
import { aggiungiMemoria, elencaMemorie, cancellaMemoria, correggiMemoria, cancellaTutteLeMemorie, esportaMemorie } from "../src/memorie.js";
import { eseguiStrumento, strumentiPerVista } from "../src/strumenti.js";

const ctx = (db: ReturnType<typeof dbProvvisorio>["db"], vista: "privato" | "lavoro" | "tutto", messaggioLuigi: string) => ({
  db, fuso: "Europe/Rome", vista, messaggioLuigi, conversazione: "c1", costructo: null, linkCalendario: () => "", emetti: () => {},
});

test("memorie: privato e lavoro restano separati; doppioni evitati; modifica e cancellazione", () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const p = aggiungiMemoria(db, "privato", "Luigi va in palestra il martedì", "luigi");
    aggiungiMemoria(db, "lavoro", "Il cantiere Verdi usa il ponteggio grande", "jarvis");
    aggiungiMemoria(db, "privato", "luigi va in palestra il martedì", "jarvis");
    assert.deepEqual(elencaMemorie(db, "privato").map((m) => m.testo), ["Luigi va in palestra il martedì"]);
    assert.deepEqual(elencaMemorie(db, "lavoro").map((m) => m.testo), ["Il cantiere Verdi usa il ponteggio grande"]);
    assert.equal(elencaMemorie(db, "tutto").length, 2);
    const c = correggiMemoria(db, p.id, { testo: "Luigi va in palestra il giovedì" });
    assert.equal(c?.origine, "luigi");
    assert.ok(cancellaMemoria(db, p.id));
    assert.equal(elencaMemorie(db, "privato").length, 0);
    assert.equal(cancellaTutteLeMemorie(db, "lavoro"), 1);
    assert.match(esportaMemorie(db), /## Privato/);
  } finally { chiudi(); }
});

test("memorie: dalla scheda Privato l'AI non può scrivere o leggere ricordi di lavoro", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    aggiungiMemoria(db, "lavoro", "Margine riservato del preventivo Bianchi: 18%", "luigi");
    const leggi = await eseguiStrumento("ricordi_leggi", { spazio: "lavoro" }, ctx(db, "privato", "cosa ricordi?"));
    assert.ok(leggi.errore);
    assert.doesNotMatch(leggi.contenuto, /18%/);
    const salva = await eseguiStrumento("ricordo_salva", { testo: "x di lavoro", spazio: "lavoro" }, ctx(db, "privato", "ricordati che x"));
    assert.ok(salva.errore);
    assert.equal(elencaMemorie(db, "lavoro").length, 1);
    const ok = await eseguiStrumento("ricordo_salva", { testo: "Luigi ama il risotto", spazio: "privato" }, ctx(db, "privato", "ricordati che amo il risotto"));
    assert.ok(!ok.errore);
    assert.equal(elencaMemorie(db, "privato").length, 1);
    // nella scheda privato gli strumenti di Costructo non vengono nemmeno offerti
    assert.ok(!strumentiPerVista("privato").some((s) => s.nome.startsWith("costructo_")));
    assert.ok(!strumentiPerVista("lavoro").some((s) => s.nome.startsWith("agenda_")));
  } finally { chiudi(); }
});

test("memorie via API: crea, correggi, cancella, nessun ricordo di lavoro nella vista privato", async () => {
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const m = await (await a.chiama("/api/memorie", { method: "POST", json: { spazio: "lavoro", testo: "Fornitore preferito: Rossi" } })).json();
    await a.chiama("/api/memorie", { method: "POST", json: { spazio: "privato", testo: "Compleanno di Anna il 3 maggio" } });
    const priv = await (await a.chiama("/api/memorie?vista=privato")).json();
    assert.deepEqual(priv.map((x: { testo: string }) => x.testo), ["Compleanno di Anna il 3 maggio"]);
    const c = await a.chiama(`/api/memorie/${m.id}`, { method: "PATCH", json: { testo: "Fornitore preferito: Bianchi" } });
    assert.equal((await c.json()).testo, "Fornitore preferito: Bianchi");
    assert.equal((await a.chiama(`/api/memorie/${m.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await (await a.chiama("/api/memorie?vista=lavoro")).json()).length, 0);
    const reg = a.db.prepare("SELECT azione FROM registro WHERE origine = 'luigi' AND azione LIKE 'memoria.%'").all() as Array<{ azione: string }>;
    assert.deepEqual(reg.map((r) => r.azione).sort(), ["memoria.cancella", "memoria.correggi", "memoria.salva", "memoria.salva"]);
  } finally { await a.chiudi(); }
});
