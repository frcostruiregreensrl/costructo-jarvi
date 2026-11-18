// Chi è un contatto WhatsApp tra gli operai (in Costructo gli operai non hanno il numero di telefono).
// Come per l'azienda: decide Luigi. Jarvis chiede «Chi è Mario: è l'operaio Mario Rossi?» con i pulsanti (gli operai
// vengono da Costructo, GET /v1/operai) e si ricorda la risposta. «Non è un operaio» vale come risposta.
// La scelta vale PER AZIENDA: un operaio di FR Costruire Green non è un operaio di Edilgreen. Se Luigi sposta il contatto a
// un'altra azienda, Jarvis chiede di nuovo.
// GDPR: Jarvis non usa MAI la posizione di un operaio. Le posizioni si salvano solo per i contatti che sicuramente non sono
// operai (vedi `nonOperaio`); quando un contatto diventa «operaio», le posizioni e quello che Jarvis ne aveva dedotto si cancellano.
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { registra } from "../registro.js";
import { nuovoId, leggiContatto, nomeContatto, nomeSpazio } from "../whatsapp/archivio.js";
import type { AziendaWa, ContattoWa } from "../whatsapp/tipi.js";
import { normalizza } from "./date.js";
import { operaiDi, type OperaioNoto } from "./costructoLetture.js";

export interface OperaioContatto { contatto_id: string; azienda_id: string; operaio_id: string; nome: string; scelto: number }

/** La scelta di Luigi per QUESTA azienda (undefined = non ancora detto). */
export function operaioDelContatto(db: Db, contattoId: string, aziendaId: string): OperaioContatto | undefined {
  return db.prepare("SELECT * FROM wa_operai WHERE contatto_id = ? AND azienda_id = ?").get(contattoId, aziendaId) as OperaioContatto | undefined;
}

/** Vero se il contatto è operaio di almeno un'azienda (per la posizione basta questo). */
export const eOperaio = (db: Db, contattoId: string) => !!db.prepare("SELECT 1 FROM wa_operai WHERE contatto_id = ? AND operaio_id <> ''").get(contattoId);

/**
 * Contatto che sicuramente NON è un operaio: controparte trovata in Costructo (cliente o fornitore), oppure Luigi ha detto
 * «non è un operaio» per la sua azienda. Solo per questi Jarvis salva e usa una posizione. Privato e «da assegnare»: no.
 */
export function nonOperaio(db: Db, c: Pick<ContattoWa, "id" | "spazio" | "fonte_spazio" | "gruppo">): boolean {
  if (c.gruppo || !c.spazio || c.spazio === "privato" || eOperaio(db, c.id)) return false;
  if (c.fonte_spazio === "costructo") return true;
  return operaioDelContatto(db, c.id, c.spazio)?.operaio_id === "";
}

export const POSIZIONE_OPERAIO = "Posizione condivisa (non salvata: Jarvis non usa mai la posizione degli operai)";
export const POSIZIONE_NON_SALVATA = "Posizione condivisa (non salvata: Jarvis la usa solo per clienti e fornitori)";

/** Toglie le coordinate dai messaggi del contatto e quello che Jarvis ne aveva dedotto (cantiere vicino, «nuovo sopralluogo?»). */
export function togliPosizioni(db: Db, contattoId: string, testo = POSIZIONE_OPERAIO): number {
  const n = db.prepare(`UPDATE wa_messaggi SET testo = ?, media = '{}' WHERE contatto_id = ? AND tipo = 'location'`).run(testo, contattoId).changes;
  db.prepare(`UPDATE wa_analisi SET cantiere_id = '', cantiere_nome = '', esito = '{}'
      WHERE messaggio_id IN (SELECT id FROM wa_messaggi WHERE contatto_id = ? AND tipo = 'location')`).run(contattoId);
  db.prepare(`UPDATE proposte SET stato = 'scartata', esito = 'Scartata: nata dalla posizione di un operaio.' WHERE contatto_id = ?
      AND chiave_doppione LIKE '%:sopralluogo' AND stato IN ('da_confermare','errore','attesa_costructo')`).run(contattoId);
  return n;
}

/** Apre la domanda per questa azienda (una sola aperta per contatto e azienda). */
export function chiediOperaio(db: Db, contattoId: string, aziendaId: string, ora = Date.now()): string {
  const aperta = db.prepare("SELECT id FROM wa_domande_operaio WHERE contatto_id = ? AND azienda_id = ? AND stato = 'aperta'").get(contattoId, aziendaId) as { id: string } | undefined;
  if (aperta) return aperta.id;
  const id = nuovoId("o");
  db.prepare("INSERT INTO wa_domande_operaio (id, contatto_id, azienda_id, creata, stato) VALUES (?,?,?,?, 'aperta')").run(id, contattoId, aziendaId, ora);
  registra(db, "whatsapp.operaio", "richiesta_conferma", "jarvis", { contatto: contattoId, azienda: aziendaId, motivo: "operaio non ancora noto" });
  return id;
}

/** Luigi risponde per un'azienda: operaio (id e nome da Costructo) oppure null = non è un operaio. Si ricorda. */
export function rispondiOperaio(db: Db, contattoId: string, aziendaId: string, operaio: { id: string; nome: string } | null, ora = Date.now()): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO wa_operai (contatto_id, azienda_id, operaio_id, nome, scelto) VALUES (?,?,?,?,?)
      ON CONFLICT(contatto_id, azienda_id) DO UPDATE SET operaio_id = excluded.operaio_id, nome = excluded.nome, scelto = excluded.scelto`)
      .run(contattoId, aziendaId, operaio?.id ?? "", operaio?.nome ?? "", ora);
    db.prepare("UPDATE wa_domande_operaio SET stato = 'risposta' WHERE contatto_id = ? AND azienda_id = ? AND stato = 'aperta'").run(contattoId, aziendaId);
    // Le analisi rimaste in attesa di questa risposta si rifanno al prossimo giro.
    db.prepare("DELETE FROM wa_analisi WHERE stato = 'attesa' AND messaggio_id IN (SELECT id FROM wa_messaggi WHERE contatto_id = ?)").run(contattoId);
    if (operaio) togliPosizioni(db, contattoId);
  })();
  registra(db, "whatsapp.operaio", "fatto", "luigi", { contatto: contattoId, azienda: aziendaId, operaio: operaio ? operaio.id : "nessuno" });
}

export function dimenticaOperaio(db: Db, contattoId: string, aziendaId?: string): boolean {
  const ok = (aziendaId
    ? db.prepare("DELETE FROM wa_operai WHERE contatto_id = ? AND azienda_id = ?").run(contattoId, aziendaId)
    : db.prepare("DELETE FROM wa_operai WHERE contatto_id = ?").run(contattoId)).changes > 0;
  if (ok) registra(db, "whatsapp.operaio", "fatto", "luigi", { contatto: contattoId, operaio: "tolto" });
  return ok;
}

/** L'operaio con il nome più simile a quello del contatto (solo un suggerimento: decide Luigi). */
export function operaioSimile(nome: string, operai: OperaioNoto[]): OperaioNoto | undefined {
  const parole = normalizza(nome).split(/[^a-z]+/).filter((p) => p.length >= 3);
  if (!parole.length) return undefined;
  const punteggio = (o: OperaioNoto) => { const q = normalizza(o.nome).split(/[^a-z]+/); return parole.filter((p) => q.includes(p)).length; };
  const ordinati = operai.filter((o) => o.attivo).map((o) => ({ o, p: punteggio(o) })).filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
  return ordinati.length && (ordinati.length === 1 || ordinati[0].p > ordinati[1].p) ? ordinati[0].o : undefined;
}

export interface DomandaOperaio { id: string; contatto: string; nome: string; azienda: string; nomeAzienda: string; domanda: string; operai: OperaioNoto[]; suggerito: string; errore?: string }

/** Domande aperte (solo per l'azienda attuale del contatto), con gli operai attivi di quell'azienda per i pulsanti. */
export async function domandeOperaioAperte(db: Db, aziende: AziendaWa[], collegate: AziendaCollegata[], ora = Date.now()): Promise<DomandaOperaio[]> {
  const righe = db.prepare("SELECT * FROM wa_domande_operaio WHERE stato = 'aperta' ORDER BY creata DESC LIMIT 20").all() as Array<{ id: string; contatto_id: string; azienda_id: string }>;
  const out: DomandaOperaio[] = [];
  for (const r of righe) {
    const c = leggiContatto(db, r.contatto_id);
    if (!c || c.spazio !== r.azienda_id) continue;
    const a = collegate.find((x) => x.id === r.azienda_id);
    let operai: OperaioNoto[] = [];
    let errore: string | undefined;
    if (a) { try { operai = (await operaiDi(db, a, ora)).filter((o) => o.attivo).slice(0, 30); } catch (e) { errore = (e as Error).message; } }
    const suggerito = operaioSimile(nomeContatto(c), operai);
    const nomeAz = nomeSpazio(r.azienda_id, aziende);
    out.push({
      id: r.id, contatto: c.id, nome: nomeContatto(c), azienda: r.azienda_id, nomeAzienda: nomeAz, operai, suggerito: suggerito?.id ?? "", ...(errore ? { errore } : {}),
      domanda: suggerito ? `Chi è questo contatto: ${nomeContatto(c)} (${nomeAz}) è l'operaio ${suggerito.nome}?` : `Chi è questo contatto: ${nomeContatto(c)} (${nomeAz}) è uno dei tuoi operai?`,
    });
  }
  return out;
}

/** Mappature scelte da Luigi (per Impostazioni). */
export function elencoOperaiContatti(db: Db, aziende: AziendaWa[]): Array<{ contatto: string; nomeContatto: string; azienda: string; nomeAzienda: string; operaio: string; nomeOperaio: string }> {
  const righe = db.prepare("SELECT * FROM wa_operai ORDER BY scelto DESC LIMIT 300").all() as OperaioContatto[];
  return righe.map((r) => {
    const c = leggiContatto(db, r.contatto_id);
    return { contatto: r.contatto_id, nomeContatto: c ? nomeContatto(c) : "Contatto non più in Jarvis", azienda: r.azienda_id, nomeAzienda: nomeSpazio(r.azienda_id, aziende), operaio: r.operaio_id, nomeOperaio: r.operaio_id ? r.nome : "Non è un operaio" };
  });
}
