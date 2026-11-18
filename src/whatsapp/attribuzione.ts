// Di quale azienda è un contatto WhatsApp (richiesta esplicita di Luigi: un solo numero per due aziende e la vita privata).
// Ordine:
//  1) la scelta già fatta da Luigi (si ricorda per sempre, finché non la cambia lui);
//  2) il numero trovato tra le controparti di Costructo (clienti e fornitori) di UNA sola azienda;
//  3) il contesto della chat: l'AI può proporre un'azienda, ma NON decide da sola.
// Se non si sa, o se il numero è in più aziende, Jarvis CHIEDE: «Di quale azienda è Mario: FR Costruire Green, Edilgreen o privato?»
// (scheda con i pulsanti nella pagina WhatsApp e notifica), e si ricorda la risposta.
import { z } from "zod";
import type { Db } from "../db.js";
import { registra } from "../registro.js";
import { leggiImpostazioni } from "../impostazioni.js";
import { inviaATutti } from "../push.js";
import { nomiAziende, type AziendaCollegata } from "../aziende.js";
import { assegnaSpazio, leggiContatto, nomeContatto, nomeSpazio, nuovoId } from "./archivio.js";
import { normalizzaTelefono } from "./telefono.js";
import { PRIVATO, type AziendaWa, type ContattoWa, type DipendenzeWhatsapp } from "./tipi.js";

/** I numeri delle controparti di Costructo si rileggono al massimo ogni 30 minuti per azienda. */
export const VALIDITA_CACHE_MS = 30 * 60_000;

const SchemaControparte = z.object({ telefono: z.union([z.string(), z.number()]).nullish() }).passthrough();
const cache = new WeakMap<Db, Map<string, { quando: number; numeri: Set<string> }>>();

/** Numeri (normalizzati) delle controparti di un'azienda di Costructo. Errore = nessun numero per questo giro (e si dice nel registro). */
async function numeriAzienda(db: Db, a: AziendaCollegata, ora: number): Promise<Set<string>> {
  let perDb = cache.get(db);
  if (!perDb) { perDb = new Map(); cache.set(db, perDb); }
  const c = perDb.get(a.id);
  if (c && ora - c.quando < VALIDITA_CACHE_MS) return c.numeri;
  const numeri = new Set<string>();
  try {
    const r = await a.client.controparti();
    const d = r.dati as { controparti?: unknown } | unknown[];
    const lista = Array.isArray(d) ? d : Array.isArray((d as { controparti?: unknown })?.controparti) ? (d as { controparti: unknown[] }).controparti : [];
    for (const x of lista.slice(0, 2000)) {
      const v = SchemaControparte.safeParse(x);
      if (!v.success || v.data.telefono == null) continue;
      // Un campo può contenere più numeri («333 1234567 / 06 1234567»).
      for (const pezzo of String(v.data.telefono).split(/[,;/]|\s{2,}|\be\b/)) {
        const n = normalizzaTelefono(pezzo);
        if (n) numeri.add(n);
      }
    }
    registra(db, "costructo.leggi", "fatto", "sistema", { percorso: "/controparti", azienda: a.nome, scopo: "attribuzione WhatsApp" });
  } catch (e) {
    // Un errore di Costructo NON si tiene in memoria: al giro dopo si riprova.
    registra(db, "costructo.leggi", "errore", "sistema", { percorso: "/controparti", azienda: a.nome, motivo: (e as Error).message?.slice(0, 120) });
    return numeri;
  }
  perDb.set(a.id, { quando: ora, numeri });
  return numeri;
}

/** Svuota la cache (dopo «Aggiorna», nei test). */
export function dimenticaCache(db: Db): void { cache.delete(db); }

export interface EsitoAttribuzione { spazio: string; fonte: "luigi" | "costructo" | "domanda"; aziende?: string[] }

/**
 * Prova ad attribuire il contatto. Se Luigi ha già scelto, non cambia niente.
 * Un solo match in Costructo → quell'azienda. Nessuno o più di uno → serve la domanda (si crea qui).
 */
export async function attribuisci(dip: DipendenzeWhatsapp, contatto: ContattoWa, conNotifica: boolean): Promise<EsitoAttribuzione> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  if (contatto.fonte_spazio === "luigi") return { spazio: contatto.spazio, fonte: "luigi" };
  const trovate: string[] = [];
  if (contatto.wa_id && !contatto.gruppo) {
    for (const a of dip.aziendeCostructo().filter((x) => x.client.configurato)) {
      if ((await numeriAzienda(db, a, ora)).has(contatto.wa_id)) trovate.push(a.id);
    }
  }
  if (trovate.length === 1) {
    if (contatto.spazio !== trovate[0] || contatto.fonte_spazio !== "costructo") {
      assegnaSpazio(db, contatto.id, trovate[0], "costructo", ora);
      registra(db, "whatsapp.azienda", "fatto", "jarvis", { contatto: contatto.id, azienda: nomeSpazio(trovate[0], dip.aziende()), fonte: "numero trovato in Costructo" });
    }
    return { spazio: trovate[0], fonte: "costructo" };
  }
  // Il numero non c'era (o c'è in più aziende): un'attribuzione vecchia fatta da Costructo non vale più.
  if (contatto.fonte_spazio === "costructo") db.prepare("UPDATE wa_contatti SET spazio = '', fonte_spazio = '' WHERE id = ?").run(contatto.id);
  await chiedi(dip, contatto.id, conNotifica, trovate);
  return { spazio: "", fonte: "domanda", aziende: trovate };
}

/** La domanda «Di quale azienda è …?» in parole (i nomi delle aziende vengono da Costructo). */
export function testoDomanda(contatto: Pick<ContattoWa, "nome_rubrica" | "nome_profilo" | "wa_id" | "gruppo">, aziende: AziendaWa[]): string {
  const opzioni = [...aziende.map((a) => ({ nome: a.nome })), { nome: "privato" }];
  return `Di quale azienda è ${nomeContatto(contatto)}: ${nomiAziende(opzioni)}?`;
}

/** Crea la domanda (una sola aperta per contatto) e, se serve, manda la notifica (solo il nome del contatto). */
export async function chiedi(dip: DipendenzeWhatsapp, contattoId: string, conNotifica: boolean, inPiuAziende: string[] = []): Promise<string> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const aperta = db.prepare("SELECT id, notificata FROM wa_domande WHERE contatto_id = ? AND stato = 'aperta'").get(contattoId) as { id: string; notificata: number } | undefined;
  const id = aperta?.id ?? nuovoId("d");
  if (!aperta) {
    db.prepare("INSERT INTO wa_domande (id, contatto_id, creata, stato) VALUES (?,?,?, 'aperta')").run(id, contattoId, ora);
    registra(db, "whatsapp.azienda", "richiesta_conferma", "jarvis", { contatto: contattoId, motivo: inPiuAziende.length > 1 ? "numero presente in più aziende" : "azienda non nota" });
  }
  if (conNotifica && !aperta?.notificata && dip.invia) {
    const c = leggiContatto(db, contattoId);
    if (c) {
      const nascondi = leggiImpostazioni(db).whatsappNascondiContenuto;
      // Nella notifica: mai il numero, mai il testo. Solo il nome del contatto (o niente, se Luigi lo ha chiesto).
      const testo = nascondi ? "Jarvis ha una domanda su un contatto WhatsApp." : testoDomanda(c, dip.aziende());
      await inviaATutti(db, dip.invia, "WhatsApp · Di quale azienda è?", testo.slice(0, 180), "notifica.whatsapp", "/#whatsapp");
    }
    db.prepare("UPDATE wa_domande SET notificata = 1 WHERE id = ?").run(id);
  }
  return id;
}

/** Luigi risponde (pulsante nella pagina o conferma a voce): si ricorda per sempre. */
export function rispondiDomanda(dip: Pick<DipendenzeWhatsapp, "db" | "aziende" | "ora">, contattoId: string, spazio: string): string {
  const aziende = dip.aziende();
  if (spazio !== PRIVATO && !aziende.some((a) => a.id === spazio)) throw new Error("Azienda non trovata.");
  assegnaSpazio(dip.db, contattoId, spazio, "luigi", dip.ora?.() ?? Date.now());
  registra(dip.db, "whatsapp.azienda", "fatto", "luigi", { contatto: contattoId, azienda: nomeSpazio(spazio, aziende) });
  return nomeSpazio(spazio, aziende);
}

export interface DomandaVisibile { id: string; contatto: string; nome: string; domanda: string; proposta: string; propostaNome: string }

export function domandeAperte(db: Db, aziende: AziendaWa[]): DomandaVisibile[] {
  const righe = db.prepare("SELECT d.id, d.contatto_id FROM wa_domande d WHERE d.stato = 'aperta' ORDER BY d.creata DESC LIMIT 30").all() as Array<{ id: string; contatto_id: string }>;
  const out: DomandaVisibile[] = [];
  for (const r of righe) {
    const c = leggiContatto(db, r.contatto_id);
    if (!c) continue;
    const proposta = c.proposta_spazio && (c.proposta_spazio === PRIVATO || aziende.some((a) => a.id === c.proposta_spazio)) ? c.proposta_spazio : "";
    out.push({ id: r.id, contatto: c.id, nome: nomeContatto(c), domanda: testoDomanda(c, aziende), proposta, propostaNome: proposta ? nomeSpazio(proposta, aziende) : "" });
  }
  return out;
}
