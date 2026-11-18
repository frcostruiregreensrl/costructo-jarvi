// Invio delle proposte a Costructo. È una scrittura FUORI da Jarvis: parte SOLO
//  - dopo la conferma di Luigi (pulsante nella pagina Proposte, oppure «Conferma» nella chat), legata all'impronta del
//    testo completo che Luigi ha visto (se un campo cambia, la conferma non vale più);
//  - oppure, solo per i tipi che Luigi ha acceso in «proponi in automatico» (spenti di serie).
// Costructo risponde: 201 nuova, 200 già ricevuta (stessa chiave), 409 doppione («già presente in Costructo»: non si fa
// nient'altro), 404/405 o token senza l'ambito «proposte»: «In attesa della pagina Proposte in Costructo», la proposta
// resta in Jarvis e si può rimandare. Ripetere è sicuro: la chiave doppione rende l'invio idempotente.
// Le proposte private (agenda privata) non vanno mai a Costructo: con la conferma diventano un impegno nell'agenda di Jarvis.
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { ErroreCostructo, type CorpoProposta } from "../costructo.js";
import { aggiungiImpegno, descriviImpegno } from "../agenda.js";
import { leggiImpostazioni } from "../impostazioni.js";
import { registra } from "../registro.js";
import { stessaImpronta } from "../sicurezza/testoConfermato.js";
import { dataIso } from "../tempo.js";
import { contenutoCoerente } from "./firme.js";
import { allegatiDi, datiDi, improntaProposta, leggiProposta, validaDati, type NomeAzienda } from "./archivio.js";
import { ALLEGATI_RICHIESTI, GIA_PRESENTE, IN_ATTESA_COSTRUCTO, MAX_BYTE_ALLEGATO, MIME_ALLEGATI, NOMI_TIPI, PRIVATO, vaACostructo, type RigaProposta } from "./tipi.js";

export interface DipendenzeProposte {
  db: Db;
  fuso: string;
  /** Nomi delle aziende (id → nome). */
  aziende: () => Array<{ id: string; nome: string }>;
  /** Aziende collegate a Costructo (con il token). */
  aziendeCostructo: () => AziendaCollegata[];
  ora?: () => number;
}

export const nomeAziendaDi = (dip: Pick<DipendenzeProposte, "aziende">): NomeAzienda => (id) =>
  id === PRIVATO ? "Privato" : dip.aziende().find((a) => a.id === id)?.nome ?? "Azienda non più collegata";

export interface EsitoProposta { id: string; ok: boolean; stato: string; messaggio: string }

/** Al massimo tante proposte in un solo «manda» (ognuna elencata per intero nella conferma). */
export const MAX_LOTTO = 10;
const CONFERMABILI = ["da_confermare", "errore", "attesa_costructo"];

/** Gli allegati salvati, controllati (formato, dimensione, impronta del contenuto), pronti per Costructo. */
function caricaAllegati(db: Db, p: RigaProposta): Array<{ nome: string; mime: string; base64: string }> {
  return allegatiDi(p).map((a) => {
    const r = db.prepare("SELECT dati, mime, sha256 FROM wa_allegati WHERE id = ?").get(a.allegatoId) as { dati: Buffer; mime: string; sha256: string } | undefined;
    if (!r) throw new Error(`L'allegato «${a.nome}» non c'è più in Jarvis (più vecchio di 30 giorni?).`);
    if (!(MIME_ALLEGATI as readonly string[]).includes(r.mime)) throw new Error(`Formato non ammesso per «${a.nome}».`);
    if (r.dati.length > MAX_BYTE_ALLEGATO) throw new Error(`«${a.nome}» è più grande di 10 MB.`);
    if (createHash("sha256").update(r.dati).digest("hex") !== r.sha256 || r.sha256 !== a.sha256) throw new Error(`L'allegato «${a.nome}» è cambiato: non lo mando.`);
    if (!contenutoCoerente(r.dati, r.mime)) throw new Error(`«${a.nome}» non è davvero un file ${r.mime}: non lo mando.`);
    return { nome: a.nome, mime: r.mime, base64: r.dati.toString("base64") };
  });
}

/**
 * Manda (o, per il privato, salva nell'agenda di Jarvis) UNA proposta. Va chiamata solo dopo la conferma di Luigi con
 * l'impronta del testo che ha visto, oppure dagli invii automatici (che calcolano l'impronta qui, sul testo attuale).
 */
export async function mandaProposta(dip: DipendenzeProposte, id: string, impronta: string, origine: "luigi" | "jarvis" = "luigi"): Promise<EsitoProposta> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const nome = nomeAziendaDi(dip);
  const p = leggiProposta(db, id);
  if (!p) return { id, ok: false, stato: "", messaggio: "Proposta non trovata (forse più vecchia di 30 giorni)." };
  const no = (messaggio: string): EsitoProposta => ({ id, ok: false, stato: p.stato, messaggio });
  if (p.stato === "inviata") return { id, ok: true, stato: p.stato, messaggio: "Questa proposta è già partita." };
  if (!CONFERMABILI.includes(p.stato)) return no("Questa proposta non è più in attesa.");
  if (!stessaImpronta(impronta, improntaProposta(p, nome))) {
    registra(db, "proposta.invio", "negato", "sistema", { proposta: id, motivo: "contenuto diverso da quello confermato" });
    return no("La proposta è cambiata dopo la conferma: non ho mandato niente. Ricontrollala e conferma di nuovo.");
  }
  const v = validaDati(p.tipo, datiDi(p), dataIso(ora, dip.fuso));
  if (!v.ok) return no(`Mancano dei dati: ${v.mancano.join(", ")}. Completali prima di confermare.`);
  const richiesti = ALLEGATI_RICHIESTI[p.tipo];
  const allegati = allegatiDi(p);
  if (richiesti && !allegati.length) return no(`Serve ${richiesti === "pdf" ? "il PDF" : "almeno una foto"}: lo scaricamento degli allegati è spento o non è riuscito.`);
  // Si segna subito «in invio»: un secondo clic non manda due volte.
  if (db.prepare(`UPDATE proposte SET stato = 'in_invio', aggiornata = ? WHERE id = ? AND stato IN (${CONFERMABILI.map(() => "?").join(",")})`).run(ora, id, ...CONFERMABILI).changes === 0) {
    return no("Questa proposta non è più in attesa.");
  }
  const segna = (stato: string, esito: string, extra: Record<string, unknown> = {}) => {
    const campi = Object.keys(extra).map((k) => `, ${k} = ?`).join("");
    db.prepare(`UPDATE proposte SET stato = ?, esito = ?, aggiornata = ?${campi} WHERE id = ?`).run(stato, esito.slice(0, 300), ora, ...Object.values(extra), id);
  };

  // ---- privato: resta in Jarvis (agenda privata), mai a Costructo
  if (!vaACostructo(p.tipo)) {
    try {
      const d = v.dati as { titolo: string; data: string; ora?: string };
      const imp = aggiungiImpegno(db, { titolo: d.titolo, data: d.data, ora: d.ora ?? "" }, dip.fuso, ora);
      segna("inviata", `Segnato nell'agenda privata di Jarvis: ${descriviImpegno(imp, dip.fuso)}.`, { inviata: ora });
      registra(db, "agenda.aggiungi", "fatto", "luigi", { id: imp.id, da: "proposta" });
      return { id, ok: true, stato: "inviata", messaggio: `Segnato nell'agenda privata: ${descriviImpegno(imp, dip.fuso)}.` };
    } catch (e) {
      segna("errore", (e as Error).message);
      return no((e as Error).message);
    }
  }

  // ---- Costructo
  const azienda = dip.aziendeCostructo().find((a) => a.id === p.azienda_id && a.client.configurato);
  if (!azienda) { segna("errore", "Azienda non collegata a Costructo."); return no("Questa azienda non è collegata a Costructo: non ho mandato niente."); }
  // Ore: l'operaio deve essere di QUESTA azienda in Costructo (si ricontrolla adesso, con /v1/operai di questa azienda).
  if (p.tipo === "ore") {
    const operaioId = String((v.dati as { operaioId: string }).operaioId);
    let lista: Awaited<ReturnType<typeof azienda.client.operai>>;
    try { lista = await azienda.client.operai(); } catch {
      segna("errore", "Non riesco a controllare l'operaio in Costructo: riprova.");
      return no(`${azienda.nome}: non riesco a controllare l'operaio in Costructo. Non ho mandato niente: riprova più tardi.`);
    }
    if (!lista.some((o) => String(o.id) === operaioId && o.attivo !== false)) {
      segna("errore", `L'operaio non è tra gli operai attivi di ${azienda.nome} in Costructo.`);
      registra(db, "proposta.invio", "negato", "sistema", { proposta: id, motivo: "operaio non di questa azienda" });
      return no(`L'operaio di questa proposta non è tra gli operai attivi di ${azienda.nome} in Costructo: non ho mandato niente. Correggila.`);
    }
  }
  let corpo: CorpoProposta;
  try {
    const a = caricaAllegati(db, p);
    corpo = { tipo: p.tipo, chiaveDoppione: p.chiave_doppione, origine: p.origine, ...(p.rif_esterno ? { rifEsterno: p.rif_esterno } : {}), titolo: p.titolo, dati: v.dati, ...(a.length ? { allegati: a } : {}) };
  } catch (e) { segna("errore", (e as Error).message); return no((e as Error).message); }
  const reg = { proposta: id, tipo: p.tipo, azienda: azienda.nome, chiave: p.chiave_doppione.slice(0, 60), automatica: origine === "jarvis" };
  try {
    const r = await azienda.client.proponi(corpo);
    segna("inviata", r.esistente ? "Costructo l'aveva già ricevuta." : "Mandata a Costructo: la approvi là.", { id_costructo: r.id, stato_costructo: r.stato, inviata: ora, automatica: origine === "jarvis" ? 1 : 0 });
    registra(db, "proposta.invio", "fatto", origine, reg);
    return { id, ok: true, stato: "inviata", messaggio: `${azienda.nome}: proposta «${p.titolo}» mandata a Costructo. La approvi nella pagina Proposte di Costructo.` };
  } catch (e) {
    const err = e instanceof ErroreCostructo ? e : new ErroreCostructo("Invio non riuscito.", "rete");
    if (err.codice === "doppione") {
      segna("gia_presente", `${GIA_PRESENTE}: ${err.message}`);
      registra(db, "proposta.invio", "negato", origine, { ...reg, motivo: GIA_PRESENTE });
      return { id, ok: true, stato: "gia_presente", messaggio: `${azienda.nome}: ${GIA_PRESENTE} (${err.message}). Non ho fatto nient'altro.` };
    }
    if (err.codice === "non_disponibile" || err.codice === "non_trovato") {
      segna("attesa_costructo", IN_ATTESA_COSTRUCTO);
      registra(db, "proposta.invio", "errore", origine, { ...reg, motivo: "pagina Proposte non ancora in Costructo" });
      return { id, ok: false, stato: "attesa_costructo", messaggio: `${azienda.nome}: ${IN_ATTESA_COSTRUCTO}` };
    }
    segna("errore", err.message);
    registra(db, "proposta.invio", "errore", origine, { ...reg, motivo: err.message.slice(0, 120) });
    return { id, ok: false, stato: "errore", messaggio: `${azienda.nome}: ${err.message} Puoi riprovare (non nasce un doppione).` };
  }
}

/** «Manda le 3 proposte»: ognuna con la sua impronta (Luigi le ha viste tutte per intero). */
export async function mandaProposte(dip: DipendenzeProposte, voci: Array<{ id: string; impronta: string }>, origine: "luigi" | "jarvis" = "luigi"): Promise<{ esiti: EsitoProposta[]; messaggio: string }> {
  const lista = voci.slice(0, MAX_LOTTO);
  const esiti: EsitoProposta[] = [];
  for (const v of lista) esiti.push(await mandaProposta(dip, v.id, v.impronta, origine));
  const ok = esiti.filter((e) => e.ok).length;
  return { esiti, messaggio: lista.length === 1 ? esiti[0].messaggio : `${ok} su ${lista.length} fatte. ${esiti.map((e) => e.messaggio).join(" ")}` };
}

/** Invii automatici, SOLO per i tipi accesi da Luigi (spenti di serie). Mai per il privato, mai proposte incomplete. */
export async function mandaAutomatiche(dip: DipendenzeProposte): Promise<number> {
  const tipi = leggiImpostazioni(dip.db).proposteAutomatiche;
  if (!tipi.length) return 0;
  const ora = dip.ora?.() ?? Date.now();
  const nome = nomeAziendaDi(dip);
  const candidate = dip.db.prepare(`SELECT * FROM proposte WHERE stato = 'da_confermare' AND azienda_id <> ? AND creata > ?
      AND tipo IN (${tipi.map(() => "?").join(",")}) ORDER BY creata LIMIT 20`).all(PRIVATO, ora - 864e5, ...tipi) as RigaProposta[];
  let n = 0;
  for (const p of candidate) {
    if (!validaDati(p.tipo, datiDi(p), dataIso(ora, dip.fuso)).ok) continue;
    const e = await mandaProposta(dip, p.id, improntaProposta(p, nome), "jarvis");
    if (e.ok) n++;
  }
  return n;
}

/** Una proposta rimasta «in invio» da più di 10 minuti (per esempio il server si è fermato a metà): esito incerto. */
export const BLOCCATA_MS = 10 * 60_000;
export const ESITO_INCERTO = "Esito incerto: non so se Costructo l'ha ricevuta. Controlla in Costructo; puoi rimandarla senza paura (non nasce un doppione).";

/**
 * Recupera le proposte rimaste «in invio»: si cerca in Costructo per chiave doppione (GET /v1/proposte?dal=). Trovata → mandata;
 * non trovata o Costructo non risponde → «esito incerto» (si può rimandare: la chiave doppione evita i doppioni).
 */
export async function recuperaBloccate(dip: DipendenzeProposte): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const bloccate = db.prepare("SELECT * FROM proposte WHERE stato = 'in_invio' AND aggiornata < ? LIMIT 50").all(ora - BLOCCATA_MS) as RigaProposta[];
  let n = 0;
  for (const p of bloccate) {
    const a = dip.aziendeCostructo().find((x) => x.id === p.azienda_id && x.client.configurato);
    let trovata: { id?: string; stato?: string } | undefined;
    if (a) {
      try {
        const lista = await a.client.elencaProposte({ dal: new Date(p.creata - 864e5).toISOString().slice(0, 10) });
        trovata = lista.find((x) => (x as Record<string, unknown>).chiaveDoppione === p.chiave_doppione);
      } catch { /* esito incerto */ }
    }
    if (trovata?.id) db.prepare("UPDATE proposte SET stato = 'inviata', id_costructo = ?, stato_costructo = ?, esito = 'Mandata (ritrovata in Costructo).', inviata = ?, aggiornata = ? WHERE id = ? AND stato = 'in_invio'").run(String(trovata.id), String(trovata.stato ?? "in_attesa"), ora, ora, p.id);
    else db.prepare("UPDATE proposte SET stato = 'errore', esito = ?, aggiornata = ? WHERE id = ? AND stato = 'in_invio'").run(ESITO_INCERTO, ora, p.id);
    registra(db, "proposta.invio", trovata ? "fatto" : "errore", "sistema", { proposta: p.id, motivo: trovata ? "ritrovata in Costructo" : "esito incerto" });
    n++;
  }
  return n;
}

/** Rilegge da Costructo lo stato delle proposte mandate (in attesa → accettata / scartata / superata). */
export async function aggiornaStatiProposte(dip: DipendenzeProposte, limite = 50): Promise<number> {
  const { db } = dip;
  const mandate = db.prepare(`SELECT * FROM proposte WHERE stato = 'inviata' AND azienda_id <> ? AND id_costructo <> ''
      AND stato_costructo IN ('', 'in_attesa') ORDER BY inviata DESC LIMIT ?`).all(PRIVATO, limite) as RigaProposta[];
  let n = 0;
  for (const p of mandate) {
    const a = dip.aziendeCostructo().find((x) => x.id === p.azienda_id && x.client.configurato);
    if (!a) continue;
    try {
      const r = await a.client.leggiProposta(p.id_costructo);
      if (!r?.stato) continue;
      const stato = ["in_attesa", "accettata", "scartata", "superata"].includes(r.stato) ? r.stato : "in_attesa";
      db.prepare("UPDATE proposte SET stato_costructo = ?, motivo_costructo = ?, deciso_il = ?, aggiornata = ? WHERE id = ?")
        .run(stato, String(r.motivo ?? "").slice(0, 300), String(r.decisoIl ?? "").slice(0, 40), dip.ora?.() ?? Date.now(), p.id);
      if (stato !== "in_attesa") n++;
    } catch { /* Costructo non risponde o la pagina non c'è ancora: si riprova la prossima volta */ }
  }
  if (n) registra(db, "proposta.stato", "fatto", "sistema", { aggiornate: n });
  return n;
}

export const descriviEsito = (p: RigaProposta) => `${NOMI_TIPI[p.tipo] ?? p.tipo}: ${p.titolo}`;
