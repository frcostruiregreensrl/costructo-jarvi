// Sessioni con cookie httpOnly / secure / SameSite=Strict. Nel database c'è solo l'hash del token.
import { randomBytes, createHash } from "node:crypto";
import type { Db } from "../db.js";

export const DURATA_SESSIONE_MS = 30 * 24 * 3600_000; // 30 giorni
export const INATTIVITA_MAX_MS = 14 * 24 * 3600_000;  // 14 giorni senza uso: si esce

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function creaSessione(db: Db, dispositivo: string, ora = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessioni (id, creata, scade, ultimo_uso, dispositivo) VALUES (?,?,?,?,?)")
    .run(hashToken(token), ora, ora + DURATA_SESSIONE_MS, ora, dispositivo.slice(0, 160));
  return token;
}

export function sessioneValida(db: Db, token: string | undefined, ora = Date.now()): boolean {
  if (!token || token.length > 100) return false;
  const id = hashToken(token);
  const s = db.prepare("SELECT scade, ultimo_uso FROM sessioni WHERE id = ?").get(id) as { scade: number; ultimo_uso: number } | undefined;
  if (!s) return false;
  if (s.scade < ora || ora - s.ultimo_uso > INATTIVITA_MAX_MS) {
    db.prepare("DELETE FROM sessioni WHERE id = ?").run(id);
    return false;
  }
  if (ora - s.ultimo_uso > 60_000) db.prepare("UPDATE sessioni SET ultimo_uso = ? WHERE id = ?").run(ora, id);
  return true;
}

export function chiudiSessione(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessioni WHERE id = ?").run(hashToken(token));
}

export function chiudiTutteLeSessioni(db: Db): void {
  db.prepare("DELETE FROM sessioni").run();
}

export function nomeCookie(produzione: boolean): string {
  // Il prefisso __Host- obbliga il browser a usare https, path=/ e nessun dominio.
  return produzione ? "__Host-jarvis" : "jarvis_sessione";
}

export function intestazioneCookie(nome: string, valore: string, produzione: boolean, maxAgeSec: number): string {
  const parti = [`${nome}=${valore}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (produzione) parti.push("Secure");
  return parti.join("; ");
}

export function leggiCookie(header: string | undefined, nome: string): string | undefined {
  if (!header) return undefined;
  for (const parte of header.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return undefined;
}
