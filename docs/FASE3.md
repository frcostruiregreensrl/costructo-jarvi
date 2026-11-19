# Fase 3 — WhatsApp (parte 1, senza collegamento reale)

## Autorizzazione di Luigi

**18/11/2026**: «Autorizzo il 18/11/2026 lo sviluppo della Fase 3 di Jarvis (WhatsApp, parte 1 senza collegamento reale)
in costructo-jarvi, con commit, push del ramo e apertura della PR, senza merge.» Ramo: `fase3/whatsapp` (nato da `main`, c413b7f).

Esclusi: merge, deploy, Railway, database di produzione, **qualunque collegamento vero** a Meta, WhatsApp o fornitori,
installazione di pacchetti (si usano solo `fetch` e `node:crypto`). Tutto è provato con un Meta finto.

## La situazione di Luigi

Un **solo numero WhatsApp** per FR Costruire Green, Edilgreen e la vita privata. Nella parte 2 il numero passa all'app
**WhatsApp Business** e si collega alla **WhatsApp Business Platform (Cloud API)** con la «coesistenza» ufficiale di Meta:
Luigi continua a usare l'app sul telefono, e Jarvis riceve una copia dei messaggi.

## Cosa fa la parte 1 (già pronta, ma spenta finché non c'è il collegamento)

| Cosa | Come |
|---|---|
| **Riceve i messaggi** | Webhook `GET/POST /api/whatsapp/webhook`. Messaggi ricevuti (testo, foto, documenti, audio, video, posizione, contatti, reazioni, risposte a pulsanti), stati dei messaggi mandati da Jarvis (inviato, consegnato, letto, non consegnato), **eco** dei messaggi che Luigi scrive dal telefono (`smb_message_echoes`), **storico** delle chat passate (`history`), **nomi della rubrica** (`smb_app_state_sync`), gruppi. |
| **Salva poco** | Per ogni messaggio: chi, quando, un testo breve (al massimo 4 KB) e, per gli allegati, **solo** tipo, formato, nome del file, didascalia e id. **Nessun allegato viene scaricato.** Tutto si cancella dopo 30 giorni. |
| **Riassume e segnala le urgenze** | Come per la posta: prima un filtro gratuito («ok», «grazie», emoji, gruppi: niente AI), poi Claude Haiku **una chat per richiesta**, con lo stesso tetto di spesa. I messaggi dello stesso contatto a meno di 2 minuti l'uno dall'altro diventano **una sola** richiesta (si aspetta che il contatto smetta di scrivere per 2 minuti). «Parla di soldi o impegni» non scende mai sotto il controllo senza AI (anche didascalie e nomi dei file). Al tetto i messaggi restano senza riassunto. |
| **Di quale azienda è?** | 1) la scelta già fatta da Luigi; 2) il numero tra le controparti di Costructo (clienti e fornitori) di **una sola** azienda; 3) dal contesto l'AI può **proporre**, ma non decide. Se non si sa, o il numero è in più aziende: scheda «Di quale azienda è Mario: FR Costruire Green, Edilgreen o privato?» con i pulsanti nella pagina WhatsApp e una notifica. La risposta si ricorda. |
| **Prepara le risposte** | «Prepara risposta» nella pagina WhatsApp (testo proposto dall'AI, modificabile) oppure a voce. Il messaggio parte **solo** dopo «Invia» e la conferma «Sì, manda» (o «Conferma» nella chat con Jarvis). Solo entro 24 ore dall'ultimo messaggio del contatto; mai nei gruppi. |
| **Fattura mancante** | Se un messaggio parla di un pagamento e non c'è un documento allegato, Jarvis **propone** (da confermare) una risposta che chiede la fattura o il documento. |
| **Conferme automatiche** | Solo se le accendi tu (vedi sotto). |
| **Notifiche** | Messaggio urgente nuovo: «WhatsApp urgente · Edilgreen» con «Mario Rossi: messaggio urgente.» (mai il testo, mai il numero; con «nascondi contenuto» nemmeno il nome). Al massimo una ogni 30 minuti per contatto. |
| **Briefing** | Per ogni azienda le chat senza risposta e quelle urgenti; poi il privato; poi i contatti da assegnare. |

### A voce (strumenti dell'AI)

`whatsapp_recenti` (filtri: contatto, azienda, solo urgenti, giorni), `whatsapp_cerca`, `whatsapp_chat` (ultimi messaggi di un
contatto), `whatsapp_risposta` (sempre con conferma; rifiuta fuori dalle 24 ore), `whatsapp_assegna_azienda` (sempre con conferma).
Scheda **Privato**: solo chat private. **Lavoro**: solo chat delle aziende. **Tutto**: tutte, comprese quelle «Da assegnare».
Ogni risultato dice di quale azienda è; se «Mario» c'è in due aziende Jarvis chiede quale.

## Cosa non fa MAI

- Non manda niente senza il tuo sì esplicito (l'unica eccezione sono le conferme automatiche, se le accendi).
- Non manda le «spunte blu» (non segna mai i messaggi come letti): i messaggi li leggi tu sul telefono.
- Non scrive nei gruppi. Non scarica gli allegati.
- Non manda messaggi liberi dopo 24 ore dall'ultimo messaggio del contatto: lì serve un «modello» approvato da Meta (parte 2).
- Non segue istruzioni scritte dentro i messaggi: per l'AI sono solo dati.
- Non mette numeri di telefono interi nel registro né nelle notifiche (al massimo le ultime 3 cifre nel registro).
- Non decide da solo di quale azienda è un contatto quando non è sicuro: chiede.

## Conferme di ricezione automatiche

**Spente di serie** (Impostazioni → «WhatsApp: conferme automatiche e notifiche»). Accese, partono solo se è tutto vero:

1. WhatsApp è collegato; la chat **non** è un gruppo; il messaggio è arrivato dal vivo (mai dallo storico) ed è stato classificato dall'AI;
2. il contatto è di **un'azienda** (mai ai contatti privati o da assegnare);
3. né l'AI né il controllo senza AI trovano soldi o impegni (testo, didascalie, nomi dei file: stesse parole della posta);
4. Luigi non ha già risposto dal telefono; siamo dentro le 24 ore; il messaggio è arrivato da meno di un'ora;
5. al massimo una per contatto ogni 7 giorni e 20 al giorno.

Testo fisso: «Buongiorno, abbiamo ricevuto il suo messaggio e le risponderemo appena possibile. Questo è un messaggio automatico
di sola conferma di ricezione: non contiene accettazioni o impegni.» Una conferma automatica **non** conta come risposta di Luigi.

## Parte 2 — come si collega davvero (passo per passo, da fare con Luigi)

> **Aggiornamento 19/11/2026**: Luigi ha scelto **360dialog**. L'adattamento è descritto in [FASE3-PARTE2.md](FASE3-PARTE2.md)
> (passi aggiornati, controllo del webhook con l'intestazione segreta, sincronizzazione una volta sola, costi e tetto dei messaggi).
> I passi qui sotto restano validi per il collegamento diretto con Meta.

Ogni passo che costa o tocca account veri va **approvato da Luigi prima**.

1. **Copia di sicurezza delle chat** sul telefono (WhatsApp → Impostazioni → Chat → Backup delle chat).
2. **Passare il numero all'app WhatsApp Business** (gratuita): installala, scegli «usa questo numero», e accetta di
   trasferire le chat. Le chat restano. Controlla di avere la versione 2.24.17 o più recente.
3. **Account Meta Business** (business.facebook.com) a nome dell'azienda scelta, con la **verifica dell'azienda** (documenti
   della società). Va deciso con Luigi a quale delle due aziende intestarlo.
4. **Scelta del collegamento** (da approvare, con i costi):
   - **Meta diretto**: si crea un'app su developers.facebook.com con il prodotto WhatsApp; costi solo dei messaggi mandati da
     Jarvis secondo il listino di Meta (i messaggi che scrivi dall'app restano gratis).
   - **Fornitore (BSP)**, per esempio 360dialog: fa da tramite, ha un canone mensile; stesso formato dei messaggi.
5. **Collegamento in coesistenza** («Onboard WhatsApp Business app users»): dal pannello di Meta o del fornitore si avvia la
   procedura; sul telefono arriva un messaggio di Meta, premi **Connetti**, poi **Conferma** per condividere lo storico
   (facoltativo) e inserisci il codice. Entro 24 ore il fornitore (o lo sviluppatore) deve chiedere la sincronizzazione di
   contatti e storico.
6. **Webhook**: nel pannello di Meta (WhatsApp → Configurazione) scrivi come **Callback URL** l'indirizzo mostrato in Jarvis,
   Impostazioni → WhatsApp (è `JARVIS_ORIGINE` + `/api/whatsapp/webhook`, per esempio
   `https://jarvis.esempio.it/api/whatsapp/webhook`) e come **Verify Token** la parola di verifica (pulsante «Genera»).
   Iscrivi i campi `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update`.
7. In Jarvis, Impostazioni → WhatsApp: fornitore, id del numero (`phone_number_id`), token (o chiave API), **segreto dell'app**
   (App Secret, serve per controllare la firma di ogni messaggio), parola di verifica. Premi **Salva**.
8. Prova con un numero di prova di Luigi: un messaggio ricevuto, una risposta confermata, il controllo che non arrivino «spunte blu».
9. Solo dopo, se Luigi vuole: conferme automatiche e modelli approvati da Meta per scrivere dopo le 24 ore.

## API (tutte con accesso, controllo Origin, JSON e registro; il webhook è pubblico ma firmato)

| Rotta | Cosa fa |
|---|---|
| `GET /api/whatsapp/webhook` | verifica di Meta (`hub.verify_token` → `hub.challenge`); 404 finché non è configurato |
| `POST /api/whatsapp/webhook` | messaggi da Meta: firma `X-Hub-Signature-256` obbligatoria, massimo 2 MB, risposta 200 subito |
| `GET/PUT/DELETE /api/whatsapp/collegamento` | collegamento (segreti **mai** restituiti: solo «impostato»), indirizzo del webhook, interruttori |
| `GET /api/whatsapp/chat?vista=&giorni=&soloUrgenti=1` · `GET /api/whatsapp/chat/:id` | elenco per azienda/privato/da assegnare, domande aperte · ultimi 40 messaggi e risposte aperte |
| `POST /api/whatsapp/chat/:id/proponi` · `POST /api/whatsapp/chat/:id/risposte` | testo proposto dall'AI · salva una bozza (non la manda) |
| `PATCH /api/whatsapp/risposte/:id {testo}` | corregge il testo: torna pulito con la nuova impronta |
| `POST /api/whatsapp/risposte/:id/invia` `{conferma: true, impronta}` · `DELETE /api/whatsapp/risposte/:id` | invio del testo con quell'impronta dopo la conferma · scarta |
| `POST /api/whatsapp/domande/:id {spazio}` · `PUT /api/whatsapp/chat/:id/azienda {spazio}` | risposta a «Di quale azienda è…?» · cambio dell'azienda |
| `POST /api/whatsapp/aggiorna` | giro adesso (azienda, riassunti, proposte, conferme, notifiche) |
| `PUT /api/impostazioni {whatsappConfermeAutomatiche, whatsappNascondiContenuto}` | interruttori |

## Codice e test

`src/whatsapp/` (tipi, telefono, collegamento, schema, archivio, elabora, webhook, invio, attribuzione, classifica,
rispostaAuto, risposte, servizio, strumentiWhatsapp), `src/rotteWhatsapp.ts`; modifiche in app, server, db, impostazioni,
permessi, strumenti, assistente, prompt, briefing; interfaccia in `public/`. Test: `test/whatsapp.test.ts` con `test/metaFinto.ts`
(Meta e fornitore finti), Costructo finto e cervello finto.

| Prova | Esito |
|---|---|
| `npm test` | **150/150** (111 di prima + 39 nuovi, di cui 11 dopo la revisione) |
| `npx tsc --noEmit` | nessun errore |
| `npm run build` e avvio di `node dist/server.js` | funzionano |
| `node script/prova-interfaccia.mjs` (390/1280 px, chiaro/scuro) | **67/67** (48 di prima + 19 nuovi su WhatsApp) |

Formato dei webhook preso dalla documentazione ufficiale di Meta, letta il 18/11/2026 (messages, smb_message_echoes, history,
smb_app_state_sync, group messages, «Onboard WhatsApp Business app users», create webhook endpoint, text messages).

## Scelte fatte in questa parte (da confermare con Luigi)

- **Gruppi**: salvati, ma senza AI (nella coesistenza Meta non passa i gruppi comunque), mai conferme, mai risposte.
- **Contatti «Da assegnare»**: visibili solo nella scheda Tutto finché Luigi non sceglie.
- **Conferme automatiche** solo ai contatti delle aziende (mai ai privati); proposta «mi manda la fattura?» solo per contatti non privati.
- **Rubrica** (`smb_app_state_sync`): si aggiornano solo i nomi dei contatti con cui c'è una chat; la rubrica intera non si copia.
- **Scelta di Luigi sull'azienda** di un contatto: resta anche dopo 30 giorni (come un ricordo); il resto si cancella.
- Indirizzo del webhook: il primo indirizzo `https` di `JARVIS_ORIGINE`.
- Corpo del webhook fino a **2 MB** (non 1 MB): lo storico può arrivare in blocchi da migliaia di messaggi.
- Lo strumento si chiama `whatsapp_risposta`: nel test della Fase 2 «niente strumenti di invio» il controllo su «sposta» ora
  guarda solo l'inizio della parola (prima «risposta» sarebbe sembrato «sposta»).

## Correzioni dopo la revisione indipendente

1. **Conferma = testo che parte.** La domanda di conferma (in chat e nella pagina) mostra il testo **intero**, già ripulito dai
   caratteri invisibili o di inversione del verso (bidi, larghezza zero, controllo) e dalle file di spazi o righe vuote; parte
   (o va nelle Bozze) esattamente quella stringa. Dalla chat: messaggio WhatsApp al massimo **1000** caratteri, bozza email al
   massimo **2000** (più lunghi: rifiutati, mai tagliati). La conferma è legata all'**impronta** (SHA-256) di destinatario + testo:
   se il testo cambia, non vale. «[da completare]» viene rifiutato anche dal server. Gli strumenti che mandano non eseguono mai
   da soli (difesa in più): solo la conferma fa partire il messaggio.
2. **Invio senza doppioni**: si ripete solo su 429 o se il collegamento non si è mai aperto (ECONNREFUSED, ENOTFOUND, EAI_AGAIN).
   Tempo scaduto, connessione caduta o errore 5xx: **esito incerto**, nessun nuovo tentativo, Jarvis dice di controllare sul telefono.
3. **Indirizzo del fornitore**: punto finale tolto, solo https, niente indirizzi numerici o nomi interni (stesse regole della posta),
   niente nip.io/sslip.io o metadati; il nome si risolve e basta un indirizzo interno per bloccare; il controllo si ripete a ogni invio;
   nessun reindirizzamento. Il token va solo all'indirizzo configurato.
4. **Conferme automatiche**: bloccate se un qualunque messaggio del contatto delle ultime 24 ore non è ancora classificato o parla di soldi.
5. **30 giorni** contati anche sulla data del messaggio; lo storico più vecchio di 30 giorni non si salva.
6. **Contatti doppi** (prima con l'id utente, poi con il numero) uniti; se le scelte di Luigi erano diverse vale quella del numero
   e si apre una domanda.
7. **Direzione dello storico** dal mittente (anche nelle chat senza numero).
8. **Pagina**: il server salva il testo pulito e lo restituisce con l'impronta; l'anteprima mostra quello e «Sì, manda» manda quell'impronta.
9. **Costructo**: un errore non resta in memoria; le domande aperte si ricontrollano e si chiudono da sole se il numero compare in una sola azienda.
10. Finestra di 24 ore solo con veri messaggi del contatto (non reazioni, cancellati, non supportati); un invio non consegnato non vale come
    risposta; «assegna azienda» rispetta la scheda aperta. Campo `recipient` per gli utenti senza numero: **verificato** nella documentazione
    Meta «Text messages» («replace the `to` property with `recipient`»); resta da provare dal vivo.

## Da sapere / aperto per la parte 2

- **Mai provato con Meta vero**: formati presi dalla documentazione, non da messaggi reali.
- Costructo dà al massimo **200 controparti** per azienda: con più clienti e fornitori qualche numero non si trova (servirà una ricerca per telefono in Costructo).
- **Utenti senza numero** (nome utente WhatsApp): Jarvis li riconosce con l'id utente (`user_id`) e risponde con `recipient`; da verificare dal vivo.
- **Esito incerto**: dopo un tempo scaduto o un errore 5xx Jarvis non riprova; Luigi controlla sul telefono (la risposta resta «incerta»).
- I messaggi e i riassunti vanno a Anthropic per la classificazione (come la posta): va detto a Luigi.
- Modelli approvati da Meta (per scrivere dopo 24 ore), costi e intestazione dell'account: decisioni di Luigi.
- Un'eventuale seconda azienda con un secondo numero: il webhook accetta un solo `phone_number_id`.
- Parte 2 (360dialog): fatta nel ramo `fase3c/360dialog`, vedi [FASE3-PARTE2.md](FASE3-PARTE2.md).
