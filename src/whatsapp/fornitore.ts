// Operazioni sul collegamento (parte 2), chiamate SOLO da Luigi con un pulsante in Impostazioni → WhatsApp:
//  1) «Configura il webhook su 360dialog»: Jarvis genera un segreto casuale e scrive su 360dialog
//     POST {indirizzo}/v1/configs/webhook {"url": <indirizzo di Jarvis>/api/whatsapp/webhook, "headers": {"X-Jarvis-Segreto": <segreto>}}.
//     Luigi non vede mai il segreto: 360dialog lo rimanda in ogni webhook e Jarvis lo confronta a tempo costante.
//  2) «Prova collegamento»: Meta → GET /{phone_number_id}?fields=is_on_biz_app,platform_type (atteso true / CLOUD_API);
//     360dialog → GET {indirizzo}{percorso della prova} (di serie /health_status) [non verificato].
//  3) «Sincronizza chat (una volta, entro 24 ore)»: contatti (smb_app_state_sync) e poi storico (history).
//     Meta → POST /{phone_number_id}/smb_app_data; 360dialog → POST {indirizzo}{percorso} (di serie /smb_app_data) [non verificato].
//     Dopo un esito positivo non si ripete più.
// Sempre: nessun reindirizzamento, tempo massimo 15 secondi, la chiave va solo all'indirizzo configurato (ricontrollato
// anche con il DNS), errori spiegati in italiano, mai un segreto nel registro o nelle risposte.
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import type { RisolviNome } from "../calendario.js";
import { registra } from "../registro.js";
import {
  BASE_META, INTESTAZIONE_SEGRETO, DURATA_PRECEDENTE_MS, controllaFornitoreInRete, controllaUrlWebhook, indirizzoWebhook,
  leggiCollegamento, nuovoSegretoWebhook, scriviCollegamento,
} from "./collegamento.js";
import { intestazioniInvio } from "./invio.js";
import { spiegaErroreMeta } from "./elabora.js";
import { leggiConnessione, leggiSync, scriviPasso, syncFatta, type PassoSync, type StatoSync } from "./connessione.js";
import { ErroreWhatsapp, type CollegamentoWa } from "./tipi.js";

export interface OpzioniFornitore {
  db: Db; cifratore: Cifratore; fetchFn?: typeof fetch; risolvi?: RisolviNome; ora?: () => number; timeoutMs?: number;
}

interface RispostaHttp { stato: number; dati: Record<string, unknown> }
/** Esito di rete: «mai partita» (si può riprovare), «incerta» (tempo scaduto o connessione caduta). */
class ReteNonRaggiunta extends Error {}
class ReteIncerta extends Error {}
const PRIMA_DI_PARTIRE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/;

async function chiama(o: OpzioniFornitore, c: CollegamentoWa, url: string, metodo: "GET" | "POST", corpo?: unknown): Promise<RispostaHttp> {
  const h = intestazioniInvio(c);
  if (!corpo) delete h["Content-Type"];
  let r: Response;
  try {
    r = await (o.fetchFn ?? fetch)(url, {
      method: metodo, headers: h, ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const x = e as { code?: string; cause?: { code?: string } };
    if (PRIMA_DI_PARTIRE.test(String(x?.cause?.code ?? x?.code ?? ""))) throw new ReteNonRaggiunta();
    throw new ReteIncerta();
  }
  const grezzo = (await r.text().catch(() => "")).slice(0, 64 * 1024);
  let dati: Record<string, unknown> = {};
  try { const j = JSON.parse(grezzo); if (j && typeof j === "object") dati = j as Record<string, unknown>; } catch { /* non JSON */ }
  return { stato: r.status, dati };
}

const codiceErrore = (d: Record<string, unknown>) => {
  const e = d.error as { code?: unknown; message?: unknown } | undefined;
  return { codice: typeof e?.code === "number" ? e.code : undefined, testo: typeof e?.message === "string" ? e.message : undefined };
};

function richiedi360(c: CollegamentoWa | null): asserts c is CollegamentoWa {
  if (!c || c.provider !== "360dialog") throw new ErroreWhatsapp("Questa operazione serve solo con 360dialog: scegli 360dialog e salva.", 409);
  if (!c.token) throw new ErroreWhatsapp("Prima scrivi la chiave API di 360dialog e premi Salva.", 409);
}

// ---------------------------------------------------------------- 1) webhook su 360dialog
export interface EsitoOperazione { ok: boolean; messaggio: string }

export async function configuraWebhook360(o: OpzioniFornitore, origini: string[]): Promise<EsitoOperazione> {
  const c = leggiCollegamento(o);
  richiedi360(c);
  const url = controllaUrlWebhook(indirizzoWebhook(origini));
  const base = await controllaFornitoreInRete(c.baseUrl, o.risolvi);
  const ora = o.ora?.() ?? Date.now();
  const segreto = nuovoSegretoWebhook();
  // Il segreto nuovo si salva PRIMA della chiamata (così i primi webhook con il segreto nuovo passano); il vecchio
  // vale ancora un'ora. Se 360dialog dice sicuramente di no, si torna come prima.
  const conNuovo: CollegamentoWa = {
    ...c, webhookSecret: segreto,
    webhookSecretPrecedente: c.webhookSecret, precedenteFino: c.webhookSecret ? ora + DURATA_PRECEDENTE_MS : 0,
  };
  scriviCollegamento(o, conNuovo);
  const torna = () => scriviCollegamento(o, c);
  let r: RispostaHttp;
  try {
    r = await chiama(o, c, `${base}/v1/configs/webhook`, "POST", { url, headers: { [INTESTAZIONE_SEGRETO]: segreto } });
  } catch (e) {
    if (e instanceof ReteNonRaggiunta) {
      torna();
      registra(o.db, "whatsapp.webhook360", "errore", "luigi", { motivo: "360dialog non raggiungibile" });
      return { ok: false, messaggio: "360dialog non risponde (rete). Non ho cambiato niente: riprova più tardi." };
    }
    registra(o.db, "whatsapp.webhook360", "errore", "luigi", { motivo: "esito incerto" });
    return { ok: false, messaggio: "360dialog non ha risposto in tempo: non so se ha salvato. Riprova tra qualche minuto (non fa danni)." };
  }
  if (r.stato >= 200 && r.stato < 300) {
    scriviCollegamento(o, { ...conNuovo, webhookConfigurato: ora });
    registra(o.db, "whatsapp.webhook360", "fatto", "luigi", { operazione: "webhook configurato su 360dialog" });
    return { ok: true, messaggio: "Fatto: 360dialog ora manda i messaggi a Jarvis, con l'intestazione segreta. Il segreto non lo vedi: lo tiene Jarvis." };
  }
  if (r.stato >= 500) {
    registra(o.db, "whatsapp.webhook360", "errore", "luigi", { motivo: `esito incerto (${r.stato})` });
    return { ok: false, messaggio: `360dialog ha avuto un problema (${r.stato}): non so se ha salvato. Riprova tra qualche minuto.` };
  }
  torna();
  registra(o.db, "whatsapp.webhook360", "errore", "luigi", { motivo: `rifiutato (${r.stato})` });
  const { testo } = codiceErrore(r.dati);
  return {
    ok: false,
    messaggio: r.stato === 401 || r.stato === 403
      ? "360dialog non accetta la chiave API: controllala e salvala di nuovo. Non ho cambiato niente."
      : `360dialog ha rifiutato la configurazione (${r.stato})${testo ? `: ${testo.slice(0, 120)}` : ""}. Non ho cambiato niente.`,
  };
}

// ---------------------------------------------------------------- 2) prova del collegamento
export interface EsitoProva extends EsitoOperazione { dettagli: Record<string, string | boolean> }

export async function provaCollegamento(o: OpzioniFornitore): Promise<EsitoProva> {
  const c = leggiCollegamento(o);
  const no = (messaggio: string): EsitoProva => ({ ok: false, messaggio, dettagli: {} });
  if (!c || !c.token) return no("Prima salva il token (Meta) o la chiave API (360dialog).");
  try {
    if (c.provider === "meta") {
      if (!c.phoneNumberId) return no("Manca l'id del numero (phone_number_id).");
      const r = await chiama(o, c, `${BASE_META}/${encodeURIComponent(c.versione)}/${encodeURIComponent(c.phoneNumberId)}?fields=is_on_biz_app,platform_type`, "GET");
      if (r.stato < 200 || r.stato >= 300) { const e = codiceErrore(r.dati); return no(spiegaErroreMeta(e.codice ?? (r.stato === 401 ? 190 : undefined), e.testo)); }
      const app = r.dati.is_on_biz_app === true, tipo = String(r.dati.platform_type ?? "");
      const dettagli = { appWhatsappBusiness: app, piattaforma: tipo.slice(0, 40) };
      if (app && tipo === "CLOUD_API") return { ok: true, messaggio: "Collegamento a posto: il numero usa l'app WhatsApp Business ed è collegato a Jarvis (coesistenza attiva).", dettagli };
      return { ok: false, messaggio: !app ? "Meta dice che il numero non usa l'app WhatsApp Business in coesistenza." : `Meta dice che il numero non è sulla Cloud API (${tipo || "sconosciuto"}).`, dettagli };
    }
    const base = await controllaFornitoreInRete(c.baseUrl, o.risolvi);
    const r = await chiama(o, c, `${base}${c.percorsoSalute}`, "GET");
    if (r.stato === 404 || r.stato === 405) return no("360dialog non offre questa prova a questo indirizzo (percorso da verificare al primo uso vero). Il resto funziona lo stesso.");
    if (r.stato === 401 || r.stato === 403) return no("360dialog non accetta la chiave API: controllala e salvala di nuovo.");
    if (r.stato < 200 || r.stato >= 300) return no(`360dialog ha risposto con un errore (${r.stato}).`);
    // Forma della risposta non verificata: si mostra solo se c'è qualcosa di riconoscibile.
    const salute = (r.dati.health_status ?? r.dati) as Record<string, unknown>;
    const puo = typeof salute.can_send_message === "string" ? salute.can_send_message.slice(0, 40) : "";
    return { ok: !puo || puo === "AVAILABLE", messaggio: puo && puo !== "AVAILABLE" ? `360dialog risponde, ma dice che ora l'invio non è disponibile (${puo}).` : "360dialog risponde e accetta la chiave API.", dettagli: puo ? { invio: puo } : {} };
  } catch (e) {
    if (e instanceof ErroreWhatsapp) return no(e.message);
    if (e instanceof ReteNonRaggiunta || e instanceof ReteIncerta) return no("Il servizio non risponde in questo momento: riprova più tardi.");
    return no("Prova non riuscita.");
  }
}

// ---------------------------------------------------------------- 3) sincronizzazione (una volta sola)
const inCorso = new WeakSet<Db>();
const TIPO_SYNC: Record<PassoSync, string> = { contatti: "smb_app_state_sync", storico: "history" };

export interface EsitoSync extends EsitoOperazione { sync: StatoSync }

export async function sincronizzaChat(o: OpzioniFornitore): Promise<EsitoSync> {
  const c = leggiCollegamento(o);
  if (!c || !c.token) throw new ErroreWhatsapp("Prima salva il collegamento (token o chiave API).", 409);
  if (c.provider === "meta" && !c.phoneNumberId) throw new ErroreWhatsapp("Manca l'id del numero (phone_number_id).", 409);
  if (syncFatta(leggiSync(o.db))) throw new ErroreWhatsapp("La sincronizzazione è già stata fatta: si fa una volta sola.", 409);
  if (inCorso.has(o.db)) throw new ErroreWhatsapp("La sincronizzazione è già in corso.", 409);
  inCorso.add(o.db);
  try {
    const url = c.provider === "meta"
      ? `${BASE_META}/${encodeURIComponent(c.versione)}/${encodeURIComponent(c.phoneNumberId)}/smb_app_data`
      : `${await controllaFornitoreInRete(c.baseUrl, o.risolvi)}${c.percorsoSync}`;
    for (const passo of ["contatti", "storico"] as PassoSync[]) {
      if (leggiSync(o.db)[passo].stato === "fatto") continue;
      const ora = o.ora?.() ?? Date.now();
      let esito: { stato: "fatto" | "errore" | "incerto"; esito: string };
      try {
        const r = await chiama(o, c, url, "POST", { messaging_product: "whatsapp", sync_type: TIPO_SYNC[passo] });
        if (r.stato >= 200 && r.stato < 300) esito = { stato: "fatto", esito: "ok" };
        else if (r.stato >= 500) esito = { stato: "incerto", esito: `errore del servizio (${r.stato})` };
        else { const e = codiceErrore(r.dati); esito = { stato: "errore", esito: c.provider === "meta" ? spiegaErroreMeta(e.codice, e.testo) : `rifiutata (${r.stato})${e.testo ? `: ${e.testo.slice(0, 100)}` : ""}` }; }
      } catch (e) {
        esito = e instanceof ReteNonRaggiunta ? { stato: "errore", esito: "servizio non raggiungibile" } : { stato: "incerto", esito: "nessuna risposta in tempo" };
      }
      scriviPasso(o.db, passo, { ...esito, quando: ora });
      registra(o.db, "whatsapp.sincronizza", esito.stato === "fatto" ? "fatto" : "errore", "luigi", { passo, esito: esito.esito.slice(0, 120) });
      if (esito.stato !== "fatto") break; // prima i contatti, poi lo storico: se il primo non va, il secondo aspetta
    }
    const sync = leggiSync(o.db);
    const conn = leggiConnessione(o.db);
    const tardi = conn && (o.ora?.() ?? Date.now()) - conn.collegatoIl > 24 * 3600_000;
    if (syncFatta(sync)) return { ok: true, messaggio: "Sincronizzazione chiesta: contatti e storico arriveranno a Jarvis nei prossimi minuti (o ore). Non va più ripetuta.", sync };
    return {
      ok: false, sync,
      messaggio: `Sincronizzazione non completata: ${[sync.contatti, sync.storico].find((p) => p.stato !== "fatto")?.esito || "errore"}. Puoi riprovare.${tardi ? " Attenzione: sono passate più di 24 ore dal collegamento, Meta potrebbe non accettarla più." : ""}`,
    };
  } finally { inCorso.delete(o.db); }
}
