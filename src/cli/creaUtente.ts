// Crea (o reimposta) l'utente di Jarvis. Uso: npm run crea-utente
// Chiede nome e password, poi stampa il codice da inserire nell'app di autenticazione (TOTP).
import { createInterface } from "node:readline/promises";
import { leggiConfig } from "../config.js";
import { apriDb } from "../db.js";
import { creaCifratore } from "../sicurezza/cifra.js";
import { creaUtente } from "../sicurezza/utente.js";
import { uriOtpauth } from "../sicurezza/totp.js";
import { chiudiTutteLeSessioni } from "../sicurezza/sessioni.js";

const config = leggiConfig();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const nome = (await rl.question("Nome (es. Luigi): ")).trim() || "Luigi";
const password = await rl.question("Password (almeno 12 caratteri): ");
rl.close();
const db = apriDb(config.fileDb);
const segreto = creaUtente(db, creaCifratore(config.chiaveCifratura), nome, password);
chiudiTutteLeSessioni(db);
console.log("\nUtente pronto. Nell'app di autenticazione (es. Password di iPhone, Google Authenticator) aggiungi:");
console.log(`  codice: ${segreto}`);
console.log(`  oppure il link: ${uriOtpauth(segreto, nome)}`);
console.log("Tutte le sessioni aperte sono state chiuse.");
