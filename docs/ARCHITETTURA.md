# Architettura di COSTRUCTO J.A.R.V.I.S. (Fase 1)

Servizio **separato** da Costructo, con indirizzo e accesso propri. Costructo è uno dei suoi connettori
(in sola lettura). Un solo utente: Luigi.

```
 iPhone / iPad (PWA, «premi e parla»)      Mac (PWA + modalità Classic, parola di risveglio)
                  │                                   │
                  └──────── https + cookie di sessione + secondo fattore ────────┘
                                         │
 ┌──────────────────────── Server Jarvis (Node 22, Express 5) ────────────────────────┐
 │ Sicurezza: Host/Origin, intestazioni, sessioni, limite tentativi                    │
 │ Assistente (assistente.ts): conferme → calcolatrice → tetto di spesa → cervello     │
 │ Cervello (interfaccia): Claude Haiku 5.5 / Sonnet 5.5 · finto per i test            │
 │ Strumenti (strumenti.ts) → permessi (permessi.ts) → registro (registro.ts)          │
 │ Memoria PRIVATO ┃ LAVORO · agenda locale · conversazioni (30 giorni) · consumi      │
 │ Briefing (senza AI) · notifiche push · pianificatore (ogni minuto)                  │
 └───────┬───────────────────────────┬───────────────────────────┬──────────────────────┘
         │ SQLite data/jarvis.db      │ Costructo (Bearer csa_…)   │ Open-Meteo (facoltativo), iCal
```

## Cartelle

| Percorso | Contenuto |
|---|---|
| `src/server.ts` | avvio: database, pulizia a 30 giorni (ogni 6 ore), notifica del mattino (controllo ogni minuto) |
| `src/app.ts` | Express: sicurezza, accesso, API, file dell'interfaccia, `/vendor/three` (solo se installato) |
| `src/assistente.ts` | gestione di una domanda in streaming |
| `src/cervello/` | `tipi.ts` (interfaccia), `finto.ts` (test), `anthropic.ts` (Claude), `carica.ts` (import dinamico) |
| `src/strumenti.ts`, `src/permessi.ts`, `src/registro.ts` | strumenti dell'AI, regole dei permessi, registro azioni |
| `src/memorie.ts`, `src/agenda.ts`, `src/conversazioni.ts`, `src/consumi.ts`, `src/impostazioni.ts` | dati |
| `src/costructo.ts`, `src/calendario.ts`, `src/meteo.ts` | connettori |
| `src/aziende.ts` | più aziende di Costructo: un token per azienda, elenco cifrato, scelta dell'azienda per gli strumenti ([AZIENDE.md](AZIENDE.md)) |
| `src/briefing.ts`, `src/push.ts` | briefing e notifiche |
| `src/sicurezza/` | password (scrypt), TOTP, sessioni, limiti, cifratura, utente |
| `public/` | PWA (`index.html`, `app.js`, `voce.js`, `api.js`, `sw.js`, manifest, icone) |
| `public/classic/` | modalità Classic (`classic.js`, scena 3D/2D, suoni, frasi) |
| `test/` | test con dati finti; `script/` server di prova e prova Playwright |

## Una domanda, passo per passo

1. Il browser manda `POST /api/chiedi` `{messaggio, vista, conversazione}`; il server risponde in **streaming** (eventi `delta`, `strumento`, `agenda`, `memoria`, `numero`, `conferma`, `avviso`, `modello`, `fine`).
2. Se c'è una **conferma in attesa** e Luigi dice «sì», «annulla» o «il secondo», si esegue senza AI.
3. Se è un **conto**, risponde la calcolatrice (costo zero).
4. Se il **tetto di spesa** del mese è raggiunto, Jarvis si ferma e avvisa: il cervello non viene chiamato.
5. Altrimenti il **cervello** fa al massimo 5 passi. Il prompt di sistema è stabile (va in cache); data, ricordi e agenda arrivano nel messaggio del turno, **marcati come dati**. Ogni passo registra i token e il costo; tra un passo e l'altro il tetto viene ricontrollato.
6. Ogni chiamata a uno strumento: validazione (zod) → permesso → esecuzione → registro.
7. Il browser divide il testo in frasi e le legge a voce mentre arrivano.

## Schede Privato / Lavoro / Tutto

| Scheda | Ricordi | Strumenti offerti |
|---|---|---|
| Privato | solo privati | agenda privata, calendario personale, ricordi privati, numero |
| Lavoro | solo di lavoro | Costructo (lettura), ricordi di lavoro, numero |
| Tutto | entrambi | tutti |

La separazione vale due volte: gli strumenti non vengono nemmeno offerti all'AI, e se l'AI li chiede comunque il motore dei permessi li nega.

## Database (SQLite, `data/jarvis.db`)

`utente` (una riga), `sessioni` (solo hash del token), `tentativi` (limite accessi), `conversazioni` e `messaggi`
(30 giorni), `memorie` (spazio privato|lavoro, testo, origine, creato, aggiornato), `impegni` (agenda locale),
`registro`, `consumi` (token e costo per mese), `impostazioni`, `segreti` (cifrati), `conferme`, `iscrizioni_push`.

## Contratto atteso da Costructo (`/api/assistente/v1`)

Il modulo lo sta costruendo un altro agente sul ramo `evolution/jarvis-api` di Costructo. Il client di Jarvis è
**tollerante**: ogni campo è facoltativo, gli elementi non validi vengono scartati, le liste possono arrivare come
array o dentro un oggetto. Token: `Authorization: Bearer csa_…`. Chiavi lette:

| Rotta | Cosa usa Jarvis |
|---|---|
| `GET /v1/io` | `azienda {id, nome}`: quando si aggiunge un token (nome dell'azienda, niente doppioni) e per «Prova il collegamento» |
| `GET /v1/briefing` | `impegni[] {titolo, inizio ISO}`, `cantieri[] {nome, lat, lon}`, `scadenze[] {titolo, scadenza}`, `documentiInScadenza[] {titolo, scadenza}`, `fattureDaIncassare[] {cliente, numero, importo, residuo, scadenza}` (accetta anche `agenda`, `documenti`, `fatture`) |
| `GET /v1/agenda?giorni=N` | lista di impegni |
| `GET /v1/scadenze`, `/v1/documenti-in-scadenza`, `/v1/cantieri` | liste |
| `GET /v1/cerca?q=` | risultati (passati all'AI come dati) |
| `GET /v1/controparti`, `/v1/preventivi`, `/v1/ore`, `/v1/inventario` | previsti nel client, non ancora usati dagli strumenti |

## Scelte per il cervello Claude

- Modello di serie `claude-haiku-5-5` con `effort: "low"` e `max_tokens` 1024 (risposte brevi, a voce); `claude-sonnet-5-5` con `effort: "medium"` e 4096 solo con «pensaci bene».
- `client.messages.stream()` + `finalMessage()`; strumenti con `strict: true`, `tool_choice: auto`.
- Prompt caching sul prompt di sistema. Nota: se il prompt è più corto della soglia minima del modello la cache non scatta; il costo resta comunque basso.
- `stop_reason: "refusal"` gestito (nessun contenuto usato, frase cortese), `max_tokens` segnalato.
- I blocchi originali della risposta vengono rimandati invariati nel ciclo degli strumenti (campo `grezzo`).
