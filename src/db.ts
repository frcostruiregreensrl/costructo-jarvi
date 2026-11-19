// Database SQLite di Jarvis. Un solo file (data/jarvis.db), un solo utente (Luigi).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/** Testo cercabile di un messaggio WhatsApp: testo, didascalia e nome del file (Fase 3b, ricerca unica). */
const TESTO_WA = (r: string) => `${r}.testo || ' ' || CASE WHEN json_valid(${r}.media) THEN coalesce(json_extract(${r}.media, '$.didascalia'), '') || ' ' || coalesce(json_extract(${r}.media, '$.nomeFile'), '') ELSE '' END`;
/** Testo cercabile di una mail: oggetto, mittente, testo breve e riassunto. */
const TESTO_POSTA = (r: string) => `${r}.oggetto || ' ' || ${r}.da_nome || ' ' || ${r}.da_indirizzo || ' ' || ${r}.estratto || ' ' || ${r}.riassunto`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS utente (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nome TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_segreto TEXT NOT NULL,          -- cifrato con la chiave d'ambiente
  totp_ultimo_passo INTEGER NOT NULL DEFAULT 0,
  creato TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessioni (
  id TEXT PRIMARY KEY,                 -- hash SHA-256 del token del cookie
  creata INTEGER NOT NULL,
  scade INTEGER NOT NULL,
  ultimo_uso INTEGER NOT NULL,
  dispositivo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tentativi (
  chiave TEXT PRIMARY KEY,
  conteggio INTEGER NOT NULL,
  inizio INTEGER NOT NULL,
  bloccato_fino INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversazioni (
  id TEXT PRIMARY KEY,
  spazio TEXT NOT NULL CHECK (spazio IN ('privato','lavoro','tutto')),
  creata INTEGER NOT NULL,
  aggiornata INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messaggi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversazione_id TEXT NOT NULL REFERENCES conversazioni(id) ON DELETE CASCADE,
  ruolo TEXT NOT NULL CHECK (ruolo IN ('utente','jarvis')),
  testo TEXT NOT NULL,
  creato INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messaggi_conv ON messaggi(conversazione_id, id);
CREATE TABLE IF NOT EXISTS memorie (
  id TEXT PRIMARY KEY,
  spazio TEXT NOT NULL CHECK (spazio IN ('privato','lavoro')),
  testo TEXT NOT NULL,
  origine TEXT NOT NULL,               -- 'luigi' (scritta a mano) | 'jarvis' (salvata in conversazione)
  creato INTEGER NOT NULL,
  aggiornato INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS impegni (
  id TEXT PRIMARY KEY,
  titolo TEXT NOT NULL,
  inizio INTEGER NOT NULL,             -- millisecondi UTC
  minuti INTEGER NOT NULL DEFAULT 60,
  tutto_il_giorno INTEGER NOT NULL DEFAULT 0,
  creato INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registro (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quando INTEGER NOT NULL,
  azione TEXT NOT NULL,
  esito TEXT NOT NULL CHECK (esito IN ('fatto','negato','errore','richiesta_conferma')),
  origine TEXT NOT NULL,               -- 'luigi' | 'jarvis' | 'sistema'
  dettagli TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS consumi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quando INTEGER NOT NULL,
  mese TEXT NOT NULL,
  modello TEXT NOT NULL,
  token_ingresso INTEGER NOT NULL,
  token_uscita INTEGER NOT NULL,
  token_cache_lettura INTEGER NOT NULL DEFAULT 0,
  token_cache_scrittura INTEGER NOT NULL DEFAULT 0,
  costo_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS consumi_mese ON consumi(mese);
CREATE TABLE IF NOT EXISTS impostazioni (
  chiave TEXT PRIMARY KEY,
  valore TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segreti (
  nome TEXT PRIMARY KEY,
  valore TEXT NOT NULL                 -- sempre cifrato
);
CREATE TABLE IF NOT EXISTS conferme (
  id TEXT PRIMARY KEY,
  conversazione_id TEXT NOT NULL,
  creata INTEGER NOT NULL,
  azione TEXT NOT NULL,
  dati TEXT NOT NULL,
  stato TEXT NOT NULL DEFAULT 'in_attesa' CHECK (stato IN ('in_attesa','confermata','annullata','scaduta'))
);
CREATE TABLE IF NOT EXISTS iscrizioni_push (
  endpoint TEXT PRIMARY KEY,
  dati TEXT NOT NULL,
  creata INTEGER NOT NULL
);

-- Fase 2: posta. Le caselle (con le password) stanno nel segreto cifrato «posta_caselle».
-- Qui solo lo stato della lettura e i dati delle mail, tenuti al massimo 30 giorni.
CREATE TABLE IF NOT EXISTS posta_stato (
  casella_id TEXT PRIMARY KEY,
  uid_validity TEXT NOT NULL DEFAULT '',
  ultimo_uid INTEGER NOT NULL DEFAULT 0,
  ultimo_controllo INTEGER NOT NULL DEFAULT 0,
  esito TEXT NOT NULL DEFAULT '',          -- '' | 'ok' | 'errore'
  messaggio TEXT NOT NULL DEFAULT '',
  ultima_notifica INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posta_messaggi (
  id TEXT PRIMARY KEY,
  casella_id TEXT NOT NULL,
  uid INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  riferimenti TEXT NOT NULL DEFAULT '',     -- References della mail, per la bozza di risposta
  da_nome TEXT NOT NULL DEFAULT '',
  da_indirizzo TEXT NOT NULL DEFAULT '',
  rispondi_a TEXT NOT NULL DEFAULT '',
  a TEXT NOT NULL DEFAULT '',
  oggetto TEXT NOT NULL DEFAULT '',
  data INTEGER NOT NULL,
  estratto TEXT NOT NULL DEFAULT '',        -- testo breve (al massimo 4 KB), senza HTML
  allegati TEXT NOT NULL DEFAULT '[]',      -- solo nomi e dimensioni
  segni TEXT NOT NULL DEFAULT '{}',         -- lista, automatico, no-reply, PEC (ricevute)
  spazio TEXT NOT NULL,                     -- id dell'azienda o 'privato' (dalla casella)
  stato TEXT NOT NULL DEFAULT 'da_classificare' CHECK (stato IN ('da_classificare','classificato','filtrato','tetto','errore')),
  riassunto TEXT NOT NULL DEFAULT '',
  urgente INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL DEFAULT '',
  tocca INTEGER NOT NULL DEFAULT 0,         -- parla di pagamenti, importi o impegni
  tentativi INTEGER NOT NULL DEFAULT 0,
  nuova INTEGER NOT NULL DEFAULT 0,         -- arrivata dopo il primo controllo (solo queste possono avere la conferma automatica)
  conferma_auto TEXT NOT NULL DEFAULT '',   -- '' | 'inviata' | 'saltata: motivo'
  notificata INTEGER NOT NULL DEFAULT 0,
  salvato INTEGER NOT NULL,
  UNIQUE (casella_id, uid_validity, uid)
);
CREATE INDEX IF NOT EXISTS posta_data ON posta_messaggi(data);
CREATE INDEX IF NOT EXISTS posta_stato_idx ON posta_messaggi(stato);
CREATE TABLE IF NOT EXISTS posta_bozze (
  id TEXT PRIMARY KEY,
  messaggio_id TEXT NOT NULL,
  casella_id TEXT NOT NULL,
  a TEXT NOT NULL,
  oggetto TEXT NOT NULL,
  testo TEXT NOT NULL,
  creata INTEGER NOT NULL,
  stato TEXT NOT NULL CHECK (stato IN ('salvata','in_bozze','errore')),
  dettaglio TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS posta_risposte_auto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  casella_id TEXT NOT NULL,
  mittente TEXT NOT NULL,                   -- impronta dell'indirizzo (non l'indirizzo)
  dominio TEXT NOT NULL,
  quando INTEGER NOT NULL
);

-- Fase 3: WhatsApp (parte 1, senza collegamento reale). Il collegamento (token, segreto dell'app…)
-- sta nel segreto cifrato «whatsapp». Qui contatti, messaggi (testo breve, al massimo 4 KB, 30 giorni),
-- risposte in attesa di conferma, conferme automatiche e domande «di quale azienda è?».
-- I numeri di telefono sono dati personali: non vanno mai interi nel registro né nelle notifiche.
CREATE TABLE IF NOT EXISTS wa_contatti (
  id TEXT PRIMARY KEY,
  chiave TEXT NOT NULL UNIQUE,              -- numero WhatsApp (solo cifre) oppure «u:» + id utente di WhatsApp (BSUID)
  wa_id TEXT NOT NULL DEFAULT '',           -- numero (solo cifre, con il prefisso del paese), '' se WhatsApp non lo dà
  user_id TEXT NOT NULL DEFAULT '',         -- id utente di WhatsApp per questa azienda (BSUID)
  nome_profilo TEXT NOT NULL DEFAULT '',    -- nome che il contatto si è dato su WhatsApp
  nome_rubrica TEXT NOT NULL DEFAULT '',    -- nome nella rubrica dell'app WhatsApp Business di Luigi
  gruppo INTEGER NOT NULL DEFAULT 0,        -- 1 = chat di gruppo (mai conferme automatiche, mai risposte)
  spazio TEXT NOT NULL DEFAULT '',          -- '' = non si sa ancora | 'privato' | id dell'azienda
  fonte_spazio TEXT NOT NULL DEFAULT '',    -- '' | 'luigi' (scelta di Luigi) | 'costructo' (numero trovato in Costructo)
  proposta_spazio TEXT NOT NULL DEFAULT '', -- idea dell'AI dal contesto della chat: solo un suggerimento, mai una decisione
  ultima_notifica INTEGER NOT NULL DEFAULT 0,
  creato INTEGER NOT NULL,
  aggiornato INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_messaggi (
  id TEXT PRIMARY KEY,
  wamid TEXT NOT NULL UNIQUE,               -- id del messaggio di WhatsApp: lo stesso messaggio non si salva due volte
  contatto_id TEXT NOT NULL,
  gruppo_id TEXT NOT NULL DEFAULT '',
  direzione TEXT NOT NULL CHECK (direzione IN ('in','out','eco')), -- in = ricevuto, out = mandato da Jarvis, eco = scritto da Luigi dal telefono
  tipo TEXT NOT NULL,
  quando INTEGER NOT NULL,                  -- millisecondi (dall'orario di WhatsApp)
  ricevuto INTEGER NOT NULL,                -- quando è arrivato a Jarvis
  testo TEXT NOT NULL DEFAULT '',           -- testo breve, al massimo 4 KB
  media TEXT NOT NULL DEFAULT '{}',         -- solo i dati dell'allegato (tipo, mime, nome del file, didascalia, id): mai il contenuto
  storico INTEGER NOT NULL DEFAULT 0,       -- 1 = chat passata importata: niente notifiche, conferme o classificazione
  automatico INTEGER NOT NULL DEFAULT 0,    -- 1 = conferma di ricezione automatica di Jarvis (non vale come risposta di Luigi)
  stato_invio TEXT NOT NULL DEFAULT '',     -- per i messaggi mandati da Jarvis: sent, delivered, read, failed
  errore_invio TEXT NOT NULL DEFAULT '',
  revocato INTEGER NOT NULL DEFAULT 0,
  stato TEXT NOT NULL DEFAULT 'nessuno' CHECK (stato IN ('da_classificare','classificato','filtrato','tetto','errore','nessuno')),
  riassunto TEXT NOT NULL DEFAULT '',
  urgente INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL DEFAULT '',
  tocca INTEGER NOT NULL DEFAULT 0,         -- parla di pagamenti, importi o impegni
  tentativi INTEGER NOT NULL DEFAULT 0,
  notificata INTEGER NOT NULL DEFAULT 0,
  conferma_auto TEXT NOT NULL DEFAULT ''    -- '' | 'inviata' | 'saltata: motivo'
);
CREATE INDEX IF NOT EXISTS wa_messaggi_contatto ON wa_messaggi(contatto_id, quando);
CREATE INDEX IF NOT EXISTS wa_messaggi_stato ON wa_messaggi(stato);
CREATE TABLE IF NOT EXISTS wa_risposte (
  id TEXT PRIMARY KEY,
  contatto_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('risposta','richiesta_documento')),
  testo TEXT NOT NULL,
  creata INTEGER NOT NULL,
  stato TEXT NOT NULL CHECK (stato IN ('proposta','bozza','in_invio','inviata','errore','incerto','scartata')), -- incerto = non si sa se è partito
  wamid TEXT NOT NULL DEFAULT '',
  esito TEXT NOT NULL DEFAULT '',           -- sent, delivered, read, failed (dal webhook) o messaggio d'errore in italiano
  inviata INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_conferme_auto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contatto_id TEXT NOT NULL,
  quando INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_domande (
  id TEXT PRIMARY KEY,
  contatto_id TEXT NOT NULL,
  creata INTEGER NOT NULL,
  stato TEXT NOT NULL CHECK (stato IN ('aperta','risposta')),
  risposta TEXT NOT NULL DEFAULT '',
  notificata INTEGER NOT NULL DEFAULT 0
);

-- Fase 3b: le 20 funzioni WhatsApp. Jarvis NON scrive mai record definitivi in Costructo: prepara PROPOSTE
-- (bozze innocue) che Luigi conferma qui e poi approva in Costructo. Tutto si cancella dopo 30 giorni,
-- tranne le scelte di Luigi (operaio di un contatto, chat escluse).
CREATE TABLE IF NOT EXISTS proposte (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,                       -- ore, foto, rinnovo_documento, … oppure agenda_privata (resta in Jarvis)
  azienda_id TEXT NOT NULL,                 -- id dell'azienda in Jarvis (un token) oppure 'privato'
  chiave_doppione TEXT NOT NULL UNIQUE,     -- deterministica (es. wa:<id del messaggio>:ore): la stessa proposta non nasce due volte
  origine TEXT NOT NULL CHECK (origine IN ('whatsapp','email','jarvis')),
  rif_esterno TEXT NOT NULL DEFAULT '',
  titolo TEXT NOT NULL,
  dati TEXT NOT NULL DEFAULT '{}',          -- JSON (controllato con zod prima dell'invio)
  allegati TEXT NOT NULL DEFAULT '[]',      -- JSON: solo i riferimenti agli allegati salvati (wa_allegati)
  avvisi TEXT NOT NULL DEFAULT '[]',        -- note solo per Luigi (differenze, campi mancanti): non vanno a Costructo
  contatto_id TEXT NOT NULL DEFAULT '',
  messaggio_id TEXT NOT NULL DEFAULT '',
  stato TEXT NOT NULL CHECK (stato IN ('da_confermare','in_invio','inviata','gia_presente','attesa_costructo','errore','scartata')),
  esito TEXT NOT NULL DEFAULT '',
  id_costructo TEXT NOT NULL DEFAULT '',
  stato_costructo TEXT NOT NULL DEFAULT '', -- in_attesa | accettata | scartata | superata
  motivo_costructo TEXT NOT NULL DEFAULT '',
  deciso_il TEXT NOT NULL DEFAULT '',
  automatica INTEGER NOT NULL DEFAULT 0,
  creata INTEGER NOT NULL,
  aggiornata INTEGER NOT NULL,
  inviata INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS proposte_stato ON proposte(stato, creata);
-- Foto e PDF scaricati da WhatsApp (solo con l'interruttore acceso, solo per i contatti delle aziende). Mai l'audio.
CREATE TABLE IF NOT EXISTS wa_allegati (
  id TEXT PRIMARY KEY,
  messaggio_id TEXT NOT NULL UNIQUE,
  contatto_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  nome TEXT NOT NULL,
  dimensione INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  dati BLOB NOT NULL,
  scaricato INTEGER NOT NULL
);
-- Analisi dei messaggi per le funzioni (una riga per messaggio: si analizza una volta sola).
CREATE TABLE IF NOT EXISTS wa_analisi (
  messaggio_id TEXT PRIMARY KEY,
  stato TEXT NOT NULL,                      -- fatta | attesa (contatto da assegnare, operaio da chiarire) | scaduta
  azienda_id TEXT NOT NULL DEFAULT '',
  cantiere_id TEXT NOT NULL DEFAULT '',
  cantiere_nome TEXT NOT NULL DEFAULT '',
  esito TEXT NOT NULL DEFAULT '{}',
  quando INTEGER NOT NULL
);
-- Stato degli allegati e dei vocali (scaricato, trascritto, spento, errore). L'audio non si salva mai: della trascrizione resta solo il testo, nel messaggio.
CREATE TABLE IF NOT EXISTS wa_media_stato (
  messaggio_id TEXT PRIMARY KEY,
  stato TEXT NOT NULL,                      -- trascritto | spenta | scaricato | errore | tetto | formato | troppo_grande
  fornitore TEXT NOT NULL DEFAULT '',
  secondi REAL NOT NULL DEFAULT 0,
  quando INTEGER NOT NULL
);
-- Chi è un contatto WhatsApp tra gli operai di Costructo (in Costructo gli operai non hanno il telefono).
-- Scelta di Luigi, PER AZIENDA (un operaio di un'azienda non vale per l'altra): si ricorda. operaio_id '' = «non è un operaio».
CREATE TABLE IF NOT EXISTS wa_operai (
  contatto_id TEXT NOT NULL,
  azienda_id TEXT NOT NULL,
  operaio_id TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  scelto INTEGER NOT NULL,
  PRIMARY KEY (contatto_id, azienda_id)
);
CREATE TABLE IF NOT EXISTS wa_domande_operaio (
  id TEXT PRIMARY KEY,
  contatto_id TEXT NOT NULL,
  azienda_id TEXT NOT NULL,
  creata INTEGER NOT NULL,
  stato TEXT NOT NULL CHECK (stato IN ('aperta','risposta'))
);
-- Promesse scritte da Luigi in chat («ti mando il preventivo domani»).
CREATE TABLE IF NOT EXISTS promesse (
  id TEXT PRIMARY KEY,
  contatto_id TEXT NOT NULL,
  messaggio_id TEXT NOT NULL UNIQUE,
  cosa TEXT NOT NULL,                       -- la promessa intera, come l'ha scritta Luigi
  chiave TEXT NOT NULL DEFAULT '',          -- la cosa promessa (per capire quando è mantenuta)
  scadenza INTEGER NOT NULL,
  stato TEXT NOT NULL CHECK (stato IN ('aperta','mantenuta','chiusa')),
  creata INTEGER NOT NULL
);
-- Scontrini: solo in Jarvis (Prima Nota esclusa finché Luigi non decide).
CREATE TABLE IF NOT EXISTS scontrini (
  id TEXT PRIMARY KEY,
  messaggio_id TEXT NOT NULL UNIQUE,
  contatto_id TEXT NOT NULL,
  spazio TEXT NOT NULL,
  descrizione TEXT NOT NULL DEFAULT '',
  allegato_id TEXT NOT NULL DEFAULT '',
  creato INTEGER NOT NULL
);
-- Fase 3 parte 2: messaggi mandati da Jarvis con la API di WhatsApp, per mese e tipo (risposta, conferma, modello).
-- Servono al contatore di «Spesa del mese» e al tetto mensile. I messaggi che Luigi scrive dal telefono non ci sono.
CREATE TABLE IF NOT EXISTS wa_invii_api (
  mese TEXT NOT NULL,
  tipo TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mese, tipo)
);
-- Ricerca unica (FTS5) sui messaggi e sulle mail salvati. Le righe seguono i messaggi: quando un messaggio si
-- cancella (30 giorni), sparisce anche dall'indice.
CREATE VIRTUAL TABLE IF NOT EXISTS cerca_wa USING fts5(testo, rif UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS cerca_posta USING fts5(testo, rif UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS cerca_wa_nuovo AFTER INSERT ON wa_messaggi BEGIN
  INSERT INTO cerca_wa (testo, rif) VALUES (${TESTO_WA("new")}, new.id);
END;
CREATE TRIGGER IF NOT EXISTS cerca_wa_cambio AFTER UPDATE OF testo, media ON wa_messaggi BEGIN
  DELETE FROM cerca_wa WHERE rif = old.id;
  INSERT INTO cerca_wa (testo, rif) VALUES (${TESTO_WA("new")}, new.id);
END;
CREATE TRIGGER IF NOT EXISTS cerca_wa_via AFTER DELETE ON wa_messaggi BEGIN
  DELETE FROM cerca_wa WHERE rif = old.id;
END;
CREATE TRIGGER IF NOT EXISTS cerca_posta_nuovo AFTER INSERT ON posta_messaggi BEGIN
  INSERT INTO cerca_posta (testo, rif) VALUES (${TESTO_POSTA("new")}, new.id);
END;
CREATE TRIGGER IF NOT EXISTS cerca_posta_cambio AFTER UPDATE OF riassunto, estratto ON posta_messaggi BEGIN
  DELETE FROM cerca_posta WHERE rif = old.id;
  INSERT INTO cerca_posta (testo, rif) VALUES (${TESTO_POSTA("new")}, new.id);
END;
CREATE TRIGGER IF NOT EXISTS cerca_posta_via AFTER DELETE ON posta_messaggi BEGIN
  DELETE FROM cerca_posta WHERE rif = old.id;
END;
`;

export function apriDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Fase 3b: quello che si cancella (dopo 30 giorni o a richiesta) viene sovrascritto anche nel file.
  db.pragma("secure_delete = ON");
  db.exec(SCHEMA);
  // Indice di ricerca per i messaggi e le mail salvati prima della Fase 3b (una volta sola: poi ci pensano i trigger).
  db.exec(`INSERT INTO cerca_wa (testo, rif) SELECT ${TESTO_WA("m")}, m.id FROM wa_messaggi m WHERE m.id NOT IN (SELECT rif FROM cerca_wa)`);
  db.exec(`INSERT INTO cerca_posta (testo, rif) SELECT ${TESTO_POSTA("m")}, m.id FROM posta_messaggi m WHERE m.id NOT IN (SELECT rif FROM cerca_posta)`);
  return db;
}
