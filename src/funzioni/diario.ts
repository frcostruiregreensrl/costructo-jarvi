// Bozza del diario di cantiere (funzione 20): messaggi, foto e proposte del giorno legati al cantiere → proposta «diario»
// per Costructo (da confermare). Testo scritto senza AI, con quello che è successo davvero (niente frasi inventate).
// Se la bozza del giorno c'è già e non è ancora partita, si aggiorna (nuova impronta: va riconfermata).
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { oraMinuti } from "../tempo.js";
import { leggiContatto, nomeContatto } from "../whatsapp/archivio.js";
import { creaProposta, leggiProposta, datiDi } from "../proposte/archivio.js";
import { ErroreProposte } from "../proposte/tipi.js";
import { cantieriDi } from "./costructoLetture.js";
import { dataBreve, inizioData } from "./date.js";

export async function preparaDiario(db: Db, collegate: AziendaCollegata[], aziendaId: string, cantiereId: string, data: string, fuso: string, ora = Date.now()): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroreProposte("Giorno non valido.");
  const a = collegate.find((x) => x.id === aziendaId && x.client.configurato);
  if (!a) throw new ErroreProposte("Questa azienda non è collegata a Costructo.");
  const cantiere = (await cantieriDi(db, a, ora)).find((c) => c.id === cantiereId);
  if (!cantiere) throw new ErroreProposte("Cantiere non trovato in Costructo.", 404);
  const da = inizioData(data, fuso), fino = da + 864e5;
  const righe = db.prepare(`SELECT m.quando, m.tipo, m.testo, m.riassunto, m.contatto_id, m.direzione FROM wa_analisi w JOIN wa_messaggi m ON m.id = w.messaggio_id
      WHERE w.azienda_id = ? AND w.cantiere_id = ? AND m.quando >= ? AND m.quando < ? ORDER BY m.quando`).all(aziendaId, cantiereId, da, fino) as
    Array<{ quando: number; tipo: string; testo: string; riassunto: string; contatto_id: string; direzione: string }>;
  const foto = db.prepare(`SELECT dati, allegati FROM proposte WHERE azienda_id = ? AND tipo = 'foto' AND creata >= ? AND creata < ?`).all(aziendaId, da, fino) as Array<{ dati: string; allegati: string }>;
  let fatti = 0, problemi = 0;
  for (const f of foto) {
    const d = datiDi(f);
    if (String(d.cantiereId ?? "") !== cantiereId) continue;
    let n = 1; try { n = Math.max(1, (JSON.parse(f.allegati) as unknown[]).length); } catch { /* */ }
    if (d.tipo === "problema") problemi += n; else fatti += n;
  }
  const ore = db.prepare(`SELECT dati, avvisi FROM proposte WHERE azienda_id = ? AND tipo = 'ore' AND stato <> 'scartata' AND creata >= ? AND creata < ?`).all(aziendaId, da, fino + 864e5) as Array<{ dati: string; avvisi: string }>;
  const testo: string[] = [`Diario del ${dataBreve(data)} · ${cantiere.nome}`];
  for (const r of righe) {
    if (r.tipo === "image") continue;
    const c = leggiContatto(db, r.contatto_id);
    const chi = r.direzione === "eco" ? "Luigi" : c ? nomeContatto(c) : "Contatto";
    const t = (r.riassunto || r.testo).replace(/\s+/g, " ").trim();
    if (t) testo.push(`- ${oraMinuti(r.quando, fuso)} ${chi}: ${t.slice(0, 200)}`);
  }
  if (fatti || problemi) testo.push(`- Foto: ${[fatti ? `${fatti} di lavori fatti` : "", problemi ? `${problemi} di problemi` : ""].filter(Boolean).join(", ")}.`);
  for (const o of ore) {
    const d = datiDi(o);
    if (String(d.cantiereId ?? "") !== cantiereId || d.data !== data) continue;
    let nome = String(d.operaioId); try { nome = (JSON.parse(o.avvisi) as { nomi?: Record<string, string> }).nomi?.operaioId ?? nome; } catch { /* */ }
    testo.push(`- Ore proposte: ${nome} ${String(d.ore).replace(".", ",")}.`);
  }
  if (testo.length === 1) throw new ErroreProposte("Per questo cantiere e questo giorno non ho trovato messaggi o foto.");
  const dati = { cantiereId, data, testo: testo.join("\n").slice(0, 4000) };
  const chiave = `diario:${aziendaId}:${cantiereId}:${data}`;
  const r = creaProposta(db, { tipo: "diario", aziendaId, chiave, origine: "jarvis", titolo: `Diario ${cantiere.nome} del ${dataBreve(data)}`, dati, nomi: { cantiereId: cantiere.nome } }, ora);
  if (!r.nuova && r.proposta.stato === "da_confermare") {
    db.prepare("UPDATE proposte SET dati = ?, aggiornata = ? WHERE id = ?").run(JSON.stringify(dati), ora, r.proposta.id);
  }
  return leggiProposta(db, r.proposta.id)!.id;
}
