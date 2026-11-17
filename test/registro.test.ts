import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio, avviaAmbiente } from "./aiuto.js";
import { registra, leggiRegistro, pulisciRegistroVecchio, pulisciDettagli } from "../src/registro.js";
import { eseguiStrumento } from "../src/strumenti.js";

const TESTO = "Luigi ha una visita oncologica dal dottor Rossi il 3 dicembre";

test("registro: niente testi personali per intero, solo impronta ed estratto brevissimo", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const ctx = { db, fuso: "Europe/Rome", vista: "privato" as const, messaggioLuigi: "ricordati che ho una visita oncologica dal dottor Rossi", conversazione: "c", costructo: null, linkCalendario: () => "", emetti: () => {} };
    await eseguiStrumento("ricordo_salva", { testo: TESTO, spazio: "privato" }, ctx);
    await eseguiStrumento("strumento_finto", { testo: TESTO }, ctx);
    const righe = db.prepare("SELECT dettagli FROM registro").all() as Array<{ dettagli: string }>;
    assert.equal(righe.length, 2);
    for (const r of righe) {
      assert.ok(!r.dettagli.includes("oncologica"), r.dettagli);
      const d = JSON.parse(r.dettagli);
      assert.match(d.impronta, /^[0-9a-f]{12}$/);
      assert.ok(d.estratto.length <= 25);
    }
    assert.deepEqual(pulisciDettagli({ input: { titolo: "a" } }).estratto, "a");
    assert.equal(pulisciDettagli({ input: { titolo: "a" } }).impronta, pulisciDettagli({ input: { titolo: "a" } }).impronta, "stessa azione, stessa impronta");
  } finally { chiudi(); }
});

test("registro: dopo 30 giorni spariscono estratti e indirizzi IP, restano tipo, esito e id", () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const vecchio = Date.now() - 31 * 864e5;
    registra(db, "memoria.salva", "fatto", "jarvis", { strumento: "ricordo_salva", input: { testo: TESTO } }, vecchio);
    registra(db, "accesso", "negato", "sistema", { motivo: "credenziali errate", ip: "203.0.113.9" }, vecchio);
    registra(db, "memoria.salva", "fatto", "jarvis", { strumento: "ricordo_salva", input: { testo: TESTO } });
    assert.equal(pulisciRegistroVecchio(db), 2);
    const [nuovo, accesso, salva] = leggiRegistro(db);
    assert.ok(nuovo.dettagli.estratto, "le righe recenti restano leggibili");
    assert.deepEqual(accesso.dettagli, { motivo: "credenziali errate" });
    assert.equal(salva.dettagli.strumento, "ricordo_salva");
    assert.ok(salva.dettagli.impronta && !("estratto" in salva.dettagli));
    assert.equal(pulisciRegistroVecchio(db), 0, "una seconda pulizia non trova altro");
  } finally { chiudi(); }
});

test("registro: quando Luigi cancella un ricordo, sparisce anche il suo estratto dal registro", async () => {
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const m = await (await a.chiama("/api/memorie", { method: "POST", json: { spazio: "privato", testo: TESTO } })).json();
    registra(a.db, "memoria.salva", "fatto", "jarvis", { strumento: "ricordo_salva", input: { testo: TESTO, spazio: "privato" } });
    assert.ok(leggiRegistro(a.db).some((r) => r.dettagli.estratto));
    assert.equal((await a.chiama(`/api/memorie/${m.id}`, { method: "DELETE" })).status, 200);
    assert.ok(!leggiRegistro(a.db).some((r) => r.dettagli.estratto), "nessun estratto del ricordo cancellato");
  } finally { await a.chiudi(); }
});
