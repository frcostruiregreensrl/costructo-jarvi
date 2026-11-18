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
import { aggiungiAzienda } from "../src/aziende.js";
import { registraConsumo } from "../src/consumi.js";
import { dataIso } from "../src/tempo.js";
import { aggiungiCasella } from "../src/posta/caselle.js";
import type { ServiziApp } from "../src/app.js";
import { ImapFinto, uscitaFinta } from "../test/postaFinta.js";

const PASSWORD = "password-finta-di-prova";
const SEGRETO = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const cartella = mkdtempSync(join(tmpdir(), "jarvis-ui-"));
const db = apriDb(join(cartella, "prova.db"));
const cifratore = creaCifratore(chiaveDaFrase("prova-interfaccia"));
creaUtente(db, cifratore, "Luigi", PASSWORD, SEGRETO);

// Costructo finto: due token = due aziende finte, ognuna con i suoi dati.
const AZIENDE: Record<string, { azienda: { id: number; nome: string }; briefing: unknown }> = {
  "Bearer csa_prova_interfaccia_123": {
    azienda: { id: 1, nome: "Impresa Prova (finta)" },
    briefing: {
      impegni: [{ titolo: "Sopralluogo cantiere Villa Rosa (finto)", inizio: new Date(Date.now() + 2 * 3600_000).toISOString() }],
      cantieri: [{ nome: "Villa Rosa (finto)" }, { nome: "Scuola media (finta)" }, { nome: "Capannone Est (finto)" }],
      scadenze: [{ titolo: "F24 di fine mese (finto)", scadenza: "30/11" }],
      documentiInScadenza: [{ titolo: "DURC impresa (finto)", scadenza: "25/11" }],
      fattureDaIncassare: [{ cliente: "Cliente Prova Srl", residuo: 4200 }],
    },
  },
  "Bearer csa_prova_seconda_456": {
    azienda: { id: 2, nome: "Seconda Impresa (finta)" },
    briefing: { cantieri: [{ nome: "Condominio Verde (finto)" }], fattureDaIncassare: [{ cliente: "Altro Cliente Srl", residuo: 1800 }] },
  },
};
const costructo = createServer((req, res) => {
  const a = AZIENDE[String(req.headers.authorization)];
  if (!a) { res.writeHead(401).end("{}"); return; }
  const p = new URL(req.url || "/", "http://x").pathname;
  const dati: Record<string, unknown> = {
    "/api/assistente/v1/briefing": a.briefing,
    "/api/assistente/v1/io": { versione: 1, token: { id: 1, etichetta: "Jarvis (finto)" }, azienda: a.azienda },
  };
  res.writeHead(dati[p] ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(dati[p] ?? {}));
});
costructo.listen(0, "127.0.0.1");
await new Promise((r) => costructo.once("listening", r));
salvaSegreto(db, cifratore, "costructo_url", `http://127.0.0.1:${(costructo.address() as AddressInfo).port}`);
const fonte = { db, cifratore, urlAmbiente: "", tokenAmbiente: "" };
const prima = await aggiungiAzienda(fonte, { token: "csa_prova_interfaccia_123" });
const seconda = await aggiungiAzienda(fonte, { token: "csa_prova_seconda_456" });

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
  // Posta: riassunti (filtro) e bozze, sempre finti.
  if (!r.strumenti.length && /BOZZA/.test(r.sistema)) return { testo: "Buongiorno,\n\nla ringrazio per il messaggio. Le confermo che passeremo in cantiere [da completare].\n\nCordiali saluti" };
  if (!r.strumenti.length && ultimo.ruolo === "utente") {
    const righe = ultimo.testo.split("\n");
    const voci = JSON.parse(righe[righe.findIndex((x) => x.startsWith("<dati_non_attendibili")) + 1]) as Array<{ n: number; oggetto: string }>;
    return { testo: JSON.stringify(voci.map((v) => ({ n: v.n, riassunto: `Riassunto finto: ${v.oggetto}`, urgente: /urgente|ferm/i.test(v.oggetto), motivo: /urgente|ferm/i.test(v.oggetto) ? "serve una risposta oggi (finto)" : "", tocca: /fattura/i.test(v.oggetto) }))) };
  }
  if (ultimo.ruolo === "risultati") return { testo: "Ti chiedo conferma prima di farlo." };
  const t = ultimo.ruolo === "utente" ? ultimo.testo : "";
  if (/briefing alle/i.test(t)) return { chiamate: [{ id: "p1", nome: "ricordo_salva", input: { testo: "Luigi vuole il briefing alle 6:45", spazio: "privato" } }] };
  return { testo: "Oggi hai il sopralluogo a Villa Rosa alle undici, poi la palestra in serata. Il DURC scade tra pochi giorni: ti conviene rinnovarlo questa settimana." };
});

// Posta finta: tre caselle (due aziende e privato) con qualche mail. Nessun server vero.
const imap = new ImapFinto();
const caselleFinte = [
  { utente: "lavoro@prova.example", nome: "Lavoro (finta)", tipo: "gmail" as const, spazio: prima.id },
  { utente: "pec@prova.example", nome: "PEC (finta)", tipo: "pec" as const, spazio: seconda.id },
  { utente: "casa@prova.example", nome: "Personale (finta)", tipo: "gmail" as const, spazio: "privato" },
];
for (const c of caselleFinte) imap.casella(c.utente, "password-finta-1234");

const config = leggiConfig({ JARVIS_ORIGINE: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
const app = creaApp({ config, db, cifratore, cervello: async () => cervello, apriImap: imap.apri, uscita: uscitaFinta() });
const servizi = app.locals.servizi as ServiziApp;
for (const c of caselleFinte) await aggiungiCasella(servizi.posta.dip, { nome: c.nome, tipo: c.tipo, spazio: c.spazio, utente: c.utente, password: "password-finta-1234" });
const ora = Date.now();
imap.arriva("lavoro@prova.example", { oggetto: "Gru ferma in cantiere Villa Rosa (finto)", daNome: "Capocantiere Prova", da: "capo@prova.example", data: new Date(ora - 40 * 60_000), testo: "Buongiorno, la gru è ferma da stamattina: serve il tecnico entro oggi. (testo finto)" });
imap.arriva("lavoro@prova.example", { oggetto: "Fattura n. 12 (finta)", daNome: "Fornitore Prova", da: "amministrazione@prova.example", data: new Date(ora - 3 * 3600_000), testo: "In allegato la fattura di ottobre. (testo finto)" });
imap.arriva("lavoro@prova.example", { oggetto: "Novità del mese (finta)", da: "newsletter@prova.example", data: new Date(ora - 5 * 3600_000), intestazioni: { "List-Unsubscribe": "<mailto:x@prova.example>" } });
imap.arriva("pec@prova.example", { oggetto: "Comunicazione di avvio lavori (finta)", daNome: "Comune di Prova", da: "protocollo@prova.example", data: new Date(ora - 26 * 3600_000), testo: "Si comunica... (testo finto)" });
imap.arriva("casa@prova.example", { oggetto: "Cena di sabato (finta)", daNome: "Anna", da: "anna@prova.example", data: new Date(ora - 2 * 3600_000), testo: "Ci vediamo sabato alle 20? (testo finto)" });
await servizi.posta.controllaOra();
const server = app.listen(Number(process.env.PORTA_PROVA) || 0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const porta = (server.address() as AddressInfo).port;
config.origineAmmessa.splice(0, config.origineAmmessa.length, `http://127.0.0.1:${porta}`);
console.log(JSON.stringify({ indirizzo: `http://127.0.0.1:${porta}`, password: PASSWORD, segreto: SEGRETO }));

const chiudi = () => { server.close(); costructo.close(); db.close(); rmSync(cartella, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", chiudi);
process.on("SIGINT", chiudi);
