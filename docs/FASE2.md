# Fase 2 — Posta e calendario Apple

## Autorizzazione di Luigi

**18/11/2026**: «Autorizzo il 18/11/2026 lo sviluppo della Fase 2 di Jarvis (calendario Apple ed email) in
costructo-jarvi, con installazione di imapflow, mailparser e nodemailer, commit, push del ramo e apertura della PR,
senza merge.» Ramo: `fase2/calendario-email` (nato da `fase1b/piu-aziende`).

Esclusi: merge, deploy, Railway, database di produzione, caselle e account veri. Tutto è provato con server finti.

## Decisioni già prese

- Caselle: 2 PEC (Aruba), 3 di lavoro, 2 private; fornitori Aruba PEC e Gmail. Calendario: Apple iCloud. Un solo utente.
- Autonomia livello 2: Jarvis legge, riassume, segnala le urgenze e prepara **bozze** di risposta.
- Conferme di ricezione automatiche permesse, **tranne** quando la mail parla di pagamenti, importi o impegni.
- **Dalla PEC non parte mai niente** (valore legale): solo lettura e bozze. Sulla PEC Jarvis non sposta, non cancella e non segna niente.
- In generale Jarvis **non cancella, non sposta e non segna come lette** le mail.
- Dati delle mail tenuti 30 giorni. Ogni casella appartiene a un'azienda o al privato: Jarvis dice sempre di quale
  azienda e di quale casella è una mail, e chiede quando non è chiaro.

## Cosa fa

| Cosa | Come |
|---|---|
| **Legge la posta** | Ogni 5 minuti (e con «Aggiorna ora» nella pagina Posta) guarda la Posta in arrivo di ogni casella e prende solo le mail nuove. La prima volta: gli ultimi 7 giorni, al massimo 200 mail. La casella si apre in **sola lettura** e le mail si scaricano senza segnarle come lette. |
| **Salva poco** | Per ogni mail: mittente, destinatari, oggetto, data, un testo breve (al massimo 4 KB, senza HTML), i **nomi** degli allegati (non il contenuto). Più il riassunto, l'urgenza e se parla di soldi o impegni. Tutto si cancella dopo 30 giorni. |
| **Riassume e segnala le urgenze** | Prima un filtro gratuito (newsletter, mailing list, messaggi automatici, no-reply, ricevute PEC: niente AI, mai urgenti). Le altre vanno a Claude Haiku **una per richiesta** (così una mail non può influenzare il giudizio sulle altre), con lo stesso tetto di spesa delle domande. «Parla di soldi o impegni» non scende mai sotto il controllo senza AI; una PEC non consegnata è sempre urgente. Al tetto le mail restano senza riassunto e la pagina Posta lo dice. |
| **PEC** | Riconosce la busta («Per conto di…») e legge il messaggio vero dentro `postacert.eml`; riconosce le ricevute di accettazione e di consegna. |
| **Bozze** | «Prepara bozza di risposta» nella pagina Posta, oppure a voce («prepara una risposta alla mail di Rossi»). La bozza va in Jarvis **e** nella cartella Bozze della casella (Gmail «[Gmail]/Bozze», Aruba «Bozze»), con il segno di bozza. **Non viene mai inviata**: la mandi tu dalla tua app di posta. A voce serve sempre il pulsante «Conferma». |
| **Conferme automatiche** | Solo se le accendi tu (vedi sotto). |
| **Notifiche** | Quando arriva una mail urgente nuova: una notifica con il nome dell'azienda (o «Privato») e della casella, al massimo una ogni 30 minuti per casella (le altre si raggruppano). |
| **Briefing** | Per ogni azienda il numero di mail urgenti delle ultime 24 ore e la prima; poi la posta privata urgente. In «Adesso» compare la mail urgente più importante. |
| **Calendario Apple** | Legge i calendari iCloud scelti (sola lettura): gli eventi privati vanno in «oggi» e nell'agenda privata, quelli assegnati a un'azienda nella parte di lavoro con il nome dell'azienda. Il vecchio link iCal continua a funzionare. |

### A voce (strumenti dell'AI)

`posta_recenti` (filtri: casella, azienda, solo urgenti, giorni), `posta_cerca`, `posta_leggi`, `posta_bozza`,
`calendario_aziende_leggi`. Nella scheda **Privato** si vedono solo le caselle private; in **Lavoro** solo quelle delle
aziende; in **Tutto** tutte. Se «la mail di Rossi» c'è in due aziende, Jarvis chiede «di quale parli?».

## Cosa non fa MAI

- Non invia mail (l'unica eccezione sono le conferme automatiche, se le accendi, con il testo fisso qui sotto).
- Non invia niente dalla PEC, nemmeno le conferme.
- Non cancella, non sposta, non segna come lette o importanti le mail; non crea cartelle.
- Non scarica il contenuto degli allegati.
- Non segue istruzioni scritte dentro le mail: il testo delle mail arriva all'AI solo come **dato**.
- Non dice di aver «inviato» o «risposto»: dice «ho preparato la bozza».

## Conferme di ricezione automatiche

**Spente di serie.** Per farle partire servono **due** interruttori: in Impostazioni → «Conferme di ricezione automatiche»
(generale) e, nella casella, «Permetti le conferme di ricezione automatiche da questa casella».

Partono solo se tutto questo è vero (nel dubbio non partono):

1. la casella è Gmail o «altro» (mai PEC: anche una PEC messa come «altro», riconosciuta dal server — pec., legalmail,
   postecert, arubapec… — o dall'indirizzo PEC, non manda mai niente);
2. il mittente è **autenticato**: nell'intestazione `Authentication-Results` più in alto (scritta dal fornitore di posta
   di Luigi all'arrivo; per Gmail `mx.google.com`) c'è `dmarc=pass`, oppure `dkim=pass` con il dominio della firma allineato
   a quello del mittente. Se manca o non si legge: niente conferma (così nessuno può farla partire verso un indirizzo falsificato);
3. la mail è arrivata dopo il primo controllo, da meno di 2 giorni, ed è stata riassunta dall'AI;
4. l'AI dice che **non** parla di pagamenti, importi o impegni **e** il controllo senza AI non trova niente in oggetto,
   testo e **nomi degli allegati** (`_`, `-` e `.` valgono come spazi: «Fattura_123.pdf», «fatt. n. 12»): parole come euro, €, EUR,
   importo, pagamento, pagherò, bonifico, fattura, fatt., ft., preventivo, scadenza, contratto, ordine, penale, sollecito,
   IBAN, totale, saldo, acconto, caparra, rata, offerta, prezzo, costo, firma, impegno; in inglese invoice, payment, pay,
   quote, quotation, order, contract, price, deadline, amount, wire, bank, «payment due»…; cifre con i decimali o con la valuta,
   numeri di almeno 3 cifre vicino a parole di denaro;
5. il mittente non è no-reply, una mailing list, una newsletter, un messaggio automatico (`Auto-Submitted`,
   `Precedence: bulk/list`, `List-*`), un indirizzo PEC o una delle tue caselle; se c'è un «Rispondi a», è dello stesso dominio;
6. non è già partita una conferma allo stesso mittente negli ultimi 7 giorni, e oggi non ne sono partite già 20.

Oggetto e testo **fissi** (non si ripete l'oggetto del mittente, niente scritto dall'AI): oggetto «Conferma di ricezione
del suo messaggio», con `Auto-Submitted: auto-replied`, `In-Reply-To` e `References`:

> Buongiorno,
> confermiamo di aver ricevuto il suo messaggio. Le risponderemo appena possibile.
> Questo è un messaggio automatico di sola conferma di ricezione: non contiene accettazioni, impegni o conferme di alcun tipo.
> Cordiali saluti

Ogni conferma finisce in «Cosa ha fatto» con la casella, il **solo dominio** del destinatario e il motivo.

## Come collegare le caselle (passo per passo)

Impostazioni → «Caselle email» → «Aggiungi una casella». Jarvis prova l'accesso prima di salvare: se qualcosa non va
lo dice (password sbagliata, Gmail che vuole la password per le app, server non raggiungibile) e non salva niente.

### Gmail (password per le app)

1. Sul telefono o sul computer apri **myaccount.google.com** con l'account Gmail della casella.
2. Vai su **Sicurezza**. Se la **Verifica in due passaggi** non è attiva, attivala (è obbligatoria per il passo dopo).
3. Cerca **Password per le app** (si trova anche scrivendo «password per le app» nella ricerca in alto).
4. Scrivi un nome, per esempio «Jarvis», e premi **Crea**. Google mostra 16 lettere: copiale.
5. In Jarvis premi **Gmail**, scrivi un nome per la casella (es. «Lavoro Edilgreen»), scegli l'azienda o «Privato»,
   l'indirizzo Gmail e incolla le 16 lettere (gli spazi vanno bene). Premi **Prova e aggiungi**.
6. In Gmail, Impostazioni → «Inoltro e POP/IMAP», l'accesso IMAP deve essere attivo (di solito lo è).

Per togliere l'accesso a Jarvis basta cancellare quella password per le app da Google.

### PEC Aruba

1. In Jarvis premi **PEC Aruba**.
2. Scrivi un nome (es. «PEC Rossi Costruzioni»), scegli l'azienda, l'indirizzo PEC completo e la **password della PEC**
   (quella che usi su webmail.pec.it). I server (imaps.pec.aruba.it e smtps.pec.aruba.it) sono già impostati.
3. Premi **Prova e aggiungi**. Per la PEC la casella delle conferme automatiche non compare: dalla PEC non parte mai niente.

### Altro server

Premi **Altro** e scrivi il server della posta in arrivo (IMAP, di solito porta 993) e, solo se vuoi le conferme automatiche,
quello in uscita (SMTP, di solito 465). Il server deve avere un nome pubblico (non un numero, non la rete di casa o dell'ufficio):
il collegamento è sempre cifrato.

### Calendario Apple (password specifica per le app)

1. Apri **account.apple.com** e accedi con il tuo Apple ID.
2. Vai su **Accesso e sicurezza** → **Password specifiche per le app** → **+**.
3. Scrivi «Jarvis» e premi **Crea**. Apple mostra una password del tipo `abcd-efgh-ijkl-mnop`: copiala.
4. In Jarvis, Impostazioni → «Calendario Apple»: scrivi l'Apple ID (la tua email Apple) e incolla la password. Premi **Collega**.
5. Compare l'elenco dei calendari: togli la spunta a quelli che non vuoi, e per ognuno scegli se è **Privato** o di
   **un'azienda**. Premi **Salva la scelta dei calendari**.

Per togliere l'accesso: «Scollega» in Jarvis, e su account.apple.com revoca la password specifica.

## API (tutte con accesso, controllo Origin, JSON e registro)

| Rotta | Cosa fa |
|---|---|
| `GET /api/posta/caselle` | caselle (password **mascherate**), aziende, server già pronti, interruttore generale |
| `POST /api/posta/caselle` | aggiunge (prova l'accesso prima di salvare) |
| `PATCH /api/posta/caselle/:id` · `DELETE /api/posta/caselle/:id` · `POST /api/posta/caselle/:id/prova` | modifica (riprova se cambiano accesso o server), rimuove (cancella anche le mail salvate in Jarvis), prova |
| `POST /api/posta/aggiorna` | «Aggiorna ora» (un solo giro alla volta) |
| `GET /api/posta/messaggi?giorni=&soloUrgenti=1&spazio=&casella=` · `GET /api/posta/messaggi/:id` | elenco (senza testo) e dettaglio (testo breve, allegati, bozze) |
| `POST /api/posta/messaggi/:id/bozza/proponi` · `POST /api/posta/messaggi/:id/bozza` | testo proposto dall'AI · bozza nelle Bozze (mai inviata) |
| `GET/PUT/DELETE /api/calendario-apple` · `PUT /api/calendario-apple/calendari` · `POST /api/calendario-apple/prova` | calendario Apple |
| `PUT /api/impostazioni {confermeAutomaticheAttive}` | interruttore generale delle conferme automatiche |

## Codice e test

`src/posta/` (tipi, caselle, rete, imap, uscita, analisi, archivio, lettura, classifica, rispostaAuto, bozze, servizio,
strumentiPosta), `src/calendarioApple.ts`, `src/rotteFase2.ts`; modifiche in strumenti, permessi, assistente, prompt,
briefing, push, consumi (coda delle chiamate all'AI condivisa), db, impostazioni, app, server.

Test (nessuna rete, nessuna casella vera): `test/posta.test.ts`, `test/calendarioApple.test.ts` con IMAP finto
(`test/postaFinta.ts`), invio finto, cervello finto e iCloud finto (`test/caldavFinto.ts`).

| Prova | Esito |
|---|---|
| `npm test` | **111/111** (78 di prima + 33 nuovi, di cui 9 dopo la revisione di sicurezza) |
| `npx tsc --noEmit` | nessun errore |
| `npm run build` e avvio di `node dist/server.js` | funzionano; i tre pacchetti restano esterni come gli altri |
| `node script/prova-interfaccia.mjs` (390/1280 px, chiaro/scuro) | **48/48** (35 di prima + 13 nuovi su Posta, bozza, caselle) |

Pacchetti installati (versione esatta, pubblicati da più di 2 settimane, tipi già inclusi: nessun `@types` aggiunto):
`imapflow` 2.10.0, `mailparser` 3.14.1, `nodemailer` 10.3.1.

## Correzioni dopo la revisione di sicurezza

1. Conferme automatiche solo a mittenti autenticati (DMARC o DKIM allineato nell'Authentication-Results più in alto); oggetto fisso.
2. Una PEC messa come «altro» (server o indirizzo PEC) è trattata come PEC: niente conferme, invio rifiutato.
3. Controllo del denaro più largo: nomi degli allegati, separatori `_ - .`, inglese, abbreviazioni, numeri vicino a parole di denaro.
4. Una mail per richiesta all'AI; «tocca» mai sotto il controllo senza AI, vero se la risposta non si legge.
5. Le password non tornano al browser nemmeno in parte: solo «••••» e `passwordImpostata` (le ultime cifre restano solo per i token di Costructo).
6. Cambiare server, porte, tipo o indirizzo di una casella richiede di riscrivere la password.
7. Tutti gli indirizzi verificati del server, prima IPv4, con ripiego solo se un indirizzo non risponde.
8. Server senza UIDNEXT: l'ultimo UID si chiede al server; cambio di UIDVALIDITY: niente doppioni (Message-ID), niente nuove notifiche o conferme.
Inoltre: i file tecnici della PEC non compaiono tra gli allegati; la pagina Posta ha le schede Privato/Lavoro/Tutto e un limite di 100 mail per casella.

## Da sapere / aperto

- Mai provato con caselle vere né con iCloud vero: va fatto con Luigi dopo il merge (prima una casella privata).
- Su Gmail l'oggetto delle mail urgenti arriva nella notifica push (cifrata dal servizio push, ma visibile sulla schermata bloccata).
- Le mail e i riassunti vanno a Anthropic per la classificazione (come le domande): va detto a Luigi.
- `npm audit` segnala due avvisi **già presenti** prima di questa fase (zod, esbuild di tsx), non dei pacchetti nuovi.
