import { test } from "node:test";
import assert from "node:assert/strict";
import { provaConto, diciNumero } from "../src/calcolo.js";

test("calcolatrice: conti a voce senza AI", () => {
  assert.equal(provaConto("quanto fa 12 per 75"), 900);
  assert.equal(provaConto("Jarvis, 1.000 diviso 8"), 125);
  assert.equal(provaConto("il 22% di 1500"), 330);
  assert.equal(provaConto("22 per cento di 1500"), 330);
  assert.equal(provaConto("radice quadrata di 144"), 12);
  assert.equal(provaConto("3 al quadrato più 4 al quadrato"), 25);
  assert.equal(provaConto("aperta parentesi 2 più 3 chiusa parentesi per 4"), 20);
  assert.equal(provaConto("3,5 x 2"), 7);
  assert.equal(provaConto("2 elevato alla 10"), 1024);
  assert.equal(provaConto("10 meno -2"), 12);
});

test("calcolatrice: le frasi normali non sono conti e niente eval", () => {
  assert.equal(provaConto("cosa ho in agenda oggi?"), null);
  assert.equal(provaConto("ricordami il cantiere 12"), null);
  assert.equal(provaConto("process.exit(1)"), null);
  assert.equal(provaConto("2 +"), null);
  assert.equal(provaConto("1 diviso 0"), null, "infinito non è un risultato");
  assert.equal(diciNumero(12345.5), "12.345,5");
  assert.equal(diciNumero(0.125), "0,125");
});
