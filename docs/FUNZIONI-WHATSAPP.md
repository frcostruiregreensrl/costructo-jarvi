# Le 20 funzioni WhatsApp (Fase 3b)

## Autorizzazione di Luigi

**18/11/2026**: «Autorizzo il 18/11/2026 lo sviluppo in costructo-jarvi delle 20 funzioni WhatsApp approvate, con commit,
push del ramo e apertura della PR, senza merge.» Ramo: `fase3b/funzioni-whatsapp` (nato da `main`, ff78fb5).

Esclusi: merge, deploy, Railway, database di produzione, installazione di pacchetti, **qualunque collegamento vero**
(Meta, servizi di trascrizione, Costructo). Tutto è provato con server finti.

## La regola di Luigi

Jarvis **non copia** quello che fa già Costructo e **non scrive mai record definitivi**. Quello che arriva su WhatsApp
diventa una **proposta** dentro Costructo (pagina Proposte di Costructo), che Luigi approva là.
Esempio: arrivano le ore di un operaio → se in Costructo il rapportino di quel giorno non c'è, Jarvis propone il rapportino.

Mandare una proposta a Costructo è comunque una scrittura fuori da Jarvis: parte **solo dopo la conferma di Luigi in Jarvis**
(un tocco su «Sì, manda», dopo aver visto il testo completo; anche «manda le 3 proposte», con ognuna elencata per intero).
Per ogni tipo c'è l'interruttore «proponi in automatico»: **spento di serie**.

Ogni cosa dice sempre di quale azienda è. Se Jarvis non sa di quale azienda è un contatto, chiede («Di quale azienda è…?»)
e aspetta. Il privato resta privato: va solo nell'agenda di Jarvis, mai in Costructo.

## Le 20 funzioni

| # | Funzione | Cosa fa | Cosa non fa mai |
|---|---|---|---|
| 1 | Vocali in chiaro | Se la trascrizione è accesa, il vocale diventa testo, con il riassunto di due righe. Spenta (di serie) Jarvis scrive «Vocale ricevuto, trascrizione spenta». | Non salva l'audio: lo cancella subito dopo la trascrizione. Del vocale resta solo il testo, per 30 giorni. |
| 2 | Chi aspetta una risposta e promesse | Nel briefing ci sono le chat senza risposta. Quando Luigi scrive «ti mando il preventivo domani», il giorno dopo Jarvis glielo ricorda, se non ha ancora mandato un documento. | Non risponde al posto di Luigi. |
| 3 | Riassunto della giornata per cantiere | Per ogni cantiere conta messaggi, foto, mail e appuntamenti del giorno (dal primo pomeriggio oggi, la mattina ieri). | Non usa l'AI: niente frasi inventate. |
| 4 | Solleciti pronti | Per le fatture scadute in Costructo prepara un testo per il cliente, con l'importo esatto di Costructo, e un link wa.me con il testo già scritto. | Non manda niente: lo manda Luigi dal suo telefono. |
| 5 | Ricerca unica | Cerca insieme nei messaggi WhatsApp, nelle mail salvate e in Costructo. | Non mostra il privato nella scheda Lavoro. Nella scheda Tutto lo mostra solo se Luigi lo chiede. |
| 6 | Promesse in chat → agenda | «Ci vediamo domani alle 10» diventa una proposta di appuntamento: in Costructo per il lavoro, nell'agenda di Jarvis per il privato. | Non scrive niente senza la conferma di Luigi. |
| 7 | Documenti al volo | «Manda a Bianchi il DURC di Edilgreen» diventa una proposta «invio documenti»: dopo l'approvazione li manda Costructo. | Non prepara niente se il documento è di un'altra azienda o di un subappaltatore. Se l'azienda non è chiara, chiede. |
| 8 | Preventivi in attesa | Per i preventivi mandati da più di 7 giorni (si può cambiare) senza risposta, prepara un promemoria e un testo per il cliente. | Non scrive prezzi. Non manda niente. |
| 9 | Posizione → cantiere | Una posizione a meno di 1 km da un cantiere si collega a quel cantiere. Se è più lontana, Jarvis propone «nuovo sopralluogo?». | Non usa mai la posizione degli operai. |
| 10 | Vita privata | Compleanni e «ricordati di…» nelle chat private diventano promemoria nell'agenda di Jarvis, da confermare. Luigi può escludere le chat che vuole. | Non manda niente a Costructo. Non tocca le chat escluse. |
| 11 | Rubrica unica | Confronta i contatti WhatsApp con le controparti (anche cercando per telefono) e con gli operai. Per i numeri sconosciuti propone di aggiungere il numero alla controparte. | Il numero intero si vede solo nella proposta che Luigi conferma. |
| 12 | Nuova richiesta di lavoro | Diventa una proposta «richiesta di lavoro». Nome e indirizzo li trova Haiku, e zod li controlla. | Non risponde in automatico. Nelle risposte proposte da Jarvis non mette mai prezzi. |
| 13 | Foto → cantiere giusto | Se lo scaricamento è acceso, le foto arrivate a meno di 2 minuti l'una dall'altra diventano una sola proposta «foto». Il cantiere lo trova dalla didascalia, dalla chat o (per chi non è operaio) dalla posizione. «Rotto», «crepa»… diventano «problema». | Non scarica le foto dei contatti privati o da assegnare. |
| 14 | Preventivi e fatture dei fornitori | Un PDF con «fattura» o «preventivo» diventa una proposta «documento fornitore». Numero, data e importo li prende solo se sono scritti nel messaggio. | Non legge il contenuto del PDF. I doppioni li toglie Costructo con lo SDI. |
| 15 | DURC e documenti dei subappaltatori | Cerca la voce giusta in Costructo e propone il rinnovo. La scadenza la prende solo se è scritta, altrimenti la chiede a Luigi. | Non inventa scadenze. |
| 16 | Consegne e DDT | Righe con quantità, unità e descrizione diventano una proposta di carico in magazzino. | Le quantità sono solo proposte. Le differenze sono solo segnalate, mai corrette. |
| 17 | Scontrini | La foto dello scontrino resta in Jarvis come nota, nella lista «Scontrini» della pagina Proposte. | **Prima Nota esclusa**: niente va in Costructo. |
| 18 | Promemoria degli appuntamenti | Per gli appuntamenti di domani in Costructo prepara il testo per il cliente, con il link wa.me. | I «modelli» di Meta (parte 2) sono spenti. Se Luigi li accende, partono solo con la sua conferma, mai in automatico. |
| 19 | Ore degli operai | Da «8 ore cantiere Rossi», se il rapportino non c'è già in `/v1/ore`, nasce la proposta «ore». Se Costructo risponde 409, Jarvis dice «già presente in Costructo». | Non geolocalizza mai i lavoratori (GDPR). |
| 20 | Bozza del diario di cantiere | Con messaggi, foto e ore del giorno prepara la proposta «diario» (pulsante «Prepara il diario»). | Non usa l'AI per scrivere il diario: niente inventato. |

## Come funziona una proposta

1. Nasce in Jarvis («da confermare») con una **chiave doppione** fissa (per esempio `wa:<id del messaggio>:ore`):
   lo stesso messaggio non crea mai due proposte.
2. Luigi la vede **per intero** (pagina Proposte, o la domanda in chat). Può correggere i campi. Se mancano dei dati, non parte.
3. «Sì, manda» → `POST /api/assistente/v1/proposte` con l'**impronta** (SHA-256) del testo completo: se qualcosa è
   cambiato dopo che Luigi l'ha vista, la conferma non vale.
4. Le risposte di Costructo:
   - 201 / 200: proposta mandata, da approvare in Costructo;
   - 409: «già presente in Costructo», e Jarvis non fa nient'altro;
   - 404 / 405, oppure token senza l'ambito `proposte`: «In attesa della pagina Proposte in Costructo». La proposta resta
     in Jarvis e si può rimandare: è sicuro, perché la chiave è la stessa.
5. Ogni 15 minuti, o con «Aggiorna gli stati», Jarvis rilegge lo stato della proposta: in attesa, accettata, scartata, superata.

## Interruttori (tutti spenti di serie)

Impostazioni → «Funzioni WhatsApp e proposte per Costructo»:
- scarica foto e PDF dei contatti delle aziende (serve anche per i vocali);
- trascrizione dei vocali: spenta / Google Speech-to-Text / OpenAI, con il costo al minuto e la spesa del mese.
  La spesa conta nello stesso tetto dell'AI;
- proponi in automatico, per tipo;
- giorni dopo cui ricordare i preventivi (7);
- promemoria con i modelli di Meta;
- chat private escluse e contatti che sono operai (si possono togliere).

## Cosa aspetta Luigi

- **Prima Nota**: esclusa. Gli scontrini restano in Jarvis finché Luigi non decide.
- **Telefono degli operai**: in Costructo gli operai non hanno il numero. Per ora decide Luigi in Jarvis
  («Chi è questo contatto: operaio X?»), e Jarvis si ricorda la risposta.
- **Servizio di trascrizione**: Google o OpenAI, con i loro costi e i loro termini (l'audio va a loro). Ora la trascrizione è spenta.
- **Modelli di Meta e parte 2**: servono il collegamento vero e i modelli approvati da Meta.
- **Pagina Proposte in Costructo**: la sta costruendo un'altra sessione. Finché non c'è, le proposte restano in Jarvis.

## Codice e prove

`src/proposte/` (tipi e zod, archivio, invio), `src/funzioni/` (date, rilevatori senza AI, estrazione con Haiku, letture di
Costructo, operai, analisi, briefing, ricerca, rubrica, diario, invio di documenti), `src/trascrizione/`,
`src/whatsapp/media.ts` (scaricamento), `src/rotteFunzioni.ts`. Test: `test/funzioni.test.ts`, con Costructo finto
(pagina Proposte, 404/405/403, 409), Meta finto (con gli allegati) e trascrizione finta.

| Prova | Esito |
|---|---|
| `npm test` | **182/182** (150 di prima + 32 nuovi; uno di prima aggiornato, vedi sotto) |
| `npx tsc --noEmit` | nessun errore |
| `npm run build` e avvio di `node dist/server.js` | funzionano |
| `node script/prova-interfaccia.mjs` | **89/89** (67 di prima + 22 nuovi) |
| dopo la revisione | `tsc` pulito, `npm test` 182/182, build e avvio ok, interfaccia 89/89 |

## Correzioni dopo la revisione indipendente

- **Operaio per azienda**: la risposta «è l'operaio X» vale solo per quell'azienda. Se Luigi sposta il contatto, Jarvis chiede di nuovo.
  Prima di mandare le ore, Jarvis ricontrolla in `/v1/operai` dell'azienda che l'operaio ci sia e sia attivo.
- **DURC**: nella ditta devono esserci tutte le parole del nome di chi scrive, a parole intere. I documenti dell'azienda stessa
  (campo `di_chi` di Costructo) non si usano mai. Con nessuna voce o con più voci, la voce resta vuota e Jarvis chiede.
- **Posizioni**: si salvano solo per i clienti e i fornitori trovati in Costructo, o per chi Luigi ha detto «non è un operaio».
  Mai dai gruppi. Quando un contatto diventa operaio, Jarvis cancella le sue posizioni, il «vicino al cantiere» e i «nuovo sopralluogo?».
- **Documenti al volo**: la proposta porta anche `controparteId` (da Costructo). Se il documento o il destinatario possono essere
  più di uno, Jarvis chiede. La conferma mostra nome, ID e scadenza del documento.
- **Ore**: «7-12» è una fascia oraria, non una data. Le ore di un giorno futuro non si propongono (lo controlla anche lo schema).
  «Villa Rosa 8h, Scuola 6h» diventa due proposte.
- **Impronta**: copre tutto quello che parte (tipo, chiave, origine, riferimento, titolo, dati, impronta di ogni allegato) e il testo
  mostrato. Un allegato aggiunto dopo rende la conferma non più valida.
- **Correzioni**: i nomi di cantiere e operaio li prende il server da Costructo (mai dal browser). Un id che non c'è viene rifiutato.
- **Modelli di Meta**: ogni «prepara» dà un id che vale una volta sola. Un doppio clic non manda due messaggi.
- **Proposte rimaste «in invio»** da più di 10 minuti: Jarvis le cerca in Costructo per chiave doppione. Se le trova sono mandate,
  altrimenti c'è scritto «esito incerto» e si possono rimandare senza doppioni.
- **Messaggio cancellato da chi l'ha mandato**: Jarvis cancella gli allegati scaricati, gli scontrini e le promesse, e scarta
  le proposte non ancora partite. Su quelle già mandate scrive un avviso.
- **File**: i primi byte devono corrispondere al formato (PDF, JPEG, PNG, WebP, HEIC). Database con `secure_delete`.
  L'indice di ricerca si compatta a ogni pulizia.
- **Scaricamento acceso dopo**: Jarvis recupera anche gli allegati degli ultimi 7 giorni. Le proposte già nate ricevono l'allegato.
- **Promesse**: si tiene la frase intera («ti mando la fattura entro il 30/11»).
- **Contratto di Costructo** allineato: `operai {id, nome, attivo}`, `/v1/ore` con `verifica.esiste`, `{proposta}` / `{proposte}`,
  errori `{error, campi|ambito|campo|motivo}`. Un 404 con `campo` vuol dire «dato non trovato», non «pagina mancante».
  `carico_magazzino.fornitore`. Il Costructo finto dei test è stretto come quello vero.
- **Test di prima modificato**: `whatsapp.test.ts` («tipi…»). Il testo della posizione di un contatto non ancora chiarito ora è
  «Posizione condivisa (non salvata…)» e non contiene più l'indirizzo.

## Da sapere

- **Mai provato con servizi veri**: le chiamate a Google, OpenAI e agli allegati di Meta seguono la documentazione pubblica.
  Il formato audio di Google (`OGG_OPUS`, 16 kHz) e l'impronta `sha256` degli allegati vanno provati dal vivo.
- Google sincrono accetta circa 1 minuto di audio: i vocali più lunghi danno errore («ascoltalo dal telefono»).
- La data di una foto o di un documento è quella del messaggio, nel fuso di Luigi.
- Il riconoscimento senza AI può non capire frasi insolite: in quel caso c'è «Proponi in Costructo» sul messaggio.
- Il listino della trascrizione (Google 0,024 $/min, OpenAI 0,003 $/min) va ricontrollato il giorno in cui si accende.
