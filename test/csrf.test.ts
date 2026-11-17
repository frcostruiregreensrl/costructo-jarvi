import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente } from "./aiuto.js";

test("CSRF: le scritture senza Origin o con Origin estraneo sono rifiutate", async () => {
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const corpo = JSON.stringify({ spazio: "privato", testo: "prova" });
    const senza = await fetch(a.base + "/api/memorie", { method: "POST", headers: { "Content-Type": "application/json", Cookie: a.cookie }, body: corpo });
    assert.equal(senza.status, 403);
    const estraneo = await a.chiama("/api/memorie", { method: "POST", headers: { Origin: "https://sito-cattivo.example" }, json: { spazio: "privato", testo: "prova" } });
    assert.equal(estraneo.status, 403);
    const ok = await a.chiama("/api/memorie", { method: "POST", json: { spazio: "privato", testo: "prova" } });
    assert.equal(ok.status, 200);
    // corpo text/plain (il trucco "no-cors" dell'attacco all'originale) rifiutato
    const testo = await a.chiama("/api/impostazioni", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: '{"tettoMensileUsd":999}' });
    assert.equal(testo.status, 415);
    const negati = a.db.prepare("SELECT COUNT(*) n FROM registro WHERE azione = 'sicurezza.csrf'").get() as { n: number };
    assert.equal(negati.n, 2);
  } finally { await a.chiudi(); }
});

test("DNS rebinding: Host non ammesso → 421", async () => {
  const a = await avviaAmbiente();
  try {
    const { request } = await import("node:http");
    const stato = await new Promise<number>((ok) => {
      const u = new URL(a.base);
      request({ host: u.hostname, port: u.port, path: "/api/stato", headers: { Host: "attaccante.example" } }, (r) => { r.resume(); ok(r.statusCode!); }).end();
    });
    assert.equal(stato, 421);
  } finally { await a.chiudi(); }
});

test("intestazioni di sicurezza e limite di dimensione", async () => {
  const a = await avviaAmbiente();
  try {
    const r = await a.chiama("/api/stato");
    assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.match(r.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-powered-by"), null);
    await a.accedi();
    const grande = await a.chiama("/api/memorie", { method: "POST", json: { spazio: "privato", testo: "x".repeat(70_000) } });
    assert.equal(grande.status, 413);
  } finally { await a.chiudi(); }
});
