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
  **Più aziende** (fino a 5, un token per azienda): Jarvis dice sempre di quale azienda parla e, se non è chiaro, chiede.
- **Briefing del mattino** con notifica push (7:00 di serie): impegni, cantieri, scadenze, documenti, fatture da incassare, meteo dei cantieri (facoltativo, Open-Meteo). Con più aziende: una parte e una notifica per ogni azienda.
- **Calcolatrice istantanea** e **frasi rapide** senza AI (costo zero).
- **Registro** di tutte le azioni («Cosa ha fatto») e **Spesa del mese**.

## Cosa fa in più (Fase 2)

- **Posta** (fino a 10 caselle: Gmail, PEC Aruba, altro server; ognuna di un'azienda o privata): legge ogni 5 minuti in
  **sola lettura** (non segna come letto, non sposta, non cancella), riassume, segnala le urgenze, prepara **bozze** che
  mandi tu. Pagina «Posta» divisa per azienda e privato; notifica per le mail urgenti; mail urgenti nel briefing.
- **PEC**: solo lettura e bozze, **mai** invii. **Conferme di ricezione automatiche**: spente di serie, mai con soldi o impegni.
- **Calendario Apple** (iCloud, sola lettura) con scelta dei calendari privati o di un'azienda.
- Dati delle mail cancellati dopo 30 giorni. Come collegare Gmail, PEC e Apple passo per passo: [docs/FASE2.md](docs/FASE2.md).

Dettagli: [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md), [docs/SICUREZZA.md](docs/SICUREZZA.md),
[docs/CONSERVAZIONE.md](docs/CONSERVAZIONE.md), [docs/FASE1.md](docs/FASE1.md), [docs/AZIENDE.md](docs/AZIENDE.md), [docs/FASE2.md](docs/FASE2.md).

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
| `COSTRUCTO_URL`, `COSTRUCTO_TOKEN` | collegamento a Costructo (token `csa_…` di **una** azienda); si possono dare anche dalle Impostazioni, dove si aggiungono anche i token delle altre aziende (vedi sotto) | no |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTATTO` | notifiche push | per le notifiche |
| `JARVIS_CODICE_PRIMO_ACCESSO` | codice monouso per creare l'utente dal browser quando il database è vuoto (es. primo avvio su Railway); dopo la creazione non serve più e si può togliere | al primo avvio |

ElevenLabs è previsto come opzione ma **spento** in questa fase.

### Collegare più aziende di Costructo

In Costructo ogni token `csa_…` vale per **una sola azienda**. Da Impostazioni → «Collegamento a Costructo»:
scrivi l'indirizzo di Costructo (uno solo), poi incolla il token di ogni azienda in «Aggiungi il token di un'altra
azienda» e premi **Aggiungi** (fino a 5). Jarvis legge il nome dell'azienda da Costructo; se il token non è
accettato, non lo salva. I token restano sul server, cifrati. Un vecchio `COSTRUCTO_TOKEN` vale come prima azienda.
Dettagli: [docs/AZIENDE.md](docs/AZIENDE.md).

## Pacchetti

Tutti con versione esatta in `package.json` e `package-lock.json`; si installano con `npm install`
(su Railway lo fa da solo prima di `npm run build`). In `dist/server.js` restano esterni (`--packages=external`).
Fase 1 (autorizzazione del 17/11/2026, vedi [docs/FASE1.md](docs/FASE1.md)):

| Pacchetto | Versione | A cosa serve | Senza il pacchetto |
|---|---|---|---|
| `@anthropic-ai/sdk` | 1.4.0 | cervello Claude (`src/cervello/anthropic.ts`) | Jarvis risponde «il cervello non è ancora installato»; calcolatrice, agenda, briefing e memoria funzionano |
| `three` | 0.187.0 | grafica 3D della modalità Classic (`public/classic/scena3d.js`) | la modalità Classic usa il ripiego 2D |

Fase 2 (autorizzazione del 18/11/2026, vedi [docs/FASE2.md](docs/FASE2.md)), tipi già inclusi nei pacchetti:

| Pacchetto | Versione | A cosa serve |
|---|---|---|
| `imapflow` | 2.10.0 | lettura delle caselle (IMAP) e bozze nella cartella Bozze |
| `mailparser` | 3.14.1 | lettura del contenuto delle mail (testo, PEC, allegati solo per nome) |
| `nodemailer` | 10.3.1 | solo conferme di ricezione automatiche (mai dalla PEC) e composizione delle bozze |

## Test

Tutti con dati finti e database temporanei:

```bash
npm test                  # test del server (node:test + tsx)
npm run check             # controllo dei tipi TypeScript
npm run test:interfaccia  # prova Playwright a 390 e 1280 px, tema chiaro e scuro (screenshot in ./prova-foto)
# Posta e calendario Apple si provano con server finti (IMAP, SMTP, iCloud): nessuna casella vera.
```

## Licenza

MIT, © 2026 FR Costruire Green S.r.l. Contiene parti di J.A.R.V.I.S. di Thomas Colombo (MIT): vedi [NOTICE](NOTICE).
