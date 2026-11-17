// Server di PROVA per l'interfaccia: database temporaneo, utente finto, cervello finto, Costructo finto.
// Nessun dato reale, nessuna chiave reale, nessuna chiamata a servizi esterni.
// Uso: npx tsx script/server-prova.ts  → stampa una riga JSON con indirizzo, password e segreto TOTP finti.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { apriDb } from "../src/db.js";
import { creaCifratore, chiaveDaFrase } from "../src/sicurezza/cifra.js";
import { creaUtente } from "../src/sicurezza/utente.js";
import { leggiConfig } from "../src/config.js";
import { creaApp } from "../src/app.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { aggiungiMemoria } from "../src/memorie.js";
import { aggiungiImpegno } from "../src/agenda.js";
import { salvaSegreto, salvaImpostazioni } from "../src/impostazioni.js";
import { registraConsumo } from "../src/consumi.js";
import { dataIso } from "../src/tempo.js";

const PASSWORD = "password-finta-di-prova";
const SEGRETO = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const cartella = mkdtempSync(join(tmpdir(), "jarvis-ui-"));
const db = apriDb(join(cartella, "prova.db"));
const cifratore = creaCifratore(chiaveDaFrase("prova-interfaccia"));
creaUtente(db, cifratore, "Luigi", PASSWORD, SEGRETO);

// Costructo finto
const costructo = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer csa_prova_interfaccia_123") { res.writeHead(401).end("{}"); return; }
  const p = new URL(req.url || "/", "http://x").pathname;
  const dati: Record<string, unknown> = {
    "/api/assistente/v1/briefing": {
      impegni: [{ titolo: "Sopralluogo cantiere Villa Rosa (finto)", inizio: new Date(Date.now() + 2 * 3600_000).toISOString() }],
      cantieri: [{ nome: "Villa Rosa (finto)" }, { nome: "Scuola media (finta)" }, { nome: "Capannone Est (finto)" }],
      scadenze: [{ titolo: "F24 di fine mese (finto)", scadenza: "30/11" }],
      documentiInScadenza: [{ titolo: "DURC impresa (finto)", scadenza: "25/11" }],
      fattureDaIncassare: [{ cliente: "Cliente Prova Srl", residuo: 4200 }],
    },
    "/api/assistente/v1/io": { utente: { nome: "Luigi (finto)" } },
  };
  res.writeHead(dati[p] ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(dati[p] ?? {}));
});
costructo.listen(0, "127.0.0.1");
await new Promise((r) => costructo.once("listening", r));
salvaSegreto(db, cifratore, "costructo_url", `http://127.0.0.1:${(costructo.address() as AddressInfo).port}`);
salvaSegreto(db, cifratore, "costructo_token", "csa_prova_interfaccia_123");

// Dati finti
const oggi = dataIso(Date.now(), "Europe/Rome");
const domani = dataIso(Date.now() + 864e5, "Europe/Rome");
aggiungiImpegno(db, { titolo: "Palestra", data: oggi, ora: "23:30" }, "Europe/Rome");
aggiungiImpegno(db, { titolo: "Cena con Anna", data: domani, ora: "20:30" }, "Europe/Rome");
aggiungiMemoria(db, "privato", "Luigi preferisce il caffè senza zucchero", "luigi");
aggiungiMemoria(db, "privato", "Il compleanno di Anna è il 3 maggio", "jarvis");
aggiungiMemoria(db, "lavoro", "Per i ponteggi il fornitore preferito è Ponteggi Prova", "jarvis");
registraConsumo(db, "claude-haiku-5-5", { ingresso: 120_000, uscita: 18_000, cacheLettura: 300_000, cacheScrittura: 4000 }, "Europe/Rome");
registraConsumo(db, "claude-sonnet-5-5", { ingresso: 30_000, uscita: 6000, cacheLettura: 0, cacheScrittura: 0 }, "Europe/Rome");
salvaImpostazioni(db, { tettoMensileUsd: 5, comeChiamarmi: "Luigi" });

const cervello = creaCervelloFinto((r) => {
  const ultimo = r.messaggi[r.messaggi.length - 1];
  if (ultimo.ruolo === "risultati") return { testo: "Ti chiedo conferma prima di farlo." };
  const t = ultimo.ruolo === "utente" ? ultimo.testo : "";
  if (/briefing alle/i.test(t)) return { chiamate: [{ id: "p1", nome: "ricordo_salva", input: { testo: "Luigi vuole il briefing alle 6:45", spazio: "privato" } }] };
  return { testo: "Oggi hai il sopralluogo a Villa Rosa alle undici, poi la palestra in serata. Il DURC scade tra pochi giorni: ti conviene rinnovarlo questa settimana." };
});

const config = leggiConfig({ JARVIS_ORIGINE: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
const app = creaApp({ config, db, cifratore, cervello: async () => cervello });
const server = app.listen(Number(process.env.PORTA_PROVA) || 0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const porta = (server.address() as AddressInfo).port;
config.origineAmmessa.splice(0, config.origineAmmessa.length, `http://127.0.0.1:${porta}`);
console.log(JSON.stringify({ indirizzo: `http://127.0.0.1:${porta}`, password: PASSWORD, segreto: SEGRETO }));

const chiudi = () => { server.close(); costructo.close(); db.close(); rmSync(cartella, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", chiudi);
process.on("SIGINT", chiudi);
