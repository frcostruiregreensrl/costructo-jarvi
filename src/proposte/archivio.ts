// Archivio delle proposte in Jarvis: nascono qui (da WhatsApp, dalla posta o da Luigi), si mostrano per intero,
// si correggono, si confermano. La chiave doppione è deterministica: la stessa proposta non nasce mai due volte.
// Al massimo 30 giorni, come i messaggi da cui nascono.
import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { CONSERVAZIONE_MS } from "../conversazioni.js";
import { registra } from "../registro.js";
import { improntaConferma } from "../sicurezza/testoConfermato.js";
import { mascheraTelefono } from "../whatsapp/telefono.js";
import {
  CAMPI, ErroreProposte, MAX_CHIAVE, MAX_TITOLO, NOMI_TIPI, PRIVATO, SCHEMI_DATI, vaACostructo,
  type RiferimentoAllegato, type RigaProposta, type StatoProposta, type TipoProposta,
} from "./tipi.js";

export const nuovoIdProposta = () => `p${randomBytes(6).toString("hex")}`;

/** Note per Luigi (non vanno a Costructo) e nomi da mostrare per gli id (cantiere, operaio…). */
export interface Extra { note: string[]; nomi: Record<string, string> }

export function extraDi(p: Pick<RigaProposta, "avvisi">): Extra {
  try {
    const x = JSON.parse(p.avvisi) as Partial<Extra>;
    return { note: Array.isArray(x.note) ? x.note.map(String).slice(0, 20) : [], nomi: x.nomi && typeof x.nomi === "object" ? (x.nomi as Record<string, string>) : {} };
  } catch { return { note: [], nomi: {} }; }
}
export const datiDi = (p: Pick<RigaProposta, "dati">): Record<string, unknown> => { try { return JSON.parse(p.dati) as Record<string, unknown>; } catch { return {}; } };
export const allegatiDi = (p: Pick<RigaProposta, "allegati">): RiferimentoAllegato[] => { try { return JSON.parse(p.allegati) as RiferimentoAllegato[]; } catch { return []; } };

/** Nome dell'azienda (o «Privato»). */
export type NomeAzienda = (id: string) => string;

export interface NuovaProposta {
  tipo: TipoProposta;
  aziendaId: string;
  chiave: string;
  origine?: "whatsapp" | "email" | "jarvis";
  rifEsterno?: string;
  titolo: string;
  dati: Record<string, unknown>;
  allegati?: RiferimentoAllegato[];
  note?: string[];
  nomi?: Record<string, string>;
  contattoId?: string;
  messaggioId?: string;
}

/** Toglie i campi vuoti (stringhe vuote, undefined, null): restano solo i dati veri. */
export function pulisciDati(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/**
 * Crea la proposta (stato «da confermare»). Se la chiave doppione c'è già, restituisce quella esistente e non crea niente.
 * Una proposta privata (agenda privata) non può essere di un'azienda, e una per Costructo non può essere privata.
 */
export function creaProposta(db: Db, n: NuovaProposta, ora = Date.now()): { proposta: RigaProposta; nuova: boolean } {
  const chiave = n.chiave.slice(0, MAX_CHIAVE);
  const gia = db.prepare("SELECT * FROM proposte WHERE chiave_doppione = ?").get(chiave) as RigaProposta | undefined;
  if (gia) return { proposta: gia, nuova: false };
  if (vaACostructo(n.tipo) && n.aziendaId === PRIVATO) throw new ErroreProposte("Le cose private non vanno in Costructo.");
  if (!vaACostructo(n.tipo) && n.aziendaId !== PRIVATO) throw new ErroreProposte("Questa proposta resta nell'agenda privata di Jarvis.");
  const id = nuovoIdProposta();
  const extra: Extra = { note: (n.note ?? []).slice(0, 20), nomi: n.nomi ?? {} };
  db.prepare(`INSERT INTO proposte (id, tipo, azienda_id, chiave_doppione, origine, rif_esterno, titolo, dati, allegati, avvisi, contatto_id, messaggio_id, stato, creata, aggiornata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'da_confermare', ?, ?)`)
    .run(id, n.tipo, n.aziendaId, chiave, n.origine ?? "whatsapp", (n.rifEsterno ?? "").slice(0, 200), n.titolo.replace(/\s+/g, " ").trim().slice(0, MAX_TITOLO) || NOMI_TIPI[n.tipo],
      JSON.stringify(pulisciDati(n.dati)), JSON.stringify((n.allegati ?? []).slice(0, 5)), JSON.stringify(extra), n.contattoId ?? "", n.messaggioId ?? "", ora, ora);
  // Nel registro: tipo, azienda, chiave. Mai i testi dei messaggi.
  registra(db, "proposta.prepara", "fatto", "jarvis", { proposta: id, tipo: n.tipo, azienda: n.aziendaId, chiave: chiave.slice(0, 60) });
  return { proposta: leggiProposta(db, id)!, nuova: true };
}

export function leggiProposta(db: Db, id: string): RigaProposta | undefined {
  return db.prepare("SELECT * FROM proposte WHERE id = ?").get(id) as RigaProposta | undefined;
}

/** Aziende (o privato) visibili nella scheda: Privato → solo privato; Lavoro → solo aziende; Tutto → entrambi. */
export function proposteVisibili(db: Db, vista: "privato" | "lavoro" | "tutto", stati?: StatoProposta[], limite = 200): RigaProposta[] {
  const dove: string[] = [];
  const valori: unknown[] = [];
  if (vista === "privato") { dove.push("azienda_id = ?"); valori.push(PRIVATO); }
  if (vista === "lavoro") { dove.push("azienda_id <> ?"); valori.push(PRIVATO); }
  if (stati?.length) { dove.push(`stato IN (${stati.map(() => "?").join(",")})`); valori.push(...stati); }
  return db.prepare(`SELECT * FROM proposte ${dove.length ? `WHERE ${dove.join(" AND ")}` : ""} ORDER BY creata DESC LIMIT ?`).all(...valori, limite) as RigaProposta[];
}

/** Controllo con zod dei dati per il tipo. Restituisce i dati puliti oppure l'elenco di quello che manca. */
export function validaDati(tipo: TipoProposta, dati: Record<string, unknown>): { ok: true; dati: Record<string, unknown> } | { ok: false; mancano: string[] } {
  const v = SCHEMI_DATI[tipo].safeParse(pulisciDati(dati));
  if (v.success) return { ok: true, dati: v.data as Record<string, unknown> };
  const etichette = new Map(CAMPI[tipo].map((c) => [c.chiave, c.etichetta]));
  const mancano = [...new Set(v.error.issues.map((i) => {
    const k = String(i.path[0] ?? "");
    return k ? `${etichette.get(k) ?? k}${i.code === "invalid_type" && i.received === "undefined" ? "" : ` (${i.message})`}` : i.message;
  }))];
  return { ok: false, mancano };
}

const formatoValore = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x as object).join(" ") : String(x))).join("; ");
  if (v && typeof v === "object") return Object.entries(v as object).map(([k, x]) => `${k} ${String(x)}`).join(", ");
  return String(v);
};

/**
 * Il testo COMPLETO della proposta, come lo vede Luigi prima di confermare: azienda, tipo, titolo, ogni campo, gli allegati.
 * L'impronta della conferma è calcolata su questo testo: se cambia anche un solo campo, la conferma non vale più.
 */
export function testoCompleto(p: RigaProposta, nomeAzienda: NomeAzienda): string {
  const dati = datiDi(p);
  const { nomi, note } = extraDi(p);
  const righe = [
    `${vaACostructo(p.tipo) ? "Proposta per Costructo" : "Promemoria nell'agenda privata di Jarvis"} · ${nomeAzienda(p.azienda_id)}`,
    `Tipo: ${NOMI_TIPI[p.tipo] ?? p.tipo}`,
    `Titolo: ${p.titolo}`,
  ];
  for (const c of CAMPI[p.tipo] ?? []) {
    const v = dati[c.chiave];
    if (v === undefined || v === "") continue;
    const nome = nomi[c.chiave];
    righe.push(`${c.etichetta}: ${formatoValore(v)}${nome && nome !== String(v) ? ` (${nome})` : ""}`);
  }
  for (const [k, v] of Object.entries(dati)) if (!(CAMPI[p.tipo] ?? []).some((c) => c.chiave === k)) righe.push(`${k}: ${formatoValore(v)}`);
  const allegati = allegatiDi(p);
  if (allegati.length) righe.push(`Allegati: ${allegati.map((a) => `${a.nome} (${a.mime}, ${Math.ceil(a.dimensione / 1024)} KB)`).join(", ")}`);
  if (note.length) righe.push(`Note per te (non vanno a Costructo): ${note.join(" · ")}`);
  return righe.join("\n");
}

/** Impronta della conferma: azienda + tipo + chiave + testo completo. */
export function improntaProposta(p: RigaProposta, nomeAzienda: NomeAzienda): string {
  return improntaConferma(`proposta:${p.azienda_id}:${p.tipo}:${p.chiave_doppione}`, testoCompleto(p, nomeAzienda));
}

/** Luigi corregge i dati (solo finché non è partita): la proposta torna «da confermare» con una nuova impronta. */
export function correggiProposta(db: Db, id: string, modifiche: Record<string, unknown>, nomi: Record<string, string> = {}, ora = Date.now()): RigaProposta {
  const p = leggiProposta(db, id);
  if (!p) throw new ErroreProposte("Proposta non trovata.", 404);
  if (!["da_confermare", "errore", "attesa_costructo"].includes(p.stato)) throw new ErroreProposte("Questa proposta non si può più correggere.", 409);
  const ammessi = new Set((CAMPI[p.tipo] ?? []).filter((c) => c.tipo !== "sola_lettura").map((c) => c.chiave));
  const dati = { ...datiDi(p) };
  for (const [k, v] of Object.entries(modifiche)) {
    if (!ammessi.has(k)) throw new ErroreProposte(`Il campo «${k}» non si può cambiare qui.`);
    dati[k] = v;
  }
  const extra = extraDi(p);
  for (const [k, v] of Object.entries(nomi)) if (ammessi.has(k)) extra.nomi[k] = String(v).slice(0, 140);
  db.prepare("UPDATE proposte SET dati = ?, avvisi = ?, stato = 'da_confermare', aggiornata = ? WHERE id = ?").run(JSON.stringify(pulisciDati(dati)), JSON.stringify(extra), ora, id);
  registra(db, "proposta.correggi", "fatto", "luigi", { proposta: id, campi: Object.keys(modifiche) });
  return leggiProposta(db, id)!;
}

export function scartaProposta(db: Db, id: string): boolean {
  const ok = db.prepare("UPDATE proposte SET stato = 'scartata', aggiornata = ? WHERE id = ? AND stato IN ('da_confermare','errore','attesa_costructo')").run(Date.now(), id).changes > 0;
  if (ok) registra(db, "proposta.scarta", "fatto", "luigi", { proposta: id });
  return ok;
}

/** Per l'interfaccia: tutto quello che serve per mostrarla e confermarla (testo completo + impronta). */
export function vistaProposta(p: RigaProposta, nomeAzienda: NomeAzienda) {
  const dati = datiDi(p);
  const valida = validaDati(p.tipo, dati);
  const extra = extraDi(p);
  return {
    id: p.id, tipo: p.tipo, nomeTipo: NOMI_TIPI[p.tipo] ?? p.tipo, azienda: p.azienda_id, nomeAzienda: nomeAzienda(p.azienda_id),
    perCostructo: vaACostructo(p.tipo), titolo: p.titolo, dati, nomi: extra.nomi, note: extra.note,
    campi: CAMPI[p.tipo] ?? [], allegati: allegatiDi(p).map((a) => ({ nome: a.nome, mime: a.mime, dimensione: a.dimensione })),
    stato: p.stato, esito: p.esito, statoCostructo: p.stato_costructo, motivoCostructo: p.motivo_costructo, decisoIl: p.deciso_il,
    automatica: !!p.automatica, creata: p.creata, inviata: p.inviata, chiave: p.chiave_doppione,
    completa: valida.ok, mancano: valida.ok ? [] : valida.mancano,
    testoCompleto: testoCompleto(p, nomeAzienda), impronta: improntaProposta(p, nomeAzienda),
  };
}

/** Telefono nel registro: solo le ultime 3 cifre. */
export const telefonoPerRegistro = (t: unknown) => mascheraTelefono(String(t ?? ""));

// ---------------------------------------------------------------- pulizia (30 giorni)
/**
 * Cancella proposte, allegati scaricati, analisi, stato dei vocali, promesse, scontrini e domande sugli operai più
 * vecchi di 30 giorni. Restano solo le scelte di Luigi (operaio di un contatto, chat escluse).
 */
export function pulisciFunzioniVecchie(db: Db, ora = Date.now()): number {
  const limite = ora - CONSERVAZIONE_MS;
  return db.transaction(() => {
    let n = db.prepare("DELETE FROM proposte WHERE creata < ?").run(limite).changes;
    n += db.prepare("DELETE FROM wa_allegati WHERE scaricato < ? OR messaggio_id NOT IN (SELECT id FROM wa_messaggi)").run(limite).changes;
    db.prepare("DELETE FROM wa_analisi WHERE quando < ? OR messaggio_id NOT IN (SELECT id FROM wa_messaggi)").run(limite);
    db.prepare("DELETE FROM wa_media_stato WHERE quando < ? OR messaggio_id NOT IN (SELECT id FROM wa_messaggi)").run(limite);
    n += db.prepare("DELETE FROM promesse WHERE creata < ?").run(limite).changes;
    n += db.prepare("DELETE FROM scontrini WHERE creato < ?").run(limite).changes;
    db.prepare("DELETE FROM wa_domande_operaio WHERE creata < ?").run(limite);
    return n;
  })();
}
