// Numeri di telefono e testi di WhatsApp. I numeri sono DATI PERSONALI:
// nel registro e nelle notifiche non vanno mai interi (al massimo le ultime 3 cifre).
import { MAX_TESTO_BYTE } from "./tipi.js";

/**
 * Porta un numero alla forma di WhatsApp: solo cifre, con il prefisso del paese (es. 393331234567).
 * Numeri italiani scritti senza prefisso (333 1234567, 06 1234567) diventano +39.
 * Restituisce null se non sembra un numero.
 */
export function normalizzaTelefono(grezzo: unknown): string | null {
  let t = String(grezzo ?? "").trim();
  if (!t) return null;
  t = t.replace(/[\s.\-/()]/g, "");
  if (t.startsWith("+")) t = t.slice(1);
  else if (t.startsWith("00")) t = t.slice(2);
  else if (/^3\d{8,9}$/.test(t) || /^0\d{5,10}$/.test(t)) t = `39${t}`;
  if (!/^\d{8,15}$/.test(t)) return null;
  return t;
}

/** Numero mascherato: restano solo le ultime 3 cifre («•••567»). */
export function mascheraTelefono(numero: string): string {
  const cifre = String(numero ?? "").replace(/\D/g, "");
  return cifre ? `•••${cifre.slice(-3)}` : "";
}

/** Nome pulito (dal profilo WhatsApp o dalla rubrica): niente caratteri di controllo né < >, al massimo 80 caratteri. */
export function pulisciNome(n: unknown): string {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u2028\u2029\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Testo breve: senza caratteri di controllo, al massimo 4 KB (senza spezzare un carattere). */
export function testoBreve(testo: unknown, max = MAX_TESTO_BYTE): string {
  let t = String(testo ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(t) <= max) return t;
  t = Buffer.from(t).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
  return `${t}…`;
}
