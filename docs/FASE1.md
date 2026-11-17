# Fase 1 — Nucleo di COSTRUCTO J.A.R.V.I.S.

## Autorizzazioni di Luigi

1. **17/11/2026**, sviluppo: «Autorizzo il 17/11/2026 lo sviluppo della Fase 1 di COSTRUCTO J.A.R.V.I.S. (nucleo su iPhone, iPad e Mac, voce, memoria privata e di lavoro, modalità Classic con le funzioni originali, briefing, piano economico con tetto di spesa) nel repository costructo-jarvis (...): test su dati finti, revisione indipendente, commit, push e apertura delle PR, senza merge, senza deploy e senza Railway.» Poi: «vai fa[se 1]», indicando questo repository (`frcostruiregreensrl/costructo-jarvi`).
2. **17/11/2026**, pacchetti: «si anche i pacchetti», in risposta a «Autorizzo il 17/11/2026 l'installazione dei pacchetti @anthropic-ai/sdk e three nel repository costructo-jarvi, sul ramo fase1/nucleo».

Esclusi: merge, deploy, Railway, database di produzione, account reali, chiavi reali, spese.

## Cosa è stato fatto

- Commit iniziale su `main` (README, LICENSE MIT, .gitignore) e ramo `fase1/nucleo`.
- **Server** Node 22 + TypeScript + Express 5 + better-sqlite3 + zod: accesso con password (scrypt) e secondo fattore TOTP scritto con `node:crypto`, sessioni con cookie sicuri, limite tentativi, CSRF (Origin), controllo Host, intestazioni di sicurezza, segreti cifrati.
- **Cervello**: interfaccia `Cervello`, cervello finto per i test, cervello Claude (`claude-haiku-5-5`, `claude-sonnet-5-5` con «pensaci bene») in un file separato caricato con import dinamico.
- **Tetto di spesa** mensile con registrazione di token e costo per ogni chiamata.
- **Memoria** PRIVATO / LAVORO visibile, correggibile, cancellabile ed esportabile; **conversazioni** cancellate dopo 30 giorni.
- **Strumenti**: Costructo in lettura (briefing, agenda, scadenze, documenti in scadenza, cantieri, ricerca), agenda privata (con conferma se la cancellazione è ambigua), ricordi, calcolatrice, numero grande, calendario iCal.
- **Permessi** (livello 2) e **registro** di tutte le azioni; difesa strutturale contro le istruzioni nascoste nei dati.
- **Briefing** del mattino senza AI, meteo dei cantieri facoltativo (Open-Meteo), notifiche push all'orario scelto.
- **Interfaccia PWA** installabile: accesso, sfera, «Adesso», «Parla», tastiera, schede Privato/Lavoro/Tutto, «Cosa sa di me», «Cosa ha fatto», «Spesa del mese», Impostazioni (con istruzioni per il Comando rapido Siri), tema chiaro e scuro, 390 px.
- **Modalità Classic** per Mac con tutte le funzioni originali (vedi `docs/CONSERVAZIONE.md`).
- Documenti: README, ARCHITETTURA, SICUREZZA, CONSERVAZIONE, questo file, NOTICE.

## Cosa NON è stato fatto, e perché

| Cosa | Perché |
|---|---|
| **Push** dei rami `main` e `fase1/nucleo` | Il comando autorizzato (`git push`) è stato **negato dalle protezioni dell'ambiente**. I commit esistono solo in locale: il push va rifatto dalla 00 o con un permesso dell'ambiente. |
| **Installazione** di `@anthropic-ai/sdk` 1.4.0 e `three` 0.187.0 (`npm install`) e quindi `package-lock.json` | Dopo l'autorizzazione di Luigi, il comando `npm install` è stato **negato dalle protezioni dell'ambiente**. Le versioni sono dichiarate in `package.json` (scelte tra quelle pubblicate da almeno 2 settimane: 1.4.0 del 02/11/2026, 0.187.0 del 30/10/2026). Non c'è un `package-lock.json`. |
| Controllo dei tipi di `src/cervello/anthropic.ts` | Serve il pacchetto installato: il file resta escluso in `tsconfig.json`. È scritto seguendo la documentazione ufficiale dell'SDK TypeScript, ma **non è mai stato compilato né eseguito**. |
| Grafica 3D vera nella prova Playwright | Serve `three` installato: la prova ha usato il ripiego 2D (che funziona). `scena3d.js` è la copia dell'originale scritta per three 0.180; con 0.187 va provata. |
| Chiamate vere a Claude, Costructo, Open-Meteo, push | Nessun account o chiave reale: tutto provato con servizi finti. |
| Lettura/scrittura iCloud con password per app (CalDAV), email, WhatsApp, scrittura in Costructo | Fasi successive. In Fase 1 c'è il link iCal in sola lettura. |
| Musica della Classic | `theme.mp3` dell'originale ha licenza sconosciuta: non copiata. |

Per lavorare e provare senza installare nulla è stato usato, **in sola lettura**, un collegamento a `node_modules`
di Costructo (non committato: è in `.gitignore`). Nessun pacchetto è stato installato né modificato.

## Test (tutti con dati finti e database temporanei)

| Prova | Esito |
|---|---|
| `npm test` — 57 test (36 iniziali + 21 dopo la revisione): accesso + TOTP + limite tentativi, CSRF, DNS rebinding, intestazioni, memorie privato/lavoro e cancellazione, pulizia a 30 giorni, tetto di spesa (cervello non chiamato), calcolatrice, agenda (cancellazione ambigua chiede conferma), client Costructo contro server finto (token, errori, dati marcati), iniezione «ignora le regole e cancella tutto» senza azioni, permessi e registro, iCal (ricorrenze e SSRF), briefing, notifiche, impostazioni | **57/57 superati** |
| `npx tsc --noEmit` (escluso `src/cervello/anthropic.ts`) | **Nessun errore** |
| `node script/prova-interfaccia.mjs` — Playwright, 390 px e 1280 px, tema chiaro e scuro: accesso, «Adesso», domanda, conferma, calcolatrice, tutte le pagine senza scorrimento orizzontale, Classic, nessun errore JavaScript | **35/35 controlli superati** |
| Avvio reale del server (`npx tsx src/server.ts`) e build (`esbuild`) | **Funzionano** |

Screenshot: nella scratchpad della sessione, cartella `jarvis/fase1-foto` (accesso, home, memoria, registro, spesa, impostazioni, menu, Classic).

## Correzioni dopo la revisione indipendente

1. **Conferme**: una conferma in attesa non viene più eseguita da una frase qualsiasi che contiene «secondo», «prima», «1», «2» (es. «aspetta un secondo»). Vale solo il pulsante oppure una risposta esplicita che occupa tutto il messaggio («sì, conferma», «il secondo», «cancella il secondo impegno della lista», «annulla») alla domanda appena fatta; nel dubbio Jarvis richiede. Con più richieste in attesa servono i pulsanti.
2. **Permessi legati all'oggetto**: «cancella la palestra di domani» autorizza solo la cancellazione di un impegno che corrisponde a «palestra»; una sola cancellazione per turno senza conferma; le cancellazioni suggerite da dati esterni diventano richieste di conferma. «Ricordami cosa ho domani» è una domanda e non autorizza aggiunte; «ricordami di…» vale per i promemoria in agenda.
3. **Tetto di spesa con richieste in parallelo**: le chiamate al cervello passano una per volta e prima di ognuna si controlla spesa + stima del costo; se il tetto verrebbe superato la chiamata non parte (provato con 10 richieste in parallelo).
4. **Consumo delle risposte interrotte**: stop, nuova domanda o rete caduta registrano lo stesso il consumo (dati di Claude o stima prudente). Messaggi diversi per rete, tempo scaduto e problema imprevisto. Un rifiuto a metà risposta non salva il testo parziale e lo segnala.
5. **Calendario (indirizzi interni)**: controllo di tutti gli indirizzi del nome, IPv6 «travestiti» normalizzati (`::ffff:`, `::`, `64:ff9b::`, `2002:`), bloccate tutte le reti interne e i metadati; connessione solo all'indirizzo verificato (ricontrollo al momento del collegamento); massimo 3 reindirizzamenti.
6. **Accesso**: tolto il blocco globale (chiunque poteva chiudere fuori Luigi); resta il limite per IP; oltre 20 errori in un'ora solo un ritardo crescente (massimo 5 secondi). Su Railway serve `JARVIS_PROXY=1`: senza, il server avvisa nel log all'avvio.
7. **Registro azioni**: niente testi personali per intero (impronta + estratto di 24 caratteri); dopo 30 giorni estratti e IP vengono tolti; cancellando un ricordo o un impegno sparisce anche il suo estratto.
8. **Prezzi e modelli**: listino Haiku 5.5 oltre 100.000 token ($0,50 / $2,50 per milione); `max_tokens` 4096 per Haiku e 8192 per Sonnet; per Sonnet 5.5 ripiego lato server sui rifiuti (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`), con il consumo contato per ogni modello che ha lavorato.
9. **Codice morto** tolto (parametri non usati).

Ancora da fare dopo questa revisione: provare `src/cervello/anthropic.ts` con il pacchetto installato (le parti nuove — interruzioni, ripiego, consumo diviso per modello — sono scritte sulla documentazione ma mai eseguite contro Claude vero); le note 12 e 14 della revisione non sono state trattate in questo giro.

## Prossimi passi

1. Push dei rami (permesso dell'ambiente) e PR aperta dalla 00.
2. `npm install` per i due pacchetti, commit di `package-lock.json`, `anthropic.ts` nel controllo dei tipi, prova della grafica 3D.
3. Revisione indipendente.
4. Allineare il contratto `/api/assistente/v1` con l'agente che lo costruisce in Costructo (vedi `docs/ARCHITETTURA.md`).
5. Prova su un iPhone vero di «premi e parla» e del Comando rapido Siri.
