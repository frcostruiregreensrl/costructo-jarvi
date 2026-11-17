// Password con scrypt (node:crypto). Formato salvato: scrypt$N$r$p$sale$hash (base64).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, LUNGHEZZA = 64;

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error("La password deve avere almeno 12 caratteri.");
  const sale = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), sale, LUNGHEZZA, { N, r: R, p: P });
  return ["scrypt", N, R, P, sale.toString("base64"), hash.toString("base64")].join("$");
}

export function verificaPassword(password: string, salvata: string): boolean {
  const parti = salvata.split("$");
  if (parti.length !== 6 || parti[0] !== "scrypt") return false;
  const [, n, r, p, saleB64, hashB64] = parti;
  const atteso = Buffer.from(hashB64, "base64");
  const calcolato = scryptSync(password.normalize("NFKC"), Buffer.from(saleB64, "base64"), atteso.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return calcolato.length === atteso.length && timingSafeEqual(calcolato, atteso);
}
