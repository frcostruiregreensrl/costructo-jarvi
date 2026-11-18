# Matrice di conservazione delle funzioni originali

Ogni funzione di J.A.R.V.I.S. originale (thomas2306/jarvis-tiktok, commit d9fc6a5, inventario del 17/11/2026)
e dove si trova in COSTRUCTO J.A.R.V.I.S. **Conservata** = stessa funzione; **Migliorata** = c'è ed è più sicura o
più completa; **Sostituita** = c'è un equivalente per una decisione di Luigi o un limite tecnico; **Rimandata** = arriva in una fase successiva.

| # | Funzione originale | Esito | Dove / come |
|---|---|---|---|
| 1 | Parola di risveglio «Jarvis» (regex sul testo trascritto, varianti, primo risveglio = briefing, ≥3 parole = domanda) | Migliorata | `public/classic/classic.js`: parole **«Jarvis» e «Costructo»** (configurabili), stesse varianti più quelle di «Costructo», stesso comportamento. Su iPhone/iPad: «premi e parla» + Comando rapido Siri (istruzioni nelle Impostazioni) |
| 2 | Standby dopo 45 s e frasi «a dopo», «standby», «buonanotte»… | Conservata | `classic.js` (stessa regola e stesse frasi) |
| 3 | Riconoscimento vocale: Web Speech continuo; riserva Whisper locale | Conservata / Sostituita | `public/voce.js` `Ascolto`: Web Speech continuo (Classic) o a richiesta (PWA). Whisper/Python **non** portato (decisione: riconoscimento del browser + tastiera di riserva) |
| 4 | Filtri sull'input (frasi corte, confidenza < 0,35, ripetute entro 4 s) | Conservata | `classic.js` `handleFinal` |
| 5 | Anti-eco (abort mentre parla, somiglianza > 50 %) | Conservata | `voce.js` `Ascolto.silenzia` + `classic.js` `looksLikeEcho` |
| 6 | Interruzione «stop» (stop, basta, fermati, zitto, silenzio, aspetta, jarvis) | Conservata | `classic.js` (anche con la parola di risveglio); nella PWA il pulsante Parla interrompe la voce |
| 7 | Risposte vocali: ElevenLabs → edge-tts → voce del browser | Sostituita | Decisione di Luigi: **voci del dispositivo** (`speechSynthesis`, `voce.js`). ElevenLabs presente come opzione **spenta** (impostazioni). edge-tts non portato (servizio non ufficiale) |
| 8 | Cache della voce su disco | Sostituita | Non serve con le voci del dispositivo (nessun costo, nessun file) |
| 9 | Lettura a frasi in streaming (min. 20 caratteri) | Conservata | `voce.js` `divisoreFrasi` (stessa logica), usata da PWA e Classic |
| 10 | AI con OpenAI (Responses API, streaming, giri di strumenti) | Sostituita | Decisione di Luigi: **Claude** (`src/cervello/anthropic.ts`): Haiku 5.5, Sonnet 5.5 con «pensaci bene», streaming, massimo 5 passi |
| 11 | AI gratis (FreeLLMAPI) con «chip» del cervello | Sostituita | Decisione di Luigi: **niente cervello gratis**. Il chip resta (`#brainChip` della Classic, nota sotto le risposte nella PWA) e mostra il modello usato |
| 12 | Timeout di 15 s e ripiego | Sostituita | Ritentativi dell'SDK Anthropic (2) e messaggio chiaro se Claude non risponde |
| 13 | Strumenti `add_event`, `delete_event`, `save_memory`, `show_number` | Migliorata | `src/strumenti.ts`: `agenda_aggiungi`, `agenda_cancella` (**chiede quale** se più impegni corrispondono), `ricordo_salva` (spazio privato/lavoro), `mostra_numero`; più `agenda_elenca`, `ricordi_leggi`, `calendario_leggi`, strumenti Costructo. Permessi e registro |
| 14 | Messaggi di errore parlati | Conservata | `assistente.ts` e `classic.js` (cervello non disponibile, rete, tetto di spesa, rifiuto) |
| 15 | Calendario iCal in sola lettura (ricorrenze comuni) | Migliorata | `src/calendario.ts`: aggiunti «2° martedì» (BYDAY con ordinale), BYMONTHDAY, BYSETPOS, fusi di Windows/Outlook; **blocco SSRF**, limite 2 MB, cache per link. Scrittura su iCloud: Fase 2 |
| 16 | Aggiunta/cancellazione impegni solo in locale | Conservata | `src/agenda.ts` (SQLite, fuso di Luigi invece di quello del server) |
| 17 | Memoria leggibile `JARVIS-MEMORIA.md` (fatti, ultima conversazione, cervelli usati) | Migliorata | `src/memorie.ts`: divisa **PRIVATO / LAVORO**, pagina «Cosa sa di me» con correggi, sposta, cancella; **esportabile** come `JARVIS-MEMORIA.md`. Le ultime battute stanno nelle conversazioni (30 giorni); i cervelli usati in «Spesa del mese» e nel registro |
| 18 | Calcolatrice istantanea senza eval | Conservata | `src/calcolo.ts` (stesso parser, più virgole e «Costructo» tra le parole ignorate); scheda «RISULTATO» |
| 19 | Briefing (saluto, impegni di oggi, 7 giorni, schede numeriche) | Migliorata | `src/briefing.ts`: impegni privati e di lavoro, cantieri, scadenze, documenti in scadenza, fatture da incassare, meteo facoltativo; «Adesso» con 3 cose; notifica push al mattino |
| 20 | 11 frasi di personalità («signore» fisso) | Migliorata | `public/classic/frasi.js`: stesse 11 frasi, il modo di chiamare Luigi viene dalle impostazioni; la «diagnostica» mostra la spesa vera |
| 21 | Modalità registrazione (J) | Conservata | `classic.js` |
| 22 | Tasti F, T, W, R, J, D, Esc; pulsanti PAUSA e SCHERMO INTERO | Conservata | `classic.js` e `classic.html` (più il pulsante APP per tornare alla PWA) |
| 23 | Pagina CONFIGURA (chiavi in chiaro in `secrets.json`) | Migliorata | Pagina **Impostazioni**: tetto, voce, parole di risveglio, briefing, tema, Costructo, iCal. Le chiavi AI stanno solo nelle variabili d'ambiente; token e link **cifrati** e mai mostrati |
| 24 | Modalità LAN senza password | Sostituita | Accesso da ovunque con **https, password e secondo fattore** |
| 25 | Grafica 3D (three.js: particelle, anelli, rete neurale, etichette) | Conservata | `public/classic/scena3d.js` (copiata senza modifiche); `three` 0.187.0 da installare. Ripiego **2D** funzionante (`scena2d.js`), usato anche per la sfera della PWA |
| 26 | Musica `theme.mp3` | Sostituita | **Non copiata** (licenza sconosciuta). Il codice della musica c'è: si attiva mettendo un brano con licenza in `public/classic/musica.mp3` |
| 27 | Effetti sonori generati con WebAudio | Conservata | `public/classic/suoni.js` (copiati) |
| 28 | Pannello diagnostica (D) | Conservata | `classic.html` (più la riga GRAFICA: 3D o 2D) |
| 29 | Installazione `setup.mjs` (npm, venv Python, edge-tts, Whisper) | Sostituita | `npm install` + `npm run crea-utente`; niente Python |
| 30 | Servizio vocale Python (`/tts`, `/transcribe`) | Sostituita | Non serve: voce e ascolto del dispositivo |

## Funzioni dichiarate dall'originale ma non (o solo in parte) nel codice

| Dichiarazione originale | In COSTRUCTO J.A.R.V.I.S. |
|---|---|
| «Ignora i rumori della stanza» | Stessi filtri euristici (n. 4–5) più `noiseSuppression` del microfono; nessun modello del rumore |
| «Gestisce l'agenda a voce» | Agenda locale a voce (come l'originale) + lettura dell'agenda di Costructo e del calendario; scrittura vera sui calendari: Fase 2 |
| «Tutto resta sul tuo computer» | Detto onestamente in `docs/SICUREZZA.md`: le domande vanno a Claude, l'audio al servizio vocale del browser |
| Meteo, notizie, notifiche, multiutente, app per telefono | Meteo dei cantieri (facoltativo) e notifiche: **fatti**. App per telefono: PWA installabile. Notizie e multiutente: non previsti |

**Nessuna funzione originale è persa.** Le differenze sono scelte di Luigi (Claude al posto di OpenAI/FreeLLMAPI,
voci del dispositivo) o limiti di Apple (nessun ascolto in sottofondo su iPhone: «premi e parla» + Siri).

## Fase 2: conservazione dei dati delle mail

Non è una funzione dell'originale (che non leggeva la posta), ma vale la stessa regola delle conversazioni:
**i dati delle mail restano in Jarvis al massimo 30 giorni**. La pulizia ogni 6 ore (`pulisciPostaVecchia` in
`src/posta/archivio.ts`, chiamata da `src/server.ts`) cancella le mail salvate (intestazioni, testo breve di 4 KB,
nomi degli allegati, riassunto, urgenza), le bozze e le tracce delle conferme automatiche più vecchie di 30 giorni.
Le mail **sul server di posta** non vengono mai toccate: Jarvis non le cancella, non le sposta e non le segna come lette.
Togliendo una casella dalle Impostazioni si cancellano subito anche le sue mail e bozze salvate in Jarvis.

## Fase 3: conservazione dei dati di WhatsApp

Come per la posta: **i dati di WhatsApp restano in Jarvis al massimo 30 giorni**. La pulizia ogni 6 ore
(`pulisciWhatsappVecchio` in `src/whatsapp/archivio.ts`, chiamata da `src/server.ts`) cancella i messaggi salvati (testo breve
di 4 KB, dati degli allegati, riassunti, urgenza), le risposte proposte o mandate, le domande «Di quale azienda è…?» e le
tracce delle conferme automatiche più vecchie di 30 giorni, e i contatti rimasti senza messaggi. Resta solo la **scelta di
Luigi** sull'azienda di un contatto (come un ricordo), finché non la cambia. I messaggi **sul telefono** non vengono mai
toccati: Jarvis non li cancella e non li segna come letti.
