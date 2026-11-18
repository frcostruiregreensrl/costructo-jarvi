// Documenti al volo (funzione 7): «manda a Bianchi il DURC di Edilgreen» → proposta «invio_documenti» per Costructo, che
// manda i documenti dal suo flusso dopo l'approvazione di Luigi. Jarvis non manda niente.
// Controlli: l'azienda deve essere chiara (altrimenti chiede); i documenti devono essere DI QUELL'AZIENDA: se Luigi nomina
// un'azienda e il documento è di un'altra (o di un subappaltatore), Jarvis rifiuta e non prepara niente; il destinatario
// deve essere una controparte dell'azienda (una sola).
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { trovaAziende, nomiAziende } from "../aziende.js";
import type { VoceDocumento } from "../costructo.js";
import { creaProposta } from "../proposte/archivio.js";
import { contropartiDi, contropartiPerNome, documentiDi, documentoDellAzienda } from "./costructoLetture.js";
import { dataBreve, normalizza } from "./date.js";

export interface EsitoInvioDocumenti { propostaId?: string; domanda?: string; rifiuto?: string }

const nomeDoc = (v: VoceDocumento) => String(v.titolo || v.nome || v.tipoDocumento || v.tipo || v.id);
/** Nome, identificativo e scadenza: quello che Luigi deve vedere prima di confermare. */
const descriviDoc = (v: VoceDocumento) => { const s = v.scadenza || v.dataScadenza; return `${nomeDoc(v)} (ID ${v.id ?? "?"}${s ? `, scade il ${dataBreve(s)}` : ""})`; };

/** Aziende nominate nel messaggio di Luigi (per nome intero). */
export function aziendeNominate(messaggio: string, aziende: Array<{ id: string; nome: string }>): string[] {
  const m = ` ${normalizza(messaggio).replace(/[^a-z0-9]+/g, " ")} `;
  return aziende.filter((a) => { const n = normalizza(a.nome).replace(/[^a-z0-9]+/g, " ").trim(); return n.length >= 3 && m.includes(` ${n} `); }).map((a) => a.id);
}

export async function preparaInvioDocumenti(db: Db, collegate: AziendaCollegata[], r: { destinatario: string; documento: string; azienda: string }, messaggioLuigi: string, ora = Date.now()): Promise<EsitoInvioDocumenti> {
  const aziende = collegate.filter((a) => a.client.configurato);
  if (!aziende.length) return { rifiuto: "Costructo non è collegato." };
  let scelte = r.azienda.trim() ? trovaAziende(aziende, r.azienda) : aziende.length === 1 ? aziende : [];
  if (scelte.length !== 1) return { domanda: `Di quale azienda è il documento: ${nomiAziende(aziende)}?` };
  const a = scelte[0];
  // Luigi ha nominato un'altra azienda nel suo messaggio: niente (meglio chiedere che mandare il documento sbagliato).
  const nominate = aziendeNominate(messaggioLuigi, aziende);
  if (nominate.length && !nominate.includes(a.id)) {
    return { rifiuto: `Hai nominato ${aziende.filter((x) => nominate.includes(x.id)).map((x) => x.nome).join(" e ")}, ma il documento cercato è di ${a.nome}: non preparo niente. Dimmi di quale azienda è.` };
  }
  scelte = [a];
  const voci = await documentiDi(db, a, ora);
  const q = normalizza(r.documento).split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
  if (!q.length) return { domanda: "Quale documento devo mandare?" };
  const corrispondono = voci.filter((v) => { const t = normalizza(`${v.titolo ?? ""} ${v.nome ?? ""} ${v.tipoDocumento ?? ""} ${v.tipo ?? ""}`); return q.every((p) => t.includes(p)); });
  if (!corrispondono.length) return { rifiuto: `Non trovo «${r.documento}» tra i documenti di ${a.nome} in Costructo.` };
  // Il documento deve essere DI QUESTA azienda (campo «di_chi» di Costructo, o ditta/intestatario): mai di un subappaltatore o di altri.
  const propri = corrispondono.filter((v) => documentoDellAzienda(v, a.nome));
  const altrui = corrispondono.filter((v) => !propri.includes(v));
  if (!propri.length) return { rifiuto: `Il documento «${r.documento}» che ho trovato non è di ${a.nome} (è intestato a ${altrui.map((v) => v.ditta || v.intestatario || v.azienda || v.di_chi || "altri").join(", ")}): non lo preparo.` };
  if (propri.length > 1) return { domanda: `Ho trovato ${propri.length} documenti «${r.documento}» di ${a.nome}: quale mando? ${propri.slice(0, 5).map(descriviDoc).join("; ")}.` };
  const doc = propri[0];
  if (!doc.id) return { rifiuto: "Il documento in Costructo non ha un identificativo: non posso prepararlo." };
  const controparti = await contropartiDi(db, a, ora);
  const dest = contropartiPerNome(r.destinatario, controparti);
  if (!dest.length) return { rifiuto: `Non trovo «${r.destinatario}» tra le controparti di ${a.nome} in Costructo: dimmi il nome esatto.` };
  if (dest.length > 1 || !dest[0].id) return { domanda: `A chi, di preciso? ${dest.slice(0, 5).map((d) => d.nome || d.ragioneSociale).join(", ")}.` };
  const destinatario = String(dest[0].nome || dest[0].ragioneSociale);
  const controparteId = String(dest[0].id);
  const voceIds = [String(doc.id)];
  const chiave = `jarvis:invio:${a.id}:${createHash("sha256").update(`${voceIds.join(",")}|${controparteId}|${new Date(ora).toISOString().slice(0, 10)}`).digest("hex").slice(0, 24)}`;
  const p = creaProposta(db, {
    tipo: "invio_documenti", aziendaId: a.id, chiave, origine: "jarvis", titolo: `Mandare ${nomeDoc(doc)} a ${destinatario}`,
    dati: { voceIds, destinatario, controparteId }, nomi: { voceIds: descriviDoc(doc), destinatario, controparteId: destinatario },
    note: ["Costructo manda i documenti dal suo flusso dopo la tua approvazione: Jarvis non manda niente."],
  }, ora);
  return { propostaId: p.proposta.id };
}
