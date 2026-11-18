// Avvio del servizio Jarvis.
import { leggiConfig } from "./config.js";
import { apriDb } from "./db.js";
import { creaCifratore } from "./sicurezza/cifra.js";
import { creaApp, type ServiziApp } from "./app.js";
import { pulisciPostaVecchia } from "./posta/archivio.js";
import { pulisciWhatsappVecchio } from "./whatsapp/archivio.js";
import { leggiApple, eventiApple } from "./calendarioApple.js";
import { pulisciConversazioniVecchie } from "./conversazioni.js";
import { creaInvio, controllaOraBriefing } from "./push.js";
import { creaBriefing, notificheDelMattino } from "./briefing.js";
import { aziendeCollegate } from "./aziende.js";
import { leggiSegreto } from "./impostazioni.js";
import { registra, pulisciRegistroVecchio } from "./registro.js";
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
  const righe = pulisciRegistroVecchio(db);
  if (righe) registra(db, "registro.pulizia", "fatto", "sistema", { righeAlleggerite: righe });
  // Fase 2: i dati delle mail (testo breve, riassunti, bozze) si cancellano dopo 30 giorni.
  const mail = pulisciPostaVecchia(db);
  if (mail) registra(db, "posta.pulizia", "fatto", "sistema", { mailCancellate: mail });
  // Fase 3: i messaggi WhatsApp (testo breve, riassunti, risposte, domande) si cancellano dopo 30 giorni.
  const wa = pulisciWhatsappVecchio(db);
  if (wa) registra(db, "whatsapp.pulizia", "fatto", "sistema", { messaggiCancellati: wa });
}
pulizia();
setInterval(pulizia, 6 * 3600_000).unref();

setInterval(() => {
  controllaOraBriefing(db, config.fusoOrario, async () => {
    // Una notifica per ogni azienda collegata (con una sola azienda: una notifica, come prima).
    const aziende = aziendeCollegate({ db, cifratore, urlAmbiente: config.costructoUrl, tokenAmbiente: config.costructoToken });
    const servizi = app.locals.servizi as ServiziApp;
    const calendarioApple = leggiApple(servizi.apple) ? (da: number, a: number) => eventiApple(servizi.apple, da, a, config.fusoOrario) : undefined;
    const b = await creaBriefing({ db, fuso: config.fusoOrario, aziende, linkCalendario: leggiSegreto(db, cifratore, "calendario_ical"), calendarioApple });
    return notificheDelMattino(b);
  }, invia).catch((e) => registra(db, "notifica.briefing", "errore", "sistema", { messaggio: String(e?.message || e) }));
}, 60_000).unref();

// Fase 2: giro della posta ogni 5 minuti (lettura in sola lettura, riassunti, conferme ammesse, notifiche urgenti).
(app.locals.servizi as ServiziApp).posta.avvia();
// Fase 3: giro di WhatsApp ogni minuto (classificazione dopo 2 minuti di silenzio del contatto, domande, conferme, notifiche).
(app.locals.servizi as ServiziApp).whatsapp.avvia();

app.listen(config.porta, config.host, () => {
  console.log(`Jarvis è attivo su http://${config.host}:${config.porta}`);
  if (!utenteEsiste(db)) console.log("Nessun utente: crealo con  npm run crea-utente");
});
