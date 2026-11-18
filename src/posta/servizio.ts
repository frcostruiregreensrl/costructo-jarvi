// Il giro della posta, ogni 5 minuti (più il pulsante «Aggiorna ora»):
// 1) legge le mail nuove di ogni casella (sola lettura); 2) filtro gratuito e riassunti con l'AI;
// 3) conferme di ricezione automatiche (solo se tutte le regole lo permettono); 4) notifica delle mail urgenti.
// Un solo giro alla volta: se ne parte un altro mentre il primo è in corso, si aspetta quello.
import { registra } from "../registro.js";
import { inviaATutti } from "../push.js";
import { leggiCaselle, nomeSpazio } from "./caselle.js";
import { leggiNuove, type EsitoLettura } from "./lettura.js";
import { classificaNuove, type EsitoClassifica } from "./classifica.js";
import { mandaConferme } from "./rispostaAuto.js";
import { leggiStatoLettura, segnaNotifica } from "./archivio.js";
import type { DipendenzePosta, MessaggioPosta } from "./tipi.js";

export const OGNI_MS = 5 * 60_000;
/** Al massimo una notifica di mail urgenti per casella ogni 30 minuti (le altre si raggruppano nella successiva). */
export const PAUSA_NOTIFICHE_MS = 30 * 60_000;

export interface EsitoGiro { caselle: EsitoLettura[]; classifica: EsitoClassifica | null; conferme: number; notifiche: number }

/**
 * Notifiche delle mail urgenti nuove: una per casella (con il nome dell'azienda o «Privato»),
 * al massimo una ogni 30 minuti per casella. Le urgenti arrivate nel frattempo finiscono nella notifica successiva.
 */
export async function notificaUrgenti(dip: DipendenzePosta): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const urgenti = db.prepare("SELECT * FROM posta_messaggi WHERE urgente = 1 AND notificata = 0 AND nuova = 1 ORDER BY data").all() as MessaggioPosta[];
  if (!urgenti.length) return 0;
  const caselle = new Map(leggiCaselle(dip).map((c) => [c.id, c]));
  const aziende = dip.aziende();
  const perCasella = new Map<string, MessaggioPosta[]>();
  for (const m of urgenti) perCasella.set(m.casella_id, [...(perCasella.get(m.casella_id) ?? []), m]);
  const segna = db.prepare("UPDATE posta_messaggi SET notificata = 1 WHERE id = ?");
  let inviate = 0;
  for (const [id, lista] of perCasella) {
    const c = caselle.get(id);
    if (!c) { for (const m of lista) segna.run(m.id); continue; }
    const ultima = leggiStatoLettura(db, id)?.ultimaNotifica ?? 0;
    if (ora - ultima < PAUSA_NOTIFICHE_MS) continue; // si raggruppano nella prossima
    if (!dip.invia) { for (const m of lista) segna.run(m.id); continue; }
    const dove = nomeSpazio(c.spazio, aziende);
    const primo = lista[0];
    const titolo = `Mail urgente · ${dove}`.slice(0, 80);
    const testo = `${c.nome}: ${lista.length === 1 ? "1 mail urgente" : `${lista.length} mail urgenti`}. ${primo.da_nome || primo.da_indirizzo}: ${primo.oggetto || primo.riassunto}`.slice(0, 180);
    await inviaATutti(db, dip.invia, titolo, testo, "notifica.posta", "/#posta");
    segnaNotifica(db, id, ora);
    for (const m of lista) segna.run(m.id);
    inviate++;
  }
  return inviate;
}

export function creaServizioPosta(dip: DipendenzePosta) {
  let giro: Promise<EsitoGiro> | null = null;

  async function faiGiro(): Promise<EsitoGiro> {
    const esito: EsitoGiro = { caselle: [], classifica: null, conferme: 0, notifiche: 0 };
    const caselle = leggiCaselle(dip);
    if (!caselle.length) return esito;
    for (const c of caselle) esito.caselle.push(await leggiNuove(dip, c));
    try { esito.classifica = await classificaNuove(dip); } catch (e) { registra(dip.db, "posta.classifica", "errore", "sistema", { motivo: String((e as Error)?.message || e).slice(0, 200) }); }
    try { esito.conferme = await mandaConferme(dip); } catch (e) { registra(dip.db, "posta.conferma_automatica", "errore", "sistema", { motivo: String((e as Error)?.message || e).slice(0, 200) }); }
    try { esito.notifiche = await notificaUrgenti(dip); } catch (e) { registra(dip.db, "notifica.posta", "errore", "sistema", { motivo: String((e as Error)?.message || e).slice(0, 200) }); }
    return esito;
  }

  const servizio = {
    dip,
    /** Un giro adesso (o aspetta quello già in corso). */
    controllaOra(): Promise<EsitoGiro> {
      giro ??= faiGiro().finally(() => { giro = null; });
      return giro;
    },
    inCorso: () => giro !== null,
    /** Avvia il controllo periodico (ogni 5 minuti; il primo dopo 20 secondi dall'avvio). */
    avvia(): void {
      const scatta = () => { servizio.controllaOra().catch(() => {}); };
      setTimeout(scatta, 20_000).unref();
      setInterval(scatta, OGNI_MS).unref();
    },
  };
  return servizio;
}
export type ServizioPosta = ReturnType<typeof creaServizioPosta>;
