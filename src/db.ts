// Database SQLite di Jarvis. Un solo file (data/jarvis.db), un solo utente (Luigi).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

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
`;

export function apriDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
