// Testo che Luigi conferma = testo che parte. Prima di MOSTRARE e prima di MANDARE si usa la stessa stringa,
// ripulita dai caratteri invisibili che potrebbero nascondere o rovesciare una parte del testo
// (controllo del verso di scrittura «bidi», caratteri a larghezza zero, caratteri di controllo).
// La conferma è legata all'impronta (SHA-256) di destinatario + testo: se cambia anche solo una lettera, non vale più.
import { createHash, timingSafeEqual } from "node:crypto";

const INVISIBILI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** Toglie i caratteri invisibili o di controllo (resta l'a capo); niente file di spazi o di righe vuote che spingano il testo fuori vista. */
export function pulisciTestoConfermato(testo: string): string {
  return String(testo ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(INVISIBILI, "")
    .replace(/[ \u00a0\u2000-\u200a\u3000]{2,}/g, " ").replace(/[ ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** «[da completare]» rimasto nel testo: non si manda (e non si mette nelle bozze dalla chat). */
export const DA_COMPLETARE = /\[\s*da\s+completare\s*\]/i;

/** Impronta di destinatario + testo esatto. */
export function improntaConferma(destinatario: string, testo: string): string {
  return createHash("sha256").update(`${destinatario}\n${testo}`).digest("hex");
}

export function stessaImpronta(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
