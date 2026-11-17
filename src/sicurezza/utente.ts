// L'unico utente di Jarvis (Luigi): password + codice a 6 cifre dell'app di autenticazione.
import type { Db } from "../db.js";
import type { Cifratore } from "./cifra.js";
import { hashPassword, verificaPassword } from "./password.js";
import { nuovoSegretoTotp, verificaTotp } from "./totp.js";

interface RigaUtente { nome: string; password_hash: string; totp_segreto: string; totp_ultimo_passo: number }

export function utenteEsiste(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM utente WHERE id = 1").get();
}

/** Crea (o sostituisce) l'utente. Restituisce il segreto TOTP da inserire nell'app di autenticazione. */
export function creaUtente(db: Db, cifratore: Cifratore, nome: string, password: string, segreto = nuovoSegretoTotp()): string {
  const hash = hashPassword(password);
  db.prepare(`INSERT INTO utente (id, nome, password_hash, totp_segreto, totp_ultimo_passo, creato) VALUES (1,?,?,?,0,?)
    ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, password_hash = excluded.password_hash,
      totp_segreto = excluded.totp_segreto, totp_ultimo_passo = 0`)
    .run(nome, hash, cifratore.cifra(segreto), new Date().toISOString());
  return segreto;
}

export function nomeUtente(db: Db): string {
  const r = db.prepare("SELECT nome FROM utente WHERE id = 1").get() as { nome: string } | undefined;
  return r?.nome || "Luigi";
}

/** true solo se password e codice sono giusti e il codice non è già stato usato. */
export function verificaAccesso(db: Db, cifratore: Cifratore, password: string, codice: string, ora = Date.now()): boolean {
  const u = db.prepare("SELECT nome, password_hash, totp_segreto, totp_ultimo_passo FROM utente WHERE id = 1").get() as RigaUtente | undefined;
  if (!u) return false;
  const passwordOk = verificaPassword(password, u.password_hash);
  const passo = verificaTotp(cifratore.decifra(u.totp_segreto), codice, u.totp_ultimo_passo, ora);
  if (!passwordOk || passo === null) return false;
  db.prepare("UPDATE utente SET totp_ultimo_passo = ? WHERE id = 1").run(passo);
  return true;
}
