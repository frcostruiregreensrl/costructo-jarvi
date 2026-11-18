// Rubrica unica (funzione 11): i contatti WhatsApp di ogni azienda confrontati con Costructo.
//  - «in Costructo»: il numero è tra le controparti (clienti e fornitori) dell'azienda;
//  - «operaio»: Luigi ha detto chi è (gli operai in Costructo non hanno il telefono);
//  - «sconosciuto»: numero non trovato → Jarvis suggerisce le controparti con lo stesso nome e può PROPORRE a Costructo di
//    aggiungere il numero alla controparte (proposta «contatto», con la conferma di Luigi). Mai scritto direttamente.
// Nella pagina il numero si vede solo mascherato; intero solo nella proposta che Luigi conferma (serve a Costructo).
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { nomeContatto, nomeSpazio, leggiContatto } from "../whatsapp/archivio.js";
import { mascheraTelefono } from "../whatsapp/telefono.js";
import { PRIVATO, type AziendaWa, type ContattoWa } from "../whatsapp/tipi.js";
import { creaProposta } from "../proposte/archivio.js";
import { ErroreProposte } from "../proposte/tipi.js";
import { contropartiDi, contropartiPerNome, telefonoDi } from "./costructoLetture.js";
import { operaioDelContatto } from "./operai.js";

export interface VoceRubrica {
  id: string; nome: string; numero: string; stato: "in_costructo" | "operaio" | "non_operaio_sconosciuto" | "sconosciuto";
  controparte?: string; operaio?: string; suggerite: Array<{ id: string; nome: string }>; proposta?: string;
}
export interface RubricaAzienda { azienda: string; nomeAzienda: string; contatti: VoceRubrica[]; avviso?: string }

const MAX_RICERCHE_PER_TELEFONO = 10;

export async function rubrica(db: Db, aziende: AziendaWa[], collegate: AziendaCollegata[], ora = Date.now()): Promise<RubricaAzienda[]> {
  const out: RubricaAzienda[] = [];
  for (const az of aziende) {
    const contatti = db.prepare("SELECT * FROM wa_contatti WHERE spazio = ? AND gruppo = 0 AND wa_id <> '' ORDER BY aggiornato DESC LIMIT 200").all(az.id) as ContattoWa[];
    const a = collegate.find((x) => x.id === az.id && x.client.configurato);
    const sez: RubricaAzienda = { azienda: az.id, nomeAzienda: az.nome, contatti: [] };
    let controparti: Awaited<ReturnType<typeof contropartiDi>> = [];
    if (a) { try { controparti = await contropartiDi(db, a, ora); } catch (e) { sez.avviso = `Costructo: ${(e as Error).message}`; } }
    else sez.avviso = "Costructo non collegato per questa azienda.";
    const numeri = new Map<string, string>();
    for (const c of controparti) { const n = telefonoDi(c); if (n) numeri.set(n, String(c.nome || c.ragioneSociale || c.id)); }
    let ricerche = 0;
    for (const c of contatti) {
      const op = operaioDelContatto(db, c.id);
      const proposta = (db.prepare("SELECT id FROM proposte WHERE tipo = 'contatto' AND contatto_id = ? AND stato NOT IN ('scartata') ORDER BY creata DESC LIMIT 1").get(c.id) as { id: string } | undefined)?.id;
      const voce: VoceRubrica = { id: c.id, nome: nomeContatto(c), numero: mascheraTelefono(c.wa_id), stato: "sconosciuto", suggerite: [], ...(proposta ? { proposta } : {}) };
      let controparte = numeri.get(c.wa_id);
      // Numero non nell'elenco (Costructo ne dà al massimo 200): si chiede a Costructo per telefono (GET /v1/controparti?telefono=).
      if (!controparte && a && ricerche < MAX_RICERCHE_PER_TELEFONO) {
        ricerche++;
        try { const r = await a.client.contropartiLista(`+${c.wa_id}`); if (r.length === 1) controparte = String(r[0].nome || r[0].ragioneSociale || r[0].id); } catch { /* lettura non disponibile */ }
      }
      if (op?.operaio_id) { voce.stato = "operaio"; voce.operaio = op.nome; }
      else if (controparte) { voce.stato = "in_costructo"; voce.controparte = controparte; }
      else {
        if (op && !op.operaio_id) voce.stato = "non_operaio_sconosciuto";
        voce.suggerite = contropartiPerNome(voce.nome, controparti).slice(0, 5).map((x) => ({ id: String(x.id), nome: String(x.nome || x.ragioneSociale || x.id) }));
      }
      sez.contatti.push(voce);
    }
    out.push(sez);
  }
  return out;
}

/** Proposta «contatto»: aggiungere il numero del contatto a una controparte di Costructo (da confermare). */
export async function proponiContatto(db: Db, aziende: AziendaWa[], collegate: AziendaCollegata[], contattoId: string, controparteId: string, ora = Date.now()): Promise<string> {
  const c = leggiContatto(db, contattoId);
  if (!c || c.gruppo || !c.wa_id) throw new ErroreProposte("Contatto non trovato o senza numero.", 404);
  if (!c.spazio || c.spazio === PRIVATO) throw new ErroreProposte("I contatti privati o da assegnare non vanno in Costructo.");
  const a = collegate.find((x) => x.id === c.spazio && x.client.configurato);
  if (!a) throw new ErroreProposte("Questa azienda non è collegata a Costructo.");
  const controparte = (await contropartiDi(db, a, ora)).find((x) => String(x.id) === controparteId);
  if (!controparte) throw new ErroreProposte("Controparte non trovata in Costructo per questa azienda.", 404);
  const nomeCp = String(controparte.nome || controparte.ragioneSociale || controparte.id);
  const chiave = `contatto:${c.spazio}:${createHash("sha256").update(`${controparteId}:${c.wa_id}`).digest("hex").slice(0, 24)}`;
  const r = creaProposta(db, {
    tipo: "contatto", aziendaId: c.spazio, chiave, origine: "whatsapp", titolo: `Telefono di ${nomeCp} (${nomeSpazio(c.spazio, aziende)})`,
    dati: { controparteId, telefono: `+${c.wa_id}` }, nomi: { controparteId: nomeCp }, contattoId: c.id,
    note: [`Contatto WhatsApp: ${nomeContatto(c)}.`],
  }, ora);
  return r.proposta.id;
}
