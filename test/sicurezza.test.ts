import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verificaPassword } from "../src/sicurezza/password.js";
import { codiceTotp, verificaTotp, base32Codifica, passoAttuale } from "../src/sicurezza/totp.js";
import { creaCifratore, chiaveDaFrase } from "../src/sicurezza/cifra.js";
import { avviaAmbiente, dbProvvisorio, PASSWORD, SEGRETO } from "./aiuto.js";
import { registraErrore, ritardoAccesso, bloccatoPer, REGOLA_ACCESSO_IP, REGOLA_ACCESSO_GLOBALE, CHIAVE_GLOBALE } from "../src/sicurezza/limiti.js";
import { leggiConfig } from "../src/config.js";

test("password: scrypt, giusta e sbagliata, minimo 12 caratteri", () => {
  const h = hashPassword("una-password-lunga");
  assert.match(h, /^scrypt\$/);
  assert.ok(verificaPassword("una-password-lunga", h));
  assert.ok(!verificaPassword("una-password-lungA", h));
  assert.throws(() => hashPassword("corta"));
});

test("TOTP: vettore ufficiale RFC 6238 e anti-riuso", () => {
  const segreto = base32Codifica(Buffer.from("12345678901234567890"));
  assert.equal(codiceTotp(segreto, Math.floor(59 / 30)), "287082");
  assert.equal(codiceTotp(segreto, Math.floor(1111111109 / 30)), "081804");
  const ora = 1_700_000_000_000;
  const codice = codiceTotp(segreto, passoAttuale(ora));
  const passo = verificaTotp(segreto, codice, 0, ora);
  assert.equal(passo, passoAttuale(ora));
  assert.equal(verificaTotp(segreto, codice, passo!, ora), null, "lo stesso codice non vale due volte");
  const sbagliato = String((Number(codice) + 500_000) % 1_000_000).padStart(6, "0");
  assert.equal(verificaTotp(segreto, sbagliato, 0, ora), null);
  assert.equal(verificaTotp(segreto, "12345", 0, ora), null);
});

test("cifratura dei segreti: AES-GCM, manomissione rilevata", () => {
  const c = creaCifratore(chiaveDaFrase("x"));
  const x = c.cifra("csa_segreto");
  assert.notEqual(x, "csa_segreto");
  assert.equal(c.decifra(x), "csa_segreto");
  const parti = x.split(".");
  parti[3] = Buffer.from("altro").toString("base64");
  assert.throws(() => c.decifra(parti.join(".")));
  assert.throws(() => creaCifratore(""));
});

test("accesso: password + codice, cookie sicuro, API chiuse senza sessione, uscita", async () => {
  const a = await avviaAmbiente();
  try {
    assert.equal((await a.chiama("/api/avvio")).status, 401);
    const sbagliato = await a.chiama("/api/accesso", { method: "POST", json: { password: PASSWORD, codice: "000000" } });
    assert.equal(sbagliato.status, 401);
    await a.accedi();
    const r = await a.chiama("/api/accesso", { method: "POST", json: { password: "x", codice: "123456" } });
    assert.equal(r.status, 401);
    const avvio = await a.chiama("/api/avvio");
    assert.equal(avvio.status, 200);
    assert.equal((await avvio.json()).nome, "Luigi");
    await a.chiama("/api/uscita", { method: "POST", json: {} });
    assert.equal((await a.chiama("/api/avvio")).status, 401);
    const reg = a.db.prepare("SELECT esito FROM registro WHERE azione = 'accesso'").all() as Array<{ esito: string }>;
    assert.ok(reg.some((x) => x.esito === "fatto") && reg.some((x) => x.esito === "negato"));
  } finally { await a.chiudi(); }
});

test("accesso: il cookie è HttpOnly e SameSite=Strict", async () => {
  const a = await avviaAmbiente();
  try {
    const r = await a.chiama("/api/accesso", { method: "POST", json: { password: PASSWORD, codice: codiceTotp(SEGRETO, passoAttuale()) } });
    const c = r.headers.get("set-cookie") || "";
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
  } finally { await a.chiudi(); }
});

test("limite tentativi: dopo 5 errori anche la password giusta viene bloccata (429)", async () => {
  const a = await avviaAmbiente();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await a.chiama("/api/accesso", { method: "POST", json: { password: "sbagliata-sbagliata", codice: "111111" } });
      assert.equal(r.status, 401);
    }
    const bloccato = await a.chiama("/api/accesso", { method: "POST", json: { password: PASSWORD, codice: codiceTotp(SEGRETO, passoAttuale()) } });
    assert.equal(bloccato.status, 429);
    assert.match((await bloccato.json()).errore, /Troppi tentativi/);
  } finally { await a.chiudi(); }
});

test("limite tentativi: nessun blocco globale — chi sbaglia apposta da altri indirizzi non chiude fuori Luigi", async () => {
  const a = await avviaAmbiente();
  try {
    // 30 errori «da altri indirizzi» nell'ultima ora
    for (let i = 0; i < 30; i++) {
      registraErrore(a.db, `accesso:ip:203.0.113.${i}`, REGOLA_ACCESSO_IP);
      registraErrore(a.db, CHIAVE_GLOBALE, REGOLA_ACCESSO_GLOBALE);
    }
    assert.equal(ritardoAccesso(a.db), 2500, "oltre 20 errori totali: solo un ritardo crescente");
    const inizio = Date.now();
    const r = await a.chiama("/api/accesso", { method: "POST", json: { password: PASSWORD, codice: codiceTotp(SEGRETO, passoAttuale()) } });
    assert.equal(r.status, 200, "Luigi entra lo stesso");
    assert.ok(Date.now() - inizio >= 2400, "con il ritardo previsto");
  } finally { await a.chiudi(); }
});

test("limite tentativi: il ritardo cresce e ha un massimo; JARVIS_PROXY si legge dalla configurazione", () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    assert.equal(ritardoAccesso(db), 0);
    for (let i = 0; i < 20; i++) registraErrore(db, CHIAVE_GLOBALE, REGOLA_ACCESSO_GLOBALE);
    assert.equal(ritardoAccesso(db), 0);
    registraErrore(db, CHIAVE_GLOBALE, REGOLA_ACCESSO_GLOBALE);
    assert.equal(ritardoAccesso(db), 250);
    for (let i = 0; i < 100; i++) registraErrore(db, CHIAVE_GLOBALE, REGOLA_ACCESSO_GLOBALE);
    assert.equal(ritardoAccesso(db), 5000);
    assert.equal(bloccatoPer(db, CHIAVE_GLOBALE), 0, "mai bloccato");
    assert.equal(ritardoAccesso(db, Date.now() + 61 * 60_000), 0, "dopo un'ora si riparte da zero");
    assert.equal(leggiConfig({ JARVIS_PROXY: "1" } as NodeJS.ProcessEnv).fidatiProxy, true);
    assert.equal(leggiConfig({} as NodeJS.ProcessEnv).fidatiProxy, false);
  } finally { chiudi(); }
});
