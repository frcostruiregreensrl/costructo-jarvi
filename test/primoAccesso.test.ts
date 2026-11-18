// Primo accesso dal browser: esiste solo con database vuoto e JARVIS_CODICE_PRIMO_ACCESSO impostato.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { dbProvvisorio, cifratore } from "./aiuto.js";
import { leggiConfig } from "../src/config.js";
import { creaApp } from "../src/app.js";
import { codiceTotp, passoAttuale } from "../src/sicurezza/totp.js";

async function avvia(codice: string) {
  const { db, chiudi } = dbProvvisorio();
  const config = leggiConfig({ JARVIS_ORIGINE: "http://127.0.0.1:1", JARVIS_CODICE_PRIMO_ACCESSO: codice } as NodeJS.ProcessEnv);
  const server = creaApp({ config, db, cifratore }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origine = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.origineAmmessa.splice(0, config.origineAmmessa.length, origine);
  const post = (percorso: string, json: unknown) =>
    fetch(origine + percorso, { method: "POST", headers: { Origin: origine, "Content-Type": "application/json" }, body: JSON.stringify(json) });
  const stato = async () => (await fetch(origine + "/api/stato")).json();
  return { post, stato, fine: async () => { await new Promise((r) => server.close(r)); chiudi(); } };
}

test("primo accesso: codice giusto crea l'utente una volta sola, poi la rotta sparisce", async () => {
  const a = await avvia("codice-segreto-lungo-di-prova");
  try {
    assert.equal((await a.stato()).primoAccesso, true);
    assert.equal((await a.post("/api/primo-accesso", { codice: "sbagliato", nome: "Luigi", password: "password-lunga-123" })).status, 401);
    assert.equal((await a.post("/api/primo-accesso", { codice: "codice-segreto-lungo-di-prova", nome: "Luigi", password: "corta" })).status, 400);
    const r = await a.post("/api/primo-accesso", { codice: "codice-segreto-lungo-di-prova", nome: "Luigi", password: "password-lunga-123" });
    assert.equal(r.status, 200);
    const corpo = await r.json() as { segreto: string; link: string };
    assert.match(corpo.link, /^otpauth:\/\//);
    assert.equal((await a.stato()).primoAccesso, false);
    // seconda volta: non esiste più, anche con il codice giusto
    assert.equal((await a.post("/api/primo-accesso", { codice: "codice-segreto-lungo-di-prova", nome: "X", password: "password-lunga-456" })).status, 404);
    // l'accesso normale funziona con password e codice TOTP del segreto appena creato
    const acc = await a.post("/api/accesso", { password: "password-lunga-123", codice: codiceTotp(corpo.segreto, passoAttuale()) });
    assert.equal(acc.status, 200);
  } finally { await a.fine(); }
});

test("primo accesso: senza la variabile d'ambiente la rotta non esiste", async () => {
  const a = await avvia("");
  try {
    assert.equal((await a.stato()).primoAccesso, false);
    assert.equal((await a.post("/api/primo-accesso", { codice: "x", nome: "Luigi", password: "password-lunga-123" })).status, 404);
  } finally { await a.fine(); }
});

test("primo accesso: troppi codici sbagliati bloccano l'indirizzo", async () => {
  const a = await avvia("codice-giusto-lungo");
  try {
    let ultimo = 0;
    for (let i = 0; i < 12; i++) ultimo = (await a.post("/api/primo-accesso", { codice: `no-${i}`, nome: "Luigi", password: "password-lunga-123" })).status;
    assert.equal(ultimo, 429);
  } finally { await a.fine(); }
});
