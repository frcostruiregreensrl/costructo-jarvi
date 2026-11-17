// Avvio del servizio Jarvis.
import { leggiConfig } from "./config.js";
import { apriDb } from "./db.js";
import { creaCifratore } from "./sicurezza/cifra.js";
import { creaApp } from "./app.js";
import { pulisciConversazioniVecchie } from "./conversazioni.js";
import { creaInvio, controllaOraBriefing } from "./push.js";
import { creaBriefing, testoNotifica } from "./briefing.js";
import { creaClientCostructo } from "./costructo.js";
import { leggiSegreto } from "./impostazioni.js";
import { registra } from "./registro.js";
import { utenteEsiste } from "./sicurezza/utente.js";

const config = leggiConfig();
if (config.produzione && !config.origineAmmessa.every((o) => o.startsWith("https://"))) {
  console.error("In produzione JARVIS_ORIGINE deve contenere solo indirizzi https.");
  process.exit(1);
}
if (config.produzione && !config.fidatiProxy) {
  console.warn(
    "ATTENZIONE: JARVIS_PROXY non è impostato. Su Railway tutte le richieste arrivano dal proxy e sembrano venire " +
    "dallo stesso indirizzo: il limite di tentativi per IP varrebbe per tutti insieme. Imposta JARVIS_PROXY=1 " +
    "(il server si fiderà di un solo proxy, quello di Railway).",
  );
}
const cifratore = creaCifratore(config.chiaveCifratura);
const db = apriDb(config.fileDb);
const invia = creaInvio({ pubblica: config.vapidPubblica, privata: config.vapidPrivata, contatto: config.vapidContatto });
const app = creaApp({ config, db, cifratore, invia });

function pulizia() {
  const tolti = pulisciConversazioniVecchie(db);
  if (tolti) registra(db, "conversazioni.pulizia", "fatto", "sistema", { messaggiCancellati: tolti });
}
pulizia();
setInterval(pulizia, 6 * 3600_000).unref();

setInterval(() => {
  controllaOraBriefing(db, config.fusoOrario, async () => {
    const url = leggiSegreto(db, cifratore, "costructo_url") || config.costructoUrl;
    const token = leggiSegreto(db, cifratore, "costructo_token") || config.costructoToken;
    const b = await creaBriefing({ db, fuso: config.fusoOrario, costructo: url && token ? creaClientCostructo({ url, token }) : null, linkCalendario: leggiSegreto(db, cifratore, "calendario_ical") });
    return testoNotifica(b);
  }, invia).catch((e) => registra(db, "notifica.briefing", "errore", "sistema", { messaggio: String(e?.message || e) }));
}, 60_000).unref();

app.listen(config.porta, config.host, () => {
  console.log(`Jarvis è attivo su http://${config.host}:${config.porta}`);
  if (!utenteEsiste(db)) console.log("Nessun utente: crealo con  npm run crea-utente");
});
