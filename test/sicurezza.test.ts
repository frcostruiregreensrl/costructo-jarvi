import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verificaPassword } from "../src/sicurezza/password.js";
import { codiceTotp, verificaTotp, base32Codifica, passoAttuale } from "../src/sicurezza/totp.js";
import { creaCifratore, chiaveDaFrase } from "../src/sicurezza/cifra.js";
import { avviaAmbiente, PASSWORD, SEGRETO } from "./aiuto.js";

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
