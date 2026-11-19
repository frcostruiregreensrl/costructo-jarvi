# Fase 3, parte 2 — WhatsApp con 360dialog

## Autorizzazione di Luigi

**19/11/2026**: «Autorizzo il 19/11/2026 lo sviluppo dell'adattamento di Jarvis a 360dialog (WhatsApp parte 2), con commit,
push del ramo e apertura della PR, senza merge.» Ramo: `fase3c/360dialog` (nato da `main`, 85a452a).

Esclusi: merge, deploy, Railway, database di produzione, installazione di pacchetti, **qualunque chiamata vera** a 360dialog
o a Meta (l'account non esiste ancora). Tutto è provato con un 360dialog finto (`test/d360Finto.ts`) e un Meta finto.

## Perché 360dialog

Per usare la «coesistenza» (Luigi continua a scrivere dall'app WhatsApp Business sul telefono e Jarvis riceve una copia)
serve un fornitore partner di Meta. Luigi ha scelto **360dialog** (piano Regular). I messaggi hanno lo stesso formato di
Meta; cambiano l'indirizzo, la chiave e il modo di controllare chi manda i messaggi a Jarvis.

## Cosa cambia

| Cosa | Prima (parte 1) | Ora (parte 2) |
|---|---|---|
| Fornitore | «Meta» o «fornitore» generico | **Meta diretto** o **360dialog**, scelto in Impostazioni (un vecchio «fornitore» si legge come 360dialog; il **nome dell'intestazione** scelto nella parte 1 non si usa più: con 360dialog vale sempre `D360-API-KEY`) |
| Controllo dei messaggi in arrivo | sempre la firma di Meta | **Meta**: firma `X-Hub-Signature-256` obbligatoria. **360dialog**: SOLO l'intestazione segreta `X-Jarvis-Segreto` (360dialog non firma con un segreto nostro; un'eventuale firma di Meta si ignora). Cambiando fornitore si cancellano segreto dell'app e parola di verifica di Meta |
| Segreto del webhook (360dialog) | — | Lo genera Jarvis (32 byte casuali), lo salva cifrato e lo scrive **lui** su 360dialog: Luigi non lo vede mai |
| Invio | `{indirizzo}/{id}/messages` con un'intestazione a scelta | `https://waba-v2.360dialog.io/messages` con `D360-API-KEY` (senza id del numero) |
| Allegati | tramite il fornitore, qualunque url | solo url di Meta (si chiede lo stesso percorso a 360dialog) o di 360dialog; tutto il resto rifiutato |
| Pulsanti nuovi | — | «Configura il webhook su 360dialog», «Prova collegamento», «Sincronizza chat (una volta)» |
| Stato del collegamento | — | eventi di Meta (scollegato / ricollegato) con notifica; promemoria dei 14 giorni nel briefing (conta solo quello che Luigi scrive dal telefono) |
| Costi | — | contatore dei messaggi mandati da Jarvis, stima in euro, **tetto mensile** (di serie 900) |
| Velocità | — | al massimo 20 messaggi al secondo |
| Errore 131060 | messaggio generico | spiegazione gentile, nessun nuovo tentativo, la risposta si chiude (niente «manda di nuovo») e il messaggio esce dal tetto del mese |

## Passi per Luigi (da fare con calma, ognuno con il suo ok)

1. **Copia di sicurezza delle chat** sul telefono (WhatsApp → Impostazioni → Chat → Backup delle chat).
2. **Passa il numero all'app WhatsApp Business** (gratuita), versione **2.24.17 o più recente**. Usala per circa **7 giorni**
   prima di collegarla (Meta lo chiede per i numeri nuovi sull'app).
3. **Account Meta Business** per **FR Costruire Green SRL** (business.facebook.com), con la **verifica in due passaggi** attiva.
4. **Registrati su 360dialog** (piano Regular: ha un canone mensile, da approvare prima) e scegli
   «**collega l'app WhatsApp Business esistente**». Sul telefono arriva un messaggio: premi **Connetti** e conferma la
   condivisione delle chat.
5. Su 360dialog crea la **chiave API** del numero. **Entro 24 ore** torna in Jarvis → Impostazioni → WhatsApp:
   scegli «Tramite 360dialog», incolla la chiave, premi **Salva**.
6. Premi **Configura il webhook su 360dialog**: Jarvis scrive su 360dialog il suo indirizzo
   (`JARVIS_ORIGINE` + `/api/whatsapp/webhook`, che deve essere https, senza «_» e senza porta) e l'intestazione segreta.
7. Premi **Prova collegamento**, poi **Sincronizza chat (una volta)**: contatti e storico arrivano a Jarvis.
   Si fa **una volta sola**; dopo un esito positivo il pulsante si spegne.
8. Prova con un numero di prova di Luigi: un messaggio ricevuto, una risposta confermata, nessuna «spunta blu».
9. Da allora: apri WhatsApp Business sul telefono **almeno ogni 14 giorni**, altrimenti Meta scollega Jarvis.
   Jarvis lo ricorda nel briefing se da 12 giorni non arriva nessun messaggio **scritto da Luigi** dal telefono (i messaggi dei
   contatti non contano: arrivano anche se l'app resta chiusa). Con Meta diretto il promemoria c'è solo se la «Prova collegamento»
   ha visto la coesistenza (o se arrivano messaggi scritti dal telefono).

Da sapere: i messaggi scritti da **WhatsApp per Windows** o dallo **smartwatch** non arrivano a Jarvis (limite di Meta).

## Costi

- **360dialog**: canone mensile del piano Regular (lo paga Luigi a 360dialog; Jarvis non lo vede).
- **Modelli di Meta** (promemoria dopo le 24 ore, spenti di serie): si pagano **sempre**, fuori dalle 1.000 risposte gratuite.
  Prezzo stimato di serie 0,03 € l'uno (da verificare sul listino di Meta; si cambia in Impostazioni).
- **Meta**: da ottobre 2026 anche le risposte dentro le 24 ore si pagano **oltre le prime 1.000 del mese** per numero.
  Jarvis conta i messaggi che manda **lui** con la API (risposte che Luigi conferma, conferme automatiche, modelli) e mostra in
  «Spesa del mese» una **stima**: (risposte + conferme − 1.000) × 0,0248 € + modelli × 0,03 € (prezzi modificabili).
  Un messaggio con errore 131060 si toglie dal conto; uno con esito incerto resta contato.
- **Tetto mensile** dei messaggi di Jarvis: di serie **900**, così si resta nei 1.000 gratuiti. Al tetto Jarvis non manda più
  niente da solo e lo dice; Luigi può alzarlo in Impostazioni → WhatsApp.
- **Le risposte che Luigi scrive dal telefono sono gratis**, non si contano e non sono mai bloccate.

## API nuove (con accesso, controllo Origin, JSON e registro)

| Rotta | Cosa fa |
|---|---|
| `PUT /api/whatsapp/collegamento` | ora con `provider: "360dialog"`, `baseUrl` (di serie `https://waba-v2.360dialog.io`), `token` (chiave API), `percorsoSalute`, `percorsoSync` |
| `GET /api/whatsapp/collegamento` | in più: `controlloWebhook`, `segretoWebhookImpostato` (mai il valore), `webhookConfigurato`, `connessione`, `sync`, `invii` |
| `POST /api/whatsapp/360dialog/webhook` | configura il webhook su 360dialog (`POST {indirizzo}/v1/configs/webhook`) |
| `POST /api/whatsapp/prova` | prova del collegamento; non si blocca mai, spiega l'esito |
| `POST /api/whatsapp/sincronizza {conferma: true}` | sincronizzazione una volta sola (409 se già fatta) |
| `GET /api/spesa` | in più `whatsapp`: messaggi del mese per tipo, tetto, soglia gratuita, prezzo, stima |

## Da verificare al primo uso vero [non verificato]

La documentazione di 360dialog era leggibile solo tramite riassunti di terzi. Questi punti sono scritti come la si è capita,
sono **configurabili** e vanno controllati con l'account vero:

1. Indirizzo di base `https://waba-v2.360dialog.io` (alcuni documenti vecchi dicono `waba.360dialog.io`): si cambia nel campo «Indirizzo di 360dialog».
2. `POST /v1/configs/webhook` con `{"url", "headers"}` e che 360dialog rimandi davvero l'intestazione `X-Jarvis-Segreto` in ogni webhook
   (se non la rimanda, tutti i messaggi vengono rifiutati con 401: si vede nel registro «intestazione segreta mancante»).
3. Regole dell'indirizzo del webhook (niente «_», niente porta): Jarvis le applica comunque.
4. Allegati: `GET {indirizzo}/{id del media}` e poi lo stesso percorso del file di Meta sull'indirizzo di 360dialog.
5. Prova di collegamento: `GET {indirizzo}/health_status` (campo «Percorso della prova»). Se 360dialog non la offre, Jarvis lo dice e basta.
6. Sincronizzazione: `POST {indirizzo}/smb_app_data` con `sync_type` `smb_app_state_sync` e poi `history` (campo «Percorso della sincronizzazione»).
7. Formato degli eventi `account_update` (`PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`) che passano da 360dialog.
8. Che il conteggio dei 1.000 messaggi gratuiti e il prezzo di 0,0248 € valgano così per Luigi (è una stima).

## Codice e test

Nuovi: `src/whatsapp/fornitore.ts` (webhook su 360dialog, prova, sincronizzazione), `src/whatsapp/connessione.ts` (stato,
eventi, 14 giorni, stato della sincronizzazione), `src/whatsapp/contatore.ts` (contatore, tetto, 20 al secondo).
Modificati: collegamento, tipi, webhook, invio, media, elabora, servizio, risposte, rispostaAuto, rotteWhatsapp, rotteFunzioni,
briefing, impostazioni, db (tabella `wa_invii_api`), app; interfaccia in `public/` (cache `jarvis-v6`).
Test: `test/360dialog.test.ts` (16 test) con `test/d360Finto.ts`.

| Prova | Esito |
|---|---|
| `npm test` | **203/203** (182 di prima + 21 nuovi, di cui 5 dopo la revisione; altri controlli aggiunti a test esistenti) |
| `npx tsc --noEmit` | nessun errore |
| `npm run build` | funziona |
| `node script/prova-interfaccia.mjs` (390/1280 px, chiaro/scuro) | **97/97** (cache `jarvis-v7`) |

Nota: un test di prima (`aziende.test.ts`, ora del primo impegno) dipendeva dall'orologio (falliva prima delle 10 e tra le 23
e mezzanotte): ora usa un orologio fisso.

## Segreto del webhook: come cambia (dopo la revisione)

- «Configura il webhook» parte **una volta alla volta** (un secondo clic aspetta).
- 360dialog **conferma** → vale solo il segreto nuovo: quello vecchio si cancella subito.
- 360dialog **rifiuta** → si torna esattamente a prima.
- **Esito incerto** (tempo scaduto, errore 5xx) → valgono il nuovo e fino a **2** segreti vecchi, ognuno per **un'ora**: anche due
  tentativi incerti di fila non bloccano i messaggi, qualunque segreto abbia preso 360dialog. Poi si ripreme «Configura».
- Ogni scrittura è «solo se niente è cambiato nel frattempo»: un «Salva» fatto mentre 360dialog risponde non viene annullato, e
  se nel frattempo si è passati a Meta il segreto di 360dialog non viene scritto.

## Installazioni della parte 1

- Un collegamento salvato nella parte 1 («fornitore», con un nome d'intestazione a scelta) si legge come 360dialog con
  `D360-API-KEY`; il nome d'intestazione vecchio si perde. Il webhook resta spento finché non si preme «Configura il webhook».
- La scheda del collegamento (stato, 14 giorni, sincronizzazione) si crea da sola (al primo evento, al giro di ogni minuto o al
  primo Salva) senza azzerare una sincronizzazione già fatta. Si riparte da capo solo cambiando fornitore o numero.

## Altre regole dopo la revisione

- Le risposte di Meta e di 360dialog si leggono al massimo per 64 KB, gli allegati al massimo per la dimensione ammessa, a pezzi:
  oltre il limite la lettura si ferma (anche se il server non dice quanto è grande).
- Id degli allegati: solo lettere, cifre, «_», «-» e punti singoli (niente «..», niente «/»).
- Promemoria con modello bloccato dal tetto: non parte niente e il promemoria preparato resta valido.

## Rischi e punti aperti

- **Mai provato con 360dialog vero**: vedi l'elenco qui sopra.
- La sicurezza del webhook con 360dialog dipende dal segreto dell'intestazione: se 360dialog lo mostra a qualcuno o lo perde,
  basta premere di nuovo «Configura il webhook» (segreto nuovo; il vecchio vale ancora un'ora, poi mai più).
- Il tetto conta solo i messaggi di Jarvis: se altri strumenti usano lo stesso numero con la API, Meta li conta insieme.
- Esito incerto (tempo scaduto, errore 5xx): il messaggio resta contato, per prudenza.
- La finestra delle 24 ore per la sincronizzazione parte da quando Luigi salva la chiave in Jarvis: Jarvis non conosce
  l'ora esatta del collegamento fatto sul telefono, quindi avvisa ma non blocca.
- Un secondo numero (seconda azienda) non è previsto: una chiave di 360dialog vale per un numero.
