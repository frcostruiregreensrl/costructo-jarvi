import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio } from "./aiuto.js";
import { apriConversazione, aggiungiMessaggio, ultimiMessaggi, pulisciConversazioniVecchie, CONSERVAZIONE_MS } from "../src/conversazioni.js";
import { aggiungiMemoria, elencaMemorie } from "../src/memorie.js";

test("conversazioni: i messaggi oltre 30 giorni vengono cancellati, i ricordi espliciti restano", () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const ora = Date.UTC(2026, 10, 17, 9);
    const vecchia = apriConversazione(db, "privato", undefined, ora - CONSERVAZIONE_MS - 864e5);
    aggiungiMessaggio(db, vecchia, "utente", "messaggio di due mesi fa", ora - CONSERVAZIONE_MS - 864e5);
    const recente = apriConversazione(db, "lavoro", undefined, ora - 864e5);
    aggiungiMessaggio(db, recente, "utente", "vecchio di 31 giorni", ora - CONSERVAZIONE_MS - 1000);
    aggiungiMessaggio(db, recente, "jarvis", "di ieri", ora - 864e5);
    aggiungiMemoria(db, "privato", "ricordo esplicito vecchissimo", "luigi", ora - 400 * 864e5);
    const tolti = pulisciConversazioniVecchie(db, ora);
    assert.equal(tolti, 2);
    assert.equal(ultimiMessaggi(db, vecchia).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM conversazioni WHERE id = ?").get(vecchia) as { n: number }).n, 0, "conversazione vuota tolta");
    assert.deepEqual(ultimiMessaggi(db, recente).map((m) => m.testo), ["di ieri"]);
    assert.equal(elencaMemorie(db, "privato").length, 1, "i ricordi non scadono");
  } finally { chiudi(); }
});
