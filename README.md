# COSTRUCTO J.A.R.V.I.S.

Assistente personale di Luigi per la vita privata e il lavoro, collegato a Costructo.
Servizio separato e indipendente dal gestionale: voce, memoria privata e di lavoro, briefing.

Funziona su **iPhone e iPad** (app web aggiunta alla schermata Home, «premi e parla») e su **Mac**
(stessa app, più la **modalità Classic** a schermo intero con la parola di risveglio «Jarvis» o «Costructo»).
Un solo utente: Luigi.

## Cosa fa (Fase 1)

- **Parla e ascolta**: voce in uscita del dispositivo, riconoscimento vocale del browser, tastiera come riserva. Le risposte vengono lette mentre arrivano.
- **Ragiona con Claude**: Claude Haiku 5.5 di serie; Claude Sonnet 5.5 solo se dici «pensaci bene». **Tetto di spesa mensile**: al limite si ferma e avvisa.
- **Memoria divisa** in PRIVATO e LAVORO: la vedi, la correggi, la cancelli («Cosa sa di me»). Conversazioni cancellate da sole dopo 30 giorni; i ricordi restano finché non li cancelli.
- **Agenda privata** locale (aggiungi, elenca, cancella; se la cancellazione è ambigua chiede quale).
- **Costructo in sola lettura**: briefing, agenda, scadenze, documenti in scadenza, cantieri, ricerca.
- **Briefing del mattino** con notifica push (7:00 di serie): impegni, cantieri, scadenze, documenti, fatture da incassare, meteo dei cantieri (facoltativo, Open-Meteo).
- **Calcolatrice istantanea** e **frasi rapide** senza AI (costo zero).
- **Registro** di tutte le azioni («Cosa ha fatto») e **Spesa del mese**.

Dettagli: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md), [docs/SICUREZZA.md](docs/SICUREZZA.md),
[docs/CONSERVAZIONE.md](docs/CONSERVAZIONE.md), [docs/FASE1.md](docs/FASE1.md).

## Avvio in locale

Serve Node 22.

```bash
npm install                      # dipendenze (vedi sotto i due pacchetti nuovi)
cp .env.esempio .env             # poi compila almeno JARVIS_CHIAVE_CIFRATURA
export $(grep -v '^#' .env | xargs)
npm run crea-utente              # nome, password (almeno 12 caratteri) e codice per l'app di autenticazione
npm run dev                      # http://localhost:4180
```

Per la produzione: `npm run build` e poi `npm start` (con `NODE_ENV=production`, `JARVIS_ORIGINE` in https e `JARVIS_PROXY=1` dietro un proxy).

## Variabili d'ambiente

| Variabile | A cosa serve | Obbligatoria |
|---|---|---|
| `JARVIS_CHIAVE_CIFRATURA` | 32 byte (hex o base64) per cifrare i segreti nel database | sì |
| `JARVIS_ORIGINE` | indirizzi ammessi (controllo Origin e Host), separati da virgola | in produzione |
| `NODE_ENV` | `production` attiva cookie `Secure`, prefisso `__Host-` e HSTS | in produzione |
| `PORT`, `JARVIS_HOST` | porta e indirizzo di ascolto (di serie 4180, 127.0.0.1 in sviluppo) | no |
| `JARVIS_DATI`, `JARVIS_DB` | cartella dei dati / file del database (di serie `data/jarvis.db`) | no |
| `JARVIS_PROXY` | `1` dietro **un** proxy (IP vero per il limite tentativi). **Su Railway: sì** (senza, il server avvisa nel log) | su Railway sì |
| `JARVIS_FUSO` | fuso di Luigi (di serie `Europe/Rome`) | no |
| `ANTHROPIC_API_KEY` | chiave di Claude: solo sul server, mai nel browser | per l'AI |
| `JARVIS_MODELLO`, `JARVIS_MODELLO_APPROFONDITO` | di serie `claude-haiku-5-5` e `claude-sonnet-5-5` | no |
| `COSTRUCTO_URL`, `COSTRUCTO_TOKEN` | collegamento a Costructo (token `csa_…`); si possono dare anche dalle Impostazioni | no |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTATTO` | notifiche push | per le notifiche |
| `JARVIS_CODICE_PRIMO_ACCESSO` | codice monouso per creare l'utente dal browser quando il database è vuoto (es. primo avvio su Railway); dopo la creazione non serve più e si può togliere | al primo avvio |

ElevenLabs è previsto come opzione ma **spento** in questa fase.

## Pacchetti da installare dopo l'autorizzazione

Luigi ha autorizzato il 17/11/2026 l'installazione di due pacchetti nuovi (vedi [docs/FASE1.md](docs/FASE1.md)).
Sono dichiarati in `package.json` con versione esatta, ma in questa sessione **l'installazione non è stata eseguita**
(il comando è stato bloccato dalle protezioni dell'ambiente): vanno installati con `npm install`, che crea anche `package-lock.json`.

| Pacchetto | Versione | A cosa serve | Senza il pacchetto |
|---|---|---|---|
| `@anthropic-ai/sdk` | 1.4.0 | cervello Claude (`src/cervello/anthropic.ts`) | Jarvis risponde «il cervello non è ancora installato»; calcolatrice, agenda, briefing e memoria funzionano |
| `three` | 0.187.0 | grafica 3D della modalità Classic (`public/classic/scena3d.js`) | la modalità Classic usa il ripiego 2D |

Dopo l'installazione: togliere `src/cervello/anthropic.ts` da `exclude` in `tsconfig.json` e rilanciare `npm run check`.

## Test

Tutti con dati finti e database temporanei:

```bash
npm test                  # test del server (node:test + tsx)
npm run check             # controllo dei tipi TypeScript
npm run test:interfaccia  # prova Playwright a 390 e 1280 px, tema chiaro e scuro (screenshot in ./prova-foto)
```

## Licenza

MIT, © 2026 FR Costruire Green S.r.l. Contiene parti di J.A.R.V.I.S. di Thomas Colombo (MIT): vedi [NOTICE](NOTICE).
