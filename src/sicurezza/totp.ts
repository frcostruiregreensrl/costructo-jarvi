// Secondo fattore TOTP (RFC 6238, SHA-1, 6 cifre, 30 secondi), solo con node:crypto.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Codifica(buf: Buffer): string {
  let bit = 0, valore = 0, out = "";
  for (const b of buf) {
    valore = (valore << 8) | b;
    bit += 8;
    while (bit >= 5) { out += ALFABETO[(valore >>> (bit - 5)) & 31]; bit -= 5; }
  }
  if (bit > 0) out += ALFABETO[(valore << (5 - bit)) & 31];
  return out;
}

export function base32Decodifica(s: string): Buffer {
  const pulita = s.toUpperCase().replace(/[\s=-]/g, "");
  let bit = 0, valore = 0;
  const out: number[] = [];
  for (const c of pulita) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error("Segreto TOTP non valido");
    valore = (valore << 5) | i;
    bit += 5;
    if (bit >= 8) { out.push((valore >>> (bit - 8)) & 255); bit -= 8; }
  }
  return Buffer.from(out);
}

export function nuovoSegretoTotp(): string {
  return base32Codifica(randomBytes(20));
}

export function codiceTotp(segreto: string, passo: number): string {
  const contatore = Buffer.alloc(8);
  contatore.writeBigUInt64BE(BigInt(passo));
  const h = createHmac("sha1", base32Decodifica(segreto)).update(contatore).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export const passoAttuale = (ora = Date.now()) => Math.floor(ora / 30_000);

/**
 * Verifica un codice accettando ±1 passo (orologi un po' sfasati).
 * Restituisce il passo usato, oppure null. Il chiamante deve rifiutare passi <= all'ultimo già usato (anti-riuso).
 */
export function verificaTotp(segreto: string, codice: string, ultimoPassoUsato: number, ora = Date.now()): number | null {
  if (!/^\d{6}$/.test(codice)) return null;
  const p = passoAttuale(ora);
  for (const passo of [p - 1, p, p + 1]) {
    if (passo <= ultimoPassoUsato) continue;
    const atteso = Buffer.from(codiceTotp(segreto, passo));
    if (timingSafeEqual(atteso, Buffer.from(codice))) return passo;
  }
  return null;
}

export function uriOtpauth(segreto: string, etichetta = "Luigi"): string {
  return `otpauth://totp/${encodeURIComponent(`Jarvis:${etichetta}`)}?secret=${segreto}&issuer=Jarvis&algorithm=SHA1&digits=6&period=30`;
}
