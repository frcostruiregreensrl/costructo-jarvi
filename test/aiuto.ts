// Strumenti comuni ai test: database temporaneo, utente finto, server su una porta libera.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { apriDb, type Db } from "../src/db.js";
import { creaCifratore, chiaveDaFrase } from "../src/sicurezza/cifra.js";
import { creaUtente } from "../src/sicurezza/utente.js";
import { codiceTotp, passoAttuale } from "../src/sicurezza/totp.js";
import { leggiConfig } from "../src/config.js";
import { creaApp, type OpzioniApp } from "../src/app.js";

export const PASSWORD = "password-di-prova-123";
export const SEGRETO = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const cifratore = creaCifratore(chiaveDaFrase("solo-per-i-test"));

export function dbProvvisorio(): { db: Db; chiudi: () => void } {
  const cartella = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const db = apriDb(join(cartella, "prova.db"));
  return { db, chiudi: () => { db.close(); rmSync(cartella, { recursive: true, force: true }); } };
}

export interface Ambiente {
  db: Db; base: string; origine: string; chiudi: () => Promise<void>;
  /** fetch con Origin giusto e cookie di sessione (dopo accedi()). */
  chiama: (percorso: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  accedi: () => Promise<void>;
  cookie: string;
}

export async function avviaAmbiente(extra: Partial<OpzioniApp> = {}): Promise<Ambiente> {
  const { db, chiudi: chiudiDb } = dbProvvisorio();
  creaUtente(db, cifratore, "Luigi", PASSWORD, SEGRETO);
  // porta 0: la sceglie il sistema; l'origine ammessa la fissiamo dopo l'avvio.
  const config = leggiConfig({ JARVIS_ORIGINE: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
  const app = creaApp({ config, db, cifratore, ...extra });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const porta = (server.address() as AddressInfo).port;
  const origine = `http://127.0.0.1:${porta}`;
  config.origineAmmessa.splice(0, config.origineAmmessa.length, origine);
  const amb: Ambiente = {
    db, base: origine, origine, cookie: "",
    chiama: (percorso, init = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("Origin") && init.method && init.method !== "GET") headers.set("Origin", origine);
      if (amb.cookie) headers.set("Cookie", amb.cookie);
      let body = init.body;
      if (init.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(init.json); }
      return fetch(origine + percorso, { ...init, headers, body });
    },
    accedi: async () => {
      const r = await amb.chiama("/api/accesso", { method: "POST", json: { password: PASSWORD, codice: codiceTotp(SEGRETO, passoAttuale()) } });
      if (r.status !== 200) throw new Error(`accesso fallito: ${r.status}`);
      amb.cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    },
    chiudi: async () => { await new Promise((r) => server.close(r)); chiudiDb(); },
  };
  return amb;
}

/** Legge uno stream SSE di /api/chiedi e restituisce gli eventi. */
export async function leggiEventi(r: Response): Promise<Array<Record<string, unknown>>> {
  const testo = await r.text();
  return testo.split("\n\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)));
}
export const testoDetto = (ev: Array<Record<string, unknown>>) => ev.filter((e) => e.tipo === "delta").map((e) => e.testo).join("");
