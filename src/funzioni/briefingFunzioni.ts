// Briefing delle funzioni WhatsApp, per azienda (e il privato a parte), senza AI:
//  2) chi aspetta una risposta e le promesse di Luigi non mantenute («ti mando il preventivo domani» → il giorno dopo lo ricorda);
//  3) riassunto della giornata per cantiere (WhatsApp + posta + agenda di Costructo);
//  4) solleciti pronti: fatture scadute da Costructo → testo per ogni cliente, con gli importi ESATTI di Costructo e un
//     link wa.me con il testo già scritto. Lo manda Luigi dal suo telefono: Jarvis non manda niente;
//  8) preventivi mandati da più di N giorni senza risposta → promemoria + testo pronto (wa.me);
// 18) appuntamenti di domani dall'agenda di Costructo → testo di promemoria per il cliente (wa.me). I «modelli» di Meta
//     (parte 2) si usano solo se Luigi li accende, e sempre con la sua conferma.
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import type { Controparte } from "../costructo.js";
import { leggiImpostazioni } from "../impostazioni.js";
import { dataIso, inizioGiorno, oraMinuti, partiLocali } from "../tempo.js";
import { leggiContatto, nomeContatto, statoChat } from "../whatsapp/archivio.js";
import { mascheraTelefono, normalizzaTelefono } from "../whatsapp/telefono.js";
import { PRIVATO, type AziendaWa } from "../whatsapp/tipi.js";
import { contropartiDi, contropartiPerNome, oVuoto, telefonoDi, cantieriDi, type CantiereNoto } from "./costructoLetture.js";
import { dataBreve, giornoDa, normalizza } from "./date.js";

export interface VoceAttesa { contatto: string; contattoId: string; daQuando: number }
export interface VocePromessa { id: string; contatto: string; contattoId: string; cosa: string; scadenza: number; scaduta: boolean }
export interface VoceCantiere { cantiereId: string; nome: string; messaggi: number; foto: number; mail: number; proposte: number; impegni: number; frasi: string[] }
/** Un testo pronto per un cliente: lo manda Luigi dal telefono con il link wa.me (mai Jarvis). */
export interface TestoPronto { titolo: string; testo: string; link?: string; numero?: string; nota?: string; telefono?: string }
export interface SezioneFunzioni {
  id: string; nome: string;
  aspettano: VoceAttesa[]; promesse: VocePromessa[]; cantieri: VoceCantiere[];
  preventivi: TestoPronto[]; solleciti: TestoPronto[]; appuntamentiDomani: TestoPronto[];
  proposte: number; avvisi: string[];
}
export interface FunzioniBriefing {
  aziende: SezioneFunzioni[];
  privato: { aspettano: VoceAttesa[]; promesse: VocePromessa[]; promemoria: number } | null;
  /** Giorno del riassunto per cantiere (oggi dal primo pomeriggio, altrimenti ieri). */
  giornoCantieri: string;
  modelliAttivi: boolean;
  righe: string[];
}

/** Link wa.me con il testo già scritto: si apre WhatsApp sul telefono di Luigi, che decide se mandarlo. */
export function linkWaMe(numero: string, testo: string): string | undefined {
  const n = normalizzaTelefono(numero);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(testo)}` : undefined;
}

/** Importo esattamente come in Costructo (tutte le cifre decimali che ha, almeno 2), in euro. */
export const importoEsatto = (n: number) => `${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 20, useGrouping: "always" } as unknown as Intl.NumberFormatOptions)} €`;

/** Data di Costructo (ISO o gg/mm/aaaa) → AAAA-MM-GG, o null. */
export function dataCostructo(s: string | undefined, fuso: string): string | null {
  if (!s) return null;
  const it = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (it) return `${it[3]}-${it[2].padStart(2, "0")}-${it[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return s.trim();
  const t = Date.parse(s);
  return Number.isFinite(t) ? dataIso(t, fuso) : null;
}

const plurale = (n: number, uno: string, tanti: string) => `${n} ${n === 1 ? uno : tanti}`;

/** Telefono di una controparte: campo diretto, id della controparte, o nome (una sola corrispondenza). */
function telefonoPer(o: { telefono?: string; controparteId?: string; cliente?: string }, controparti: Controparte[]): string | null {
  const diretto = o.telefono ? normalizzaTelefono(o.telefono) : null;
  if (diretto) return diretto;
  if (o.controparteId) { const c = controparti.find((x) => String(x.id) === String(o.controparteId)); if (c) return telefonoDi(c); }
  if (o.cliente) { const c = contropartiPerNome(o.cliente, controparti); if (c.length === 1) return telefonoDi(c[0]); }
  return null;
}

function pronto(titolo: string, testo: string, telefono: string | null): TestoPronto {
  const link = telefono ? linkWaMe(telefono, testo) : undefined;
  return { titolo, testo, ...(link ? { link, numero: mascheraTelefono(telefono!), telefono: telefono! } : { nota: "Numero non trovato in Costructo: copia il testo." }) };
}

function aspettano(db: Db, spazio: string, ora: number): VoceAttesa[] {
  const righe = db.prepare(`SELECT c.id, MAX(m.quando) q FROM wa_contatti c JOIN wa_messaggi m ON m.contatto_id = c.id
      WHERE c.spazio = ? AND c.gruppo = 0 AND m.direzione = 'in' AND m.storico = 0 AND m.ricevuto > ? GROUP BY c.id ORDER BY q`).all(spazio, ora - 3 * 864e5) as Array<{ id: string; q: number }>;
  const out: VoceAttesa[] = [];
  for (const r of righe) {
    if (!statoChat(db, r.id, ora).senzaRisposta) continue;
    const c = leggiContatto(db, r.id);
    if (c) out.push({ contatto: nomeContatto(c), contattoId: c.id, daQuando: r.q });
  }
  return out.slice(0, 20);
}

function promesse(db: Db, spazio: string, ora: number, fuso: string): VocePromessa[] {
  const fineOggi = inizioGiorno(ora, fuso) + 864e5;
  const righe = db.prepare(`SELECT p.* FROM promesse p JOIN wa_contatti c ON c.id = p.contatto_id WHERE c.spazio = ? AND p.stato = 'aperta' AND p.scadenza < ?
      ORDER BY p.scadenza`).all(spazio, fineOggi) as Array<{ id: string; contatto_id: string; cosa: string; scadenza: number }>;
  return righe.slice(0, 20).map((p) => {
    const c = leggiContatto(db, p.contatto_id);
    return { id: p.id, contatto: c ? nomeContatto(c) : "Contatto", contattoId: p.contatto_id, cosa: p.cosa, scadenza: p.scadenza, scaduta: p.scadenza < ora };
  });
}

function riassuntoCantieri(db: Db, aziendaId: string, cantieri: CantiereNoto[], giorno: string, fuso: string, impegni: Array<{ cantiere?: string; cantiereId?: string }>): VoceCantiere[] {
  const [a, m, g] = giorno.split("-").map(Number);
  const da = inizioGiorno(Date.UTC(a, m - 1, g, 12), fuso), a2 = da + 864e5;
  const righe = db.prepare(`SELECT w.cantiere_id, w.cantiere_nome, m.tipo, m.riassunto, m.testo FROM wa_analisi w JOIN wa_messaggi m ON m.id = w.messaggio_id
      WHERE w.azienda_id = ? AND w.cantiere_id <> '' AND m.quando >= ? AND m.quando < ? ORDER BY m.quando`).all(aziendaId, da, a2) as Array<{ cantiere_id: string; cantiere_nome: string; tipo: string; riassunto: string; testo: string }>;
  const mappa = new Map<string, VoceCantiere>();
  const voce = (id: string, nome: string) => {
    if (!mappa.has(id)) mappa.set(id, { cantiereId: id, nome, messaggi: 0, foto: 0, mail: 0, proposte: 0, impegni: 0, frasi: [] });
    return mappa.get(id)!;
  };
  for (const r of righe) {
    const v = voce(r.cantiere_id, r.cantiere_nome);
    v.messaggi++;
    if (r.tipo === "image") v.foto++;
    const f = (r.riassunto || r.testo).replace(/\s+/g, " ").trim();
    if (f && v.frasi.length < 3 && r.tipo !== "image") v.frasi.push(f.slice(0, 140));
  }
  const proposte = db.prepare("SELECT dati FROM proposte WHERE azienda_id = ? AND creata >= ? AND creata < ?").all(aziendaId, da, a2) as Array<{ dati: string }>;
  for (const p of proposte) {
    let id = ""; try { id = String((JSON.parse(p.dati) as { cantiereId?: unknown }).cantiereId ?? ""); } catch { /* */ }
    const c = cantieri.find((x) => x.id === id);
    if (c) voce(c.id, c.nome).proposte++;
  }
  const mail = db.prepare("SELECT oggetto, estratto FROM posta_messaggi WHERE spazio = ? AND data >= ? AND data < ?").all(aziendaId, da, a2) as Array<{ oggetto: string; estratto: string }>;
  for (const c of cantieri) {
    const n = normalizza(c.nome);
    if (n.length < 4) continue;
    const quante = mail.filter((x) => normalizza(`${x.oggetto} ${x.estratto}`).includes(n)).length;
    const imp = impegni.filter((i) => (i.cantiereId && String(i.cantiereId) === c.id) || (i.cantiere && normalizza(i.cantiere).includes(n))).length;
    if (quante || imp) { const v = voce(c.id, c.nome); v.mail += quante; v.impegni += imp; }
  }
  return [...mappa.values()].sort((x, y) => y.messaggi + y.mail - (x.messaggi + x.mail)).slice(0, 15);
}

export interface OpzioniFunzioniBriefing {
  db: Db; fuso: string; vista: "privato" | "lavoro" | "tutto";
  aziende: AziendaWa[]; collegate: AziendaCollegata[]; ora?: number;
}

export async function briefingFunzioni(o: OpzioniFunzioniBriefing): Promise<FunzioniBriefing> {
  const ora = o.ora ?? Date.now();
  const { db, fuso } = o;
  const imp = leggiImpostazioni(db);
  const giornoCantieri = partiLocali(ora, fuso).ora >= 14 ? giornoDa(ora, 0, fuso) : giornoDa(ora, -1, fuso);
  const oggi = giornoDa(ora, 0, fuso), domani = giornoDa(ora, 1, fuso);
  const out: FunzioniBriefing = { aziende: [], privato: null, giornoCantieri, modelliAttivi: imp.whatsappModelliAttivi, righe: [] };

  if (o.vista !== "privato") {
    for (const az of o.aziende) {
      const a = o.collegate.find((x) => x.id === az.id && x.client.configurato);
      const sez: SezioneFunzioni = {
        id: az.id, nome: az.nome, aspettano: aspettano(db, az.id, ora), promesse: promesse(db, az.id, ora, fuso), cantieri: [],
        preventivi: [], solleciti: [], appuntamentiDomani: [], avvisi: [],
        proposte: (db.prepare("SELECT COUNT(*) n FROM proposte WHERE azienda_id = ? AND stato IN ('da_confermare','attesa_costructo')").get(az.id) as { n: number }).n,
      };
      if (a) {
        const [controparti, cantieri, agenda, preventivi, briefing] = await Promise.all([
          oVuoto(contropartiDi(db, a, ora)), oVuoto(cantieriDi(db, a, ora)), oVuoto(a.client.agendaLista(2)), oVuoto(a.client.preventiviLista()),
          a.client.briefing().then((r) => r.dati).catch(() => null),
        ]);
        // 18) appuntamenti di domani
        for (const i of agenda) {
          const t = i.inizio ? Date.parse(i.inizio) : NaN;
          if (!Number.isFinite(t) || dataIso(t, fuso) !== domani) continue;
          const ora2 = oraMinuti(t, fuso);
          const cliente = i.cliente ? ` ${i.cliente}` : "";
          const testo = `Buongiorno${cliente}, le ricordiamo l'appuntamento di domani ${dataBreve(domani)} alle ${ora2}${i.luogo ? ` (${i.luogo})` : ""}. Per qualsiasi cambio ci scriva pure. Grazie.`;
          sez.appuntamentiDomani.push(pronto(`${ora2} · ${i.titolo || "Appuntamento"}${i.cliente ? ` · ${i.cliente}` : ""}`, testo, telefonoPer(i, controparti)));
        }
        // 8) preventivi in attesa
        for (const p of preventivi) {
          const stato = normalizza(p.stato ?? "");
          if (!/^(inviat|in attesa|attesa|spedit)/.test(stato)) continue;
          const d = dataCostructo(p.dataInvio ?? p.data, fuso);
          if (!d) continue;
          const giorni = Math.floor((Date.parse(`${oggi}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
          if (giorni < imp.giorniPreventiviInAttesa) continue;
          const testo = `Buongiorno${p.cliente ? ` ${p.cliente}` : ""}, le avevamo mandato il preventivo${p.numero ? ` n. ${p.numero}` : ""} il ${dataBreve(d)}. Ha avuto modo di vederlo? Restiamo a disposizione per qualsiasi chiarimento.`;
          sez.preventivi.push(pronto(`Preventivo${p.numero ? ` n. ${p.numero}` : ""}${p.cliente ? ` · ${p.cliente}` : ""}: inviato ${giorni} giorni fa`, testo, telefonoPer(p, controparti)));
        }
        // 4) solleciti: fatture scadute, importo esatto di Costructo
        for (const f of briefing?.fattureDaIncassare ?? []) {
          const scad = dataCostructo(f.scadenza, fuso);
          const importo = f.residuo ?? f.importo;
          if (!scad || scad >= oggi || importo === undefined) continue;
          const cifra = importoEsatto(importo);
          const testo = `Buongiorno${f.cliente ? ` ${f.cliente}` : ""}, le ricordiamo che la fattura${f.numero ? ` n. ${f.numero}` : ""} con scadenza ${dataBreve(scad)} risulta ancora da saldare per ${cifra}. Se ha già provveduto, non tenga conto di questo messaggio. Grazie.`;
          sez.solleciti.push(pronto(`${f.cliente || "Cliente"}${f.numero ? ` · fattura n. ${f.numero}` : ""}: ${cifra}, scaduta il ${dataBreve(scad)}`, testo, telefonoPer(f, controparti)));
        }
        // 3) riassunto per cantiere
        const impegniGiorno = [...agenda, ...(briefing?.impegni ?? [])].filter((i) => { const t = i.inizio ? Date.parse(i.inizio) : NaN; return Number.isFinite(t) && dataIso(t, fuso) === giornoCantieri; });
        sez.cantieri = riassuntoCantieri(db, az.id, cantieri, giornoCantieri, fuso, impegniGiorno);
      } else sez.avvisi.push(`${az.nome}: Costructo non collegato (solleciti, preventivi e appuntamenti non disponibili).`);
      out.aziende.push(sez);
      const pezzi = [
        sez.aspettano.length ? plurale(sez.aspettano.length, "chat aspetta una risposta", "chat aspettano una risposta") : "",
        sez.promesse.filter((p) => p.scaduta).length ? plurale(sez.promesse.filter((p) => p.scaduta).length, "promessa non mantenuta", "promesse non mantenute") : "",
        sez.preventivi.length ? plurale(sez.preventivi.length, "preventivo in attesa", "preventivi in attesa") : "",
        sez.solleciti.length ? plurale(sez.solleciti.length, "sollecito pronto", "solleciti pronti") : "",
        sez.appuntamentiDomani.length ? plurale(sez.appuntamentiDomani.length, "appuntamento domani", "appuntamenti domani") : "",
        sez.proposte ? plurale(sez.proposte, "proposta da confermare", "proposte da confermare") : "",
      ].filter(Boolean);
      if (pezzi.length) out.righe.push(`${az.nome}: ${pezzi.join(", ")}.`);
    }
  }
  if (o.vista !== "lavoro") {
    const p = {
      aspettano: aspettano(db, PRIVATO, ora), promesse: promesse(db, PRIVATO, ora, fuso),
      promemoria: (db.prepare("SELECT COUNT(*) n FROM proposte WHERE azienda_id = ? AND stato = 'da_confermare'").get(PRIVATO) as { n: number }).n,
    };
    out.privato = p;
    const pezzi = [
      p.aspettano.length ? plurale(p.aspettano.length, "chat aspetta una risposta", "chat aspettano una risposta") : "",
      p.promesse.filter((x) => x.scaduta).length ? plurale(p.promesse.filter((x) => x.scaduta).length, "promessa non mantenuta", "promesse non mantenute") : "",
      p.promemoria ? plurale(p.promemoria, "promemoria da confermare", "promemoria da confermare") : "",
    ].filter(Boolean);
    if (pezzi.length) out.righe.push(`Privato: ${pezzi.join(", ")}.`);
  }
  return out;
}

/** Luigi segna una promessa come fatta (o la toglie). */
export function chiudiPromessa(db: Db, id: string): boolean {
  return db.prepare("UPDATE promesse SET stato = 'chiusa' WHERE id = ? AND stato = 'aperta'").run(id).changes > 0;
}
