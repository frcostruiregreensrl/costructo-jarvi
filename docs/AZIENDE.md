# Più aziende in Costructo

## Autorizzazione di Luigi

**18/11/2026**: «Autorizzo il 18/11/2026 la modifica «Jarvis legge più aziende» in costructo-jarvi, con commit,
push del ramo e apertura della PR, senza merge.» Ramo: `fase1b/piu-aziende`.

## Perché

Luigi ha due aziende. In Costructo ogni token `csa_…` appartiene a **una sola** azienda.
Luigi vuole: due token in Jarvis; al mattino un briefing e una notifica per ogni azienda; che Jarvis dica sempre
di quale azienda parla; e che, quando non è chiaro, Jarvis **chieda** «Di quale azienda parli?» invece di indovinare.
Serve anche alla prossima fase WhatsApp: un messaggio che arriva va attribuito a un'azienda, oppure Jarvis chiede.

## Come si usa

Impostazioni → «Collegamento a Costructo»:

1. scrivi l'**indirizzo di Costructo** (uno solo per tutte le aziende);
2. in «Aggiungi il token di un'altra azienda (csa_…)» incolla il token e premi **Aggiungi**:
   Jarvis chiede a Costructo di chi è il token (`GET /api/assistente/v1/io`) e salva il **nome dell'azienda**.
   Se Costructo non accetta il token, Jarvis non lo salva e lo dice;
3. ripeti per l'altra azienda (al massimo **5**);
4. **Prova il collegamento** prova tutte le aziende e dà l'esito di ognuna;
5. **Rimuovi** (con conferma) scollega un'azienda: il token viene cancellato da Jarvis, in Costructo resta.

Jarvis rifiuta lo stesso token due volte e la stessa azienda due volte (stesso id di Costructo).

## Chi aveva già un solo token

Niente da fare: il vecchio token (salvato dalle Impostazioni o nella variabile `COSTRUCTO_TOKEN`) vale come
**prima azienda** («Azienda principale» finché Jarvis non ne legge il nome con «Prova il collegamento»).
Quando aggiungi la seconda azienda, il vecchio token entra nell'elenco con il suo nome e il vecchio segreto viene
tolto. Se il token stava in `COSTRUCTO_TOKEN` e lo rimuovi dalle Impostazioni, non ricompare: puoi togliere
anche la variabile dal server.

## Cosa cambia per Jarvis

- **Strumenti di Costructo** (briefing, agenda, scadenze, documenti in scadenza, cantieri, ricerca): hanno il campo
  `azienda`. Con una sola azienda si usa quella. Con più aziende:
  - se Luigi nomina l'azienda (anche solo una parte del nome, per esempio «Rossi»), Jarvis legge solo quella;
  - se il nome non corrisponde a nessuna azienda, o a più di una, Jarvis **non legge niente** e chiede
    «Di quale azienda parli: Edilgreen o Rossi Costruzioni?»;
  - se Luigi non dice l'azienda, Jarvis legge **tutte** le aziende e ogni dato porta il nome della sua azienda.
    Se un'azienda non risponde, i dati delle altre arrivano lo stesso, con l'errore di quella che manca.
- **Prompt**: Jarvis dice sempre di quale azienda è ogni informazione, non somma numeri di aziende diverse senza
  dirlo e, quando la richiesta non è chiara, chiede prima di agire (per pagamenti e fatture anche il documento).
  I nomi delle aziende arrivano nel messaggio del turno, **marcati come dati** (non nel prompt di sistema).
- **Briefing**: la parte di lavoro è divisa per azienda e ogni frase inizia con il nome
  («Edilgreen: 3 cantieri aperti, 1 scadenza in arrivo…»). La parte privata resta una sola.
  In «Adesso» ogni cosa di lavoro dice di quale azienda è, e ogni azienda ha il suo posto.
- **Notifiche del mattino**: una notifica **per ogni azienda** (titolo e testo iniziano con il nome) e una in più
  solo se oggi c'è qualcosa di privato. Con una sola azienda, una notifica come prima.
  Partono tutte insieme **una sola volta al giorno**.

## API (tutte con accesso, controllo Origin e registro)

| Rotta | Cosa fa |
|---|---|
| `GET /api/collegamenti/aziende` | elenco: `id`, `nome`, `token` **mascherato** |
| `POST /api/collegamenti/aziende` `{token, nome?}` | aggiunge un'azienda (prima chiede `/io` a Costructo) |
| `PATCH /api/collegamenti/aziende/:id` `{nome}` | cambia il nome mostrato |
| `DELETE /api/collegamenti/aziende/:id` | scollega l'azienda |
| `POST /api/collegamenti/costructo/prova` | prova tutte le aziende: `{ok, messaggio, aziende: [{id, nome, ok, messaggio}]}` |
| `PUT /api/collegamenti` | indirizzo di Costructo e link iCal; il vecchio campo `costructoToken` vale solo finché non ci sono aziende nell'elenco |

`GET /api/impostazioni` restituisce in `collegamenti.aziende` lo stesso elenco mascherato.

## Dati salvati

Segreto cifrato `costructo_aziende` (AES-256-GCM con `JARVIS_CHIAVE_CIFRATURA`): elenco JSON di
`{ id, nome, token, aziendaId }`. I token non tornano mai al browser e non finiscono nel registro.
Codice: `src/aziende.ts`. Test: `test/aziende.test.ts`.
