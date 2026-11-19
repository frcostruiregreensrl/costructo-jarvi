// Fase 3, parte 2 — adattamento a 360dialog (coesistenza con l'app WhatsApp Business).
// Tutto con server finti (360dialog finto, Meta finto): nessuna chiamata vera, nessun numero vero, nessun DNS vero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dbProvvisorio, cifratore, avviaAmbiente, type Ambiente } from "./aiuto.js";
import { avviaD360Finto, risolvi360, CHIAVE_360, BASE_360_FINTA, type D360Finto } from "./d360Finto.js";
import { avviaMetaFinto, firma, webhook, ricevuto, eco, PHONE_NUMBER_ID } from "./metaFinto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import type { Db } from "../src/db.js";
import { salvaImpostazioni } from "../src/impostazioni.js";
import { salvaIscrizione, type Invia } from "../src/push.js";
import { creaBriefing } from "../src/briefing.js";
import {
  salvaCollegamento, leggiCollegamento, controllaUrlWebhook, webhookAttivo, scriviCollegamento, INTESTAZIONE_SEGRETO,
} from "../src/whatsapp/collegamento.js";
import { controllaWebhook } from "../src/whatsapp/webhook.js";
import { configuraWebhook360, provaCollegamento, sincronizzaChat } from "../src/whatsapp/fornitore.js";
import { mandaTesto, indirizzoInvio } from "../src/whatsapp/invio.js";
import { scaricaMedia } from "../src/whatsapp/media.js";
import { creaServizioWhatsapp } from "../src/whatsapp/servizio.js";
import { elaboraWebhook, spiegaErroreMeta } from "../src/whatsapp/elabora.js";
import { preparaRisposta, inviaRisposta, improntaRisposta } from "../src/whatsapp/risposte.js";
import { leggiConnessione, segnaCollegato, leggiSync, TESTO_INTERROTTO } from "../src/whatsapp/connessione.js";
import { creaLimitatore, prenotaInvio, riepilogoInviiWa, TettoMessaggi } from "../src/whatsapp/contatore.js";
import { meseDi } from "../src/consumi.js";
import { InvioIncerto, type CollegamentoWa, type ContattoWa, type DipendenzeWhatsapp } from "../src/whatsapp/tipi.js";

const ORIGINI = ["https://jarvis.esempio.it"];
const SEGRETO_APP = "segretoappfinto0123456789abcdef";
const VERIFICA = "parola-di-verifica-finta-123";
const TOKEN_META = "EAAtokenfintosolopertest1234567890";
const MARIO = "393331112222";
const GIORNO = 864e5;
const fonte = (db: Db) => ({ db, cifratore, risolvi: risolvi360 });

function notificheFinte() {
  const inviate: Array<{ titolo: string; testo: string; url: string }> = [];
  const invia: Invia = async (_i, corpo) => { inviate.push(JSON.parse(corpo)); return { statusCode: 201 }; };
  return { inviate, invia };
}

/** Collegamento a 360dialog salvato (chiave + indirizzo di serie), senza webhook configurato. */
async function collega360(db: Db) {
  return salvaCollegamento(fonte(db), { provider: "360dialog", token: CHIAVE_360 });
}

interface Prova { db: Db; d360: D360Finto; dip: DipendenzeWhatsapp; notifiche: ReturnType<typeof notificheFinte>; t: { ora: number }; chiudi: () => Promise<void> }

async function prova(): Promise<Prova> {
  const { db, chiudi } = dbProvvisorio();
  const d360 = await avviaD360Finto();
  await collega360(db);
  const notifiche = notificheFinte();
  salvaIscrizione(db, { endpoint: "https://push.example/finto", keys: { p256dh: "chiave-finta-p256dh", auth: "auth-finta" } });
  const t = { ora: Date.now() };
  const cervello = creaCervelloFinto(() => ({ testo: "ok" }));
  const dip: DipendenzeWhatsapp = {
    db, cifratore, fuso: "Europe/Rome", cervello: async () => cervello, modello: "claude-haiku-5-5",
    aziende: () => [{ id: "a1", nome: "FR Costruire Green" }], aziendeCostructo: () => [],
    invia: notifiche.invia, fetchFn: d360.fetch, ora: () => t.ora, attesaRiprova: async () => {}, risolvi: risolvi360,
  };
  return { db, d360, dip, notifiche, t, chiudi: async () => { await d360.chiudi(); chiudi(); } };
}

const opz = (p: Prova) => ({ db: p.db, cifratore, fetchFn: p.d360.fetch, risolvi: risolvi360, ora: () => p.t.ora });
/** Configura il webhook su 360dialog (finto) e restituisce il segreto che Jarvis ha mandato. */
async function configura(p: { db: Db; d360: D360Finto }, origini = ORIGINI): Promise<string> {
  const e = await configuraWebhook360({ db: p.db, cifratore, fetchFn: p.d360.fetch, risolvi: risolvi360 }, origini);
  assert.equal(e.ok, true, e.messaggio);
  const r = p.d360.richieste.filter((x) => x.percorso === "/v1/configs/webhook").at(-1)!;
  return (r.corpo.headers as Record<string, string>)[INTESTAZIONE_SEGRETO];
}
const contatto = (db: Db, waId: string) => db.prepare("SELECT * FROM wa_contatti WHERE wa_id = ?").get(waId) as ContattoWa;

// ------------------------------------------------------------------ webhook via HTTP

async function ambiente(): Promise<{ a: Ambiente; d360: D360Finto; manda: (corpo: unknown, h?: Record<string, string>) => Promise<Response> }> {
  const d360 = await avviaD360Finto();
  const a = await avviaAmbiente({ fetchWhatsapp: d360.fetch, risolvi: risolvi360 });
  const manda = async (corpo: unknown, h: Record<string, string> = {}) => {
    const r = await fetch(`${a.base}/api/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(corpo) });
    await a.servizi.whatsapp.attendi();
    a.servizi.whatsapp.ferma();
    return r;
  };
  return { a, d360, manda };
}
const messaggiSalvati = (db: Db) => (db.prepare("SELECT COUNT(*) n FROM wa_messaggi").get() as { n: number }).n;

test("360dialog: webhook con intestazione segreta obbligatoria (mancante, sbagliata, giusta); una firma di Meta da sola non basta", async () => {
  const { a, d360, manda } = await ambiente();
  try {
    await collega360(a.db);
    // Chiave salvata ma webhook non configurato: spento (404), anche con una firma «giusta».
    assert.equal(webhookAttivo(leggiCollegamento({ db: a.db, cifratore })), false);
    const corpo = ricevuto({ da: MARIO, testo: "Buongiorno" });
    assert.equal((await manda(corpo, { "X-Hub-Signature-256": firma(JSON.stringify(corpo), SEGRETO_APP) })).status, 404);
    const segreto = await configura({ db: a.db, d360 });
    assert.ok(segreto.length >= 43, "segreto di almeno 32 byte");
    assert.equal((await manda(ricevuto({ da: MARIO }))).status, 401, "intestazione mancante");
    assert.equal((await manda(ricevuto({ da: MARIO }), { [INTESTAZIONE_SEGRETO]: "sbagliato" })).status, 401, "intestazione sbagliata");
    assert.equal((await manda(ricevuto({ da: MARIO }), { [INTESTAZIONE_SEGRETO]: segreto.slice(0, -1) })).status, 401, "intestazione quasi giusta");
    const conFirma = ricevuto({ da: MARIO });
    assert.equal((await manda(conFirma, { "X-Hub-Signature-256": firma(JSON.stringify(conFirma), SEGRETO_APP) })).status, 401, "solo la firma di Meta: no");
    assert.equal(messaggiSalvati(a.db), 0, "niente salvato");
    assert.equal((await manda(ricevuto({ da: MARIO, testo: "Ciao" }), { [INTESTAZIONE_SEGRETO]: segreto })).status, 200);
    assert.equal(messaggiSalvati(a.db), 1);
    // Con il segreto dell'app impostato, una firma presente ma sbagliata fa rifiutare anche con l'intestazione giusta.
    await salvaCollegamento(fonte(a.db), { appSecret: SEGRETO_APP });
    const doppio = ricevuto({ da: MARIO, testo: "Doppio controllo" });
    assert.equal((await manda(doppio, { [INTESTAZIONE_SEGRETO]: segreto, "X-Hub-Signature-256": firma("altro", SEGRETO_APP) })).status, 401);
    assert.equal((await manda(doppio, { [INTESTAZIONE_SEGRETO]: segreto, "X-Hub-Signature-256": firma(JSON.stringify(doppio), SEGRETO_APP) })).status, 200);
    const reg = JSON.stringify(a.db.prepare("SELECT * FROM registro").all());
    assert.ok(reg.includes("intestazione segreta mancante") && reg.includes("intestazione segreta non valida"), "rifiuti nel registro");
    assert.ok(!reg.includes(segreto), "il segreto non è nel registro");
  } finally { await a.chiudi(); await d360.chiudi(); }
});

test("Meta diretto: la firma resta obbligatoria; l'intestazione segreta non la sostituisce; cambiare fornitore non apre il webhook", async () => {
  const { a, d360, manda } = await ambiente();
  try {
    await collega360(a.db);
    const segreto = await configura({ db: a.db, d360 });
    // 360dialog → Meta: serve riscrivere il token; il segreto dell'intestazione sparisce.
    await assert.rejects(salvaCollegamento(fonte(a.db), { provider: "meta", phoneNumberId: PHONE_NUMBER_ID }), /riscrivi il token/);
    await salvaCollegamento(fonte(a.db), { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: TOKEN_META });
    const c = leggiCollegamento({ db: a.db, cifratore })!;
    assert.equal(c.webhookSecret, "", "segreto di 360dialog cancellato");
    assert.equal((await manda(ricevuto({ da: MARIO }), { [INTESTAZIONE_SEGRETO]: segreto })).status, 404, "Meta senza segreto dell'app: spento");
    await salvaCollegamento(fonte(a.db), { appSecret: SEGRETO_APP, verifyToken: VERIFICA });
    assert.equal((await manda(ricevuto({ da: MARIO }), { [INTESTAZIONE_SEGRETO]: segreto })).status, 401, "con Meta l'intestazione non basta");
    const ok = ricevuto({ da: MARIO, testo: "Firmato" });
    assert.equal((await manda(ok, { "X-Hub-Signature-256": firma(JSON.stringify(ok), SEGRETO_APP) })).status, 200);
    // Meta → 360dialog: il webhook resta spento finché Jarvis non riconfigura (la firma di Meta non basta più).
    await salvaCollegamento(fonte(a.db), { provider: "360dialog", token: CHIAVE_360 });
    const dopo = ricevuto({ da: MARIO, testo: "Dopo il cambio" });
    assert.equal((await manda(dopo, { "X-Hub-Signature-256": firma(JSON.stringify(dopo), SEGRETO_APP), [INTESTAZIONE_SEGRETO]: segreto })).status, 404, "il vecchio segreto non vale più");
  } finally { await a.chiudi(); await d360.chiudi(); }
});

test("controllo del webhook: il segreto precedente vale solo per un'ora dopo il cambio", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const c: CollegamentoWa = {
      ...(await collega360(db)), webhookSecret: "nuovo-segreto-0123456789abcdefghijklmnopq", webhookSecretPrecedente: "vecchio-segreto-0123456789abcdefghijklmn", precedenteFino: 1_000_000,
    };
    const corpo = Buffer.from("{}");
    assert.equal(controllaWebhook(c, corpo, { "x-jarvis-segreto": c.webhookSecret }, 2_000_000), "");
    assert.equal(controllaWebhook(c, corpo, { "x-jarvis-segreto": c.webhookSecretPrecedente }, 999_999), "");
    assert.equal(controllaWebhook(c, corpo, { "x-jarvis-segreto": c.webhookSecretPrecedente }, 1_000_001), "intestazione segreta non valida");
    assert.equal(controllaWebhook(c, corpo, { "x-jarvis-segreto": [c.webhookSecret, "altro"] }, 0), "intestazione segreta mancante", "intestazione doppia rifiutata");
    assert.equal(controllaWebhook({ ...c, provider: "meta", appSecret: SEGRETO_APP }, corpo, { "x-jarvis-segreto": c.webhookSecret }), "firma mancante");
  } finally { chiudi(); }
});

// ------------------------------------------------------------------ configurazione del webhook su 360dialog

test("Configura il webhook: indirizzo giusto, chiave D360-API-KEY, intestazione segreta; rifiuta «_» e porte; un rifiuto lascia tutto com'era", async () => {
  const p = await prova();
  try {
    const segreto = await configura(p);
    const r = p.d360.richieste[0];
    assert.equal(r.metodo, "POST");
    assert.equal(r.host, "waba-v2.360dialog.io");
    assert.equal(r.percorso, "/v1/configs/webhook");
    assert.equal(r.intestazioni["d360-api-key"], CHIAVE_360);
    assert.ok(!r.intestazioni.authorization);
    assert.equal(r.redirect, "error", "niente reindirizzamenti");
    assert.equal(r.corpo.url, "https://jarvis.esempio.it/api/whatsapp/webhook");
    assert.deepEqual(Object.keys(r.corpo.headers as object), [INTESTAZIONE_SEGRETO]);
    const c = leggiCollegamento(p.dip)!;
    assert.equal(c.webhookSecret, segreto);
    assert.ok(c.webhookConfigurato > 0);
    // Indirizzi che 360dialog non accetta: niente chiamata.
    for (const o of [["https://jarvis_luigi.esempio.it"], ["https://jarvis.esempio.it:8443"], ["http://jarvis.esempio.it"], ["https://jarvis.esempio.it/a_b"]]) {
      await assert.rejects(configuraWebhook360(opz(p), o), /trattino basso|porta|https/, o[0]);
    }
    assert.throws(() => controllaUrlWebhook("https://x.esempio.it:443/api"), /porta/);
    assert.equal(p.d360.richieste.length, 1, "nessuna chiamata con un indirizzo non valido");
    // 360dialog rifiuta (401): il segreto resta quello di prima.
    p.d360.prossime.push({ stato: 401, corpo: { error: { message: "Invalid API key" } } });
    const no = await configuraWebhook360(opz(p), ORIGINI);
    assert.equal(no.ok, false);
    assert.match(no.messaggio, /chiave API/);
    assert.equal(leggiCollegamento(p.dip)!.webhookSecret, segreto, "rifiuto: si torna come prima");
    // 360dialog non risponde bene (500): esito incerto, segreto nuovo + il vecchio valido per un'ora.
    p.d360.prossime.push({ stato: 500 });
    const incerto = await configuraWebhook360(opz(p), ORIGINI);
    assert.equal(incerto.ok, false);
    const c2 = leggiCollegamento(p.dip)!;
    assert.notEqual(c2.webhookSecret, segreto);
    assert.equal(c2.webhookSecretPrecedente, segreto);
    assert.ok(c2.precedenteFino > Date.now());
    // Un reindirizzamento non si segue mai.
    p.d360.prossime.push({ stato: 302, intestazioni: { Location: "https://altro.esempio.it/v1/configs/webhook" } });
    assert.equal((await configuraWebhook360(opz(p), ORIGINI)).ok, false);
    assert.ok(!p.d360.richieste.some((x) => x.host === "altro.esempio.it"));
  } finally { await p.chiudi(); }
});

test("rotte: configura il webhook richiede https (JARVIS_ORIGINE); chiave API e segreto mai restituiti né nel registro; cifrati", async () => {
  const { a, d360 } = await ambiente();
  try {
    await a.accedi();
    const s = await a.chiama("/api/whatsapp/collegamento", { method: "PUT", json: { provider: "360dialog", token: CHIAVE_360 } });
    assert.equal(s.status, 200);
    const j = await s.json();
    assert.equal(j.provider, "360dialog");
    assert.equal(j.baseUrl, BASE_360_FINTA, "indirizzo di serie");
    assert.equal(j.tokenImpostato, true);
    assert.match(j.stato, /Configura il webhook/);
    assert.ok(j.connessione && j.connessione.stato === "attivo", "collegamento segnato");
    // Origine di prova in http: 360dialog vuole https → rifiutato prima di chiamare.
    const r = await a.chiama("/api/whatsapp/360dialog/webhook", { method: "POST", json: {} });
    assert.equal(r.status, 400);
    assert.match((await r.json()).errore, /https/);
    assert.equal(d360.richieste.length, 0);
    // Configurato dalla funzione (indirizzo https), poi si controlla che niente esca.
    const segreto = await configura({ db: a.db, d360 });
    for (const percorso of ["/api/whatsapp/collegamento", "/api/impostazioni", "/api/whatsapp/chat?vista=tutto", "/api/avvio", "/api/spesa"]) {
      const t = await (await a.chiama(percorso)).text();
      for (const x of [CHIAVE_360, segreto, CHIAVE_360.slice(-6), segreto.slice(-6)]) assert.ok(!t.includes(x), `${percorso} contiene un segreto`);
    }
    const reg = JSON.stringify(a.db.prepare("SELECT * FROM registro").all());
    for (const x of [CHIAVE_360, segreto]) assert.ok(!reg.includes(x), "nessun segreto nel registro");
    const grezzo = (a.db.prepare("SELECT valore FROM segreti WHERE nome = 'whatsapp'").get() as { valore: string }).valore;
    assert.ok(grezzo.startsWith("v1.") && !grezzo.includes(CHIAVE_360) && !grezzo.includes(segreto), "cifrati");
    const vis = await (await a.chiama("/api/whatsapp/collegamento")).json();
    assert.equal(vis.segretoWebhookImpostato, true);
    assert.equal(vis.webhookAttivo, true);
    assert.match(vis.controlloWebhook, /intestazione segreta/);
    // Sincronizzazione dalla pagina: senza conferma no.
    assert.equal((await a.chiama("/api/whatsapp/sincronizza", { method: "POST", json: {} })).status, 400);
    const sync = await a.chiama("/api/whatsapp/sincronizza", { method: "POST", json: { conferma: true } });
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).stato.sync.fatta, true);
    assert.equal((await a.chiama("/api/whatsapp/sincronizza", { method: "POST", json: { conferma: true } })).status, 409, "una volta sola");
    // Prova collegamento dalla pagina
    const pr = await (await a.chiama("/api/whatsapp/prova", { method: "POST", json: {} })).json();
    assert.equal(pr.ok, true);
    // Scollega: stato e sincronizzazione dimenticati
    const via = await (await a.chiama("/api/whatsapp/collegamento", { method: "DELETE" })).json();
    assert.equal(via.connessione, null);
    assert.equal(via.sync.fatta, false);
  } finally { await a.chiudi(); await d360.chiudi(); }
});

// ------------------------------------------------------------------ invio e allegati

test("invio con 360dialog: POST {indirizzo}/messages senza phone_number_id, chiave D360-API-KEY, niente Authorization", async () => {
  const p = await prova();
  try {
    const c = { ...(await salvaCollegamento(fonte(p.db), { phoneNumberId: PHONE_NUMBER_ID })) };
    assert.equal(indirizzoInvio(c), `${BASE_360_FINTA}/messages`, "l'id del numero non va nel percorso");
    const id = await mandaTesto(c, { waId: MARIO, userId: "" }, "Ciao", { fetchFn: p.d360.fetch, risolvi: risolvi360 });
    assert.match(id, /^wamid\.360/);
    const r = p.d360.richieste[0];
    assert.equal(r.percorso, "/messages");
    assert.equal(r.intestazioni["d360-api-key"], CHIAVE_360);
    assert.ok(!r.intestazioni.authorization);
    assert.equal(r.redirect, "error");
    assert.deepEqual(r.corpo, { messaging_product: "whatsapp", recipient_type: "individual", to: MARIO, type: "text", text: { preview_url: false, body: "Ciao" } });
  } finally { await p.chiudi(); }
});

test("allegati con 360dialog: url di Meta → stesso percorso su 360dialog; altri indirizzi rifiutati; niente reindirizzamenti; dimensioni", async () => {
  const p = await prova();
  try {
    const dati = Buffer.from("%PDF-1.4 finto");
    p.d360.media["MEDIA1"] = { mime: "application/pdf", dati };
    const c = leggiCollegamento(p.dip);
    const s = await scaricaMedia(c, "MEDIA1", { fetchFn: p.d360.fetch, risolvi: risolvi360 });
    assert.equal(s.sha256, createHash("sha256").update(dati).digest("hex"));
    assert.deepEqual(p.d360.richieste.map((r) => [r.host, r.percorso.split("?")[0]]), [["waba-v2.360dialog.io", "/MEDIA1"], ["waba-v2.360dialog.io", "/whatsapp_business/attachments/"]]);
    assert.ok(p.d360.richieste.every((r) => r.intestazioni["d360-api-key"] === CHIAVE_360 && r.redirect === "error"));
    assert.ok(!p.d360.richieste.some((r) => r.host.includes("fbsbx")), "la chiave di 360dialog non va a Meta");
    // url su un altro server: rifiutato, nessuna seconda richiesta
    p.d360.richieste.length = 0;
    p.d360.urlMedia = () => "https://cattivo.esempio.it/whatsapp_business/attachments/?mid=MEDIA1";
    await assert.rejects(scaricaMedia(c, "MEDIA1", { fetchFn: p.d360.fetch, risolvi: risolvi360 }), /fuori da Meta e da 360dialog/);
    assert.equal(p.d360.richieste.length, 1);
    // url già di 360dialog: va bene
    p.d360.urlMedia = (id) => `${BASE_360_FINTA}/whatsapp_business/attachments/?mid=${id}`;
    await scaricaMedia(c, "MEDIA1", { fetchFn: p.d360.fetch, risolvi: risolvi360 });
    // reindirizzamento sul file: rifiutato, non seguito
    p.d360.richieste.length = 0;
    p.d360.prossime.push({ corpo: { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA1`, mime_type: "application/pdf", file_size: 10 } });
    p.d360.prossime.push({ stato: 302, intestazioni: { Location: "https://cattivo.esempio.it/x" } });
    await assert.rejects(scaricaMedia(c, "MEDIA1", { fetchFn: p.d360.fetch, risolvi: risolvi360 }), /non ha dato il file \(302\)/);
    assert.ok(!p.d360.richieste.some((r) => r.host === "cattivo.esempio.it"));
    // troppo grande: rifiutato prima di scaricare
    p.d360.prossime.push({ corpo: { url: `https://lookaside.fbsbx.com/x?mid=MEDIA1`, mime_type: "application/pdf", file_size: 50 * 1024 * 1024 } });
    await assert.rejects(scaricaMedia(c, "MEDIA1", { fetchFn: p.d360.fetch, risolvi: risolvi360 }), /troppo grande/);
    // Meta diretto: un url fuori da Meta resta rifiutato
    const meta = await avviaMetaFinto();
    try {
      const cm = await salvaCollegamento(fonte(p.db), { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: TOKEN_META });
      const finto = (async (u: string | URL | Request, i?: RequestInit) => {
        if (String(u).includes("/MEDIA2")) return new Response(JSON.stringify({ url: "https://cattivo.esempio.it/f", mime_type: "image/jpeg" }), { status: 200 });
        return meta.fetch(u, i);
      }) as typeof fetch;
      await assert.rejects(scaricaMedia(cm, "MEDIA2", { fetchFn: finto }), /fuori da Meta/);
    } finally { await meta.chiudi(); }
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ prova del collegamento e sincronizzazione

test("Prova collegamento: Meta (is_on_biz_app / CLOUD_API) e 360dialog (percorso configurabile); mai un errore che blocca", async () => {
  const p = await prova();
  try {
    assert.equal((await provaCollegamento(opz(p))).ok, true);
    assert.equal(p.d360.richieste[0].percorso, "/health_status");
    p.d360.prossime.push({ stato: 404 });
    const non = await provaCollegamento(opz(p));
    assert.equal(non.ok, false);
    assert.match(non.messaggio, /non offre questa prova/);
    await salvaCollegamento(fonte(p.db), { percorsoSalute: "/v1/health" });
    await provaCollegamento(opz(p));
    assert.equal(p.d360.richieste.at(-1)!.percorso, "/v1/health");
    const rotto = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }) as unknown as typeof fetch;
    const giu = await provaCollegamento({ ...opz(p), fetchFn: rotto });
    assert.equal(giu.ok, false);
    assert.match(giu.messaggio, /non risponde/);
    // Meta diretto
    const meta = await avviaMetaFinto();
    try {
      await salvaCollegamento(fonte(p.db), { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: TOKEN_META });
      const risposte = [{ is_on_biz_app: true, platform_type: "CLOUD_API", id: PHONE_NUMBER_ID }, { is_on_biz_app: false, platform_type: "CLOUD_API" }];
      const f = (async (u: string | URL | Request, i?: RequestInit) => { await meta.fetch(u, i); return new Response(JSON.stringify(risposte.shift()), { status: 200 }); }) as typeof fetch;
      const ok = await provaCollegamento({ ...opz(p), fetchFn: f });
      assert.equal(ok.ok, true);
      assert.match(ok.messaggio, /coesistenza attiva/);
      assert.equal(meta.richieste[0].percorso, `/v27.0/${PHONE_NUMBER_ID}?fields=is_on_biz_app,platform_type`);
      assert.equal(meta.richieste[0].intestazioni.authorization, `Bearer ${TOKEN_META}`);
      const no = await provaCollegamento({ ...opz(p), fetchFn: f });
      assert.equal(no.ok, false);
      assert.match(no.messaggio, /non usa l'app WhatsApp Business/);
    } finally { await meta.chiudi(); }
  } finally { await p.chiudi(); }
});

test("Sincronizza chat: contatti e poi storico, UNA volta sola; un passo fallito si riprova da solo; Meta con /{id}/smb_app_data", async () => {
  const p = await prova();
  try {
    segnaCollegato(p.db, "360dialog", p.t.ora);
    // Contatti ok, storico rifiutato
    p.d360.prossime.push({ corpo: { success: true } }, { stato: 400, corpo: { error: { message: "already synced" } } });
    const primo = await sincronizzaChat(opz(p));
    assert.equal(primo.ok, false);
    assert.deepEqual(p.d360.richieste.map((r) => [r.percorso, r.corpo.sync_type]), [["/smb_app_data", "smb_app_state_sync"], ["/smb_app_data", "history"]]);
    assert.ok(p.d360.richieste.every((r) => r.corpo.messaging_product === "whatsapp" && r.intestazioni["d360-api-key"] === CHIAVE_360));
    assert.equal(leggiSync(p.db).contatti.stato, "fatto");
    assert.equal(leggiSync(p.db).storico.stato, "errore");
    // Si riprova: solo lo storico
    const secondo = await sincronizzaChat(opz(p));
    assert.equal(secondo.ok, true);
    assert.equal(p.d360.richieste.length, 3);
    assert.equal(p.d360.richieste[2].corpo.sync_type, "history");
    // Dopo il successo: rifiutata, nessuna chiamata
    await assert.rejects(sincronizzaChat(opz(p)), /una volta sola/);
    assert.equal(p.d360.richieste.length, 3);
    // Due clic insieme: una sola sincronizzazione
    segnaCollegato(p.db, "meta", p.t.ora); // nuovo fornitore: da capo
    const meta = await avviaMetaFinto();
    try {
      await salvaCollegamento(fonte(p.db), { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: TOKEN_META });
      const [a, b] = await Promise.allSettled([sincronizzaChat({ ...opz(p), fetchFn: meta.fetch }), sincronizzaChat({ ...opz(p), fetchFn: meta.fetch })]);
      assert.equal([a, b].filter((x) => x.status === "rejected").length, 1, "il secondo clic è rifiutato");
      assert.deepEqual(meta.richieste.map((r) => [r.percorso, r.corpo.sync_type]), [[`/v27.0/${PHONE_NUMBER_ID}/smb_app_data`, "smb_app_state_sync"], [`/v27.0/${PHONE_NUMBER_ID}/smb_app_data`, "history"]]);
      assert.equal(meta.richieste[0].intestazioni.authorization, `Bearer ${TOKEN_META}`);
    } finally { await meta.chiudi(); }
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ stato del collegamento

test("account_update: PARTNER_REMOVED / ACCOUNT_OFFBOARDED → interrotto + notifica; ACCOUNT_RECONNECTED → di nuovo attivo; nel briefing", async () => {
  const p = await prova();
  try {
    segnaCollegato(p.db, "360dialog", p.t.ora);
    const s = creaServizioWhatsapp(p.dip);
    const evento = (e: string) => webhook("account_update", { phone_number: "393400000001", event: e });
    await s.ricevi(evento("PARTNER_REMOVED"));
    assert.equal(leggiConnessione(p.db)!.stato, "interrotto");
    assert.equal(leggiConnessione(p.db)!.evento, "PARTNER_REMOVED");
    assert.equal(p.notifiche.inviate.length, 1);
    assert.equal(p.notifiche.inviate[0].testo, TESTO_INTERROTTO);
    assert.ok(!JSON.stringify(p.notifiche.inviate).includes("393400000001"), "mai il numero nella notifica");
    const b = await creaBriefing({ db: p.db, fuso: "Europe/Rome", linkCalendario: "", ora: p.t.ora });
    assert.ok(b.righe.some((r) => r.testo === TESTO_INTERROTTO));
    await s.ricevi(evento("ACCOUNT_OFFBOARDED"));
    assert.equal(p.notifiche.inviate.length, 1, "già interrotto: niente seconda notifica");
    await s.ricevi(evento("ACCOUNT_RECONNECTED"));
    assert.equal(leggiConnessione(p.db)!.stato, "attivo");
    assert.equal(p.notifiche.inviate.length, 2);
    assert.match(p.notifiche.inviate[1].testo, /di nuovo collegato/);
    await s.ricevi(evento("ACCOUNT_UPDATE_ALTRO"));
    assert.equal(leggiConnessione(p.db)!.stato, "attivo");
    // Interrotto, poi arrivano messaggi dal vivo: il collegamento lavora di nuovo.
    await s.ricevi(evento("ACCOUNT_OFFBOARDED"));
    await s.ricevi(ricevuto({ da: MARIO, testo: "Ci sei?" }));
    assert.equal(leggiConnessione(p.db)!.stato, "attivo");
    s.ferma();
  } finally { await p.chiudi(); }
});

test("regola dei 14 giorni: promemoria nel briefing se non arriva niente da 12 giorni (né messaggi né eco)", async () => {
  const p = await prova();
  try {
    const t0 = p.t.ora;
    const briefing = async (ora: number) => (await creaBriefing({ db: p.db, fuso: "Europe/Rome", linkCalendario: "", ora })).righe.map((r) => r.testo).join(" ");
    assert.doesNotMatch(await briefing(t0 + 20 * GIORNO), /WhatsApp Business/, "non collegato: nessun promemoria");
    segnaCollegato(p.db, "360dialog", t0);
    elaboraWebhook(p.db, ricevuto({ da: MARIO, quando: t0 }), "", t0);
    assert.doesNotMatch(await briefing(t0 + 11 * GIORNO), /14 giorni/);
    assert.match(await briefing(t0 + 12 * GIORNO + 1000), /niente di nuovo da 12 giorni.*almeno ogni 14 giorni/);
    // Luigi scrive dal telefono (eco): il conto riparte
    elaboraWebhook(p.db, eco({ a: MARIO, quando: t0 + 12 * GIORNO }), "", t0 + 12 * GIORNO);
    assert.doesNotMatch(await briefing(t0 + 13 * GIORNO), /14 giorni/);
    // Lo storico non conta come attività
    assert.match(await briefing(t0 + 25 * GIORNO), /da 13 giorni/);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ errori, velocità, contatore e tetto

test("errore 131060 (primo messaggio a un contatto nuovo / dispositivo non supportato): spiegazione gentile, nessun nuovo tentativo", async () => {
  const p = await prova();
  try {
    assert.match(spiegaErroreMeta(131060), /primo messaggio a un contatto nuovo.*Non riprovo.*telefono/);
    const c = leggiCollegamento(p.dip)!;
    p.d360.prossime.push({ stato: 400, corpo: { error: { code: 131060, message: "not delivered" } } });
    await assert.rejects(mandaTesto(c, { waId: MARIO, userId: "" }, "Ciao", { fetchFn: p.d360.fetch, risolvi: risolvi360, attesa: async () => {} }), /contatto nuovo/);
    assert.equal(p.d360.richieste.length, 1, "nessun nuovo tentativo");
    // Stato «failed» con 131060 dal webhook: la risposta resta in errore con la spiegazione, nessun nuovo invio.
    elaboraWebhook(p.db, ricevuto({ da: MARIO, testo: "Salve" }), "", p.t.ora);
    const r = preparaRisposta(p.dip, contatto(p.db, MARIO).id, "Buongiorno, ci sentiamo domani.");
    const e = await inviaRisposta(p.dip, r.id, improntaRisposta(r));
    assert.equal(e.inviata, true);
    const wamid = (p.db.prepare("SELECT wamid FROM wa_risposte WHERE id = ?").get(r.id) as { wamid: string }).wamid;
    elaboraWebhook(p.db, webhook("messages", { statuses: [{ id: wamid, status: "failed", errors: [{ code: 131060, title: "x" }] }] }), "", p.t.ora);
    const dopo = p.db.prepare("SELECT stato, esito FROM wa_risposte WHERE id = ?").get(r.id) as { stato: string; esito: string };
    assert.equal(dopo.stato, "errore");
    assert.match(dopo.esito, /contatto nuovo/);
    assert.equal(p.d360.richieste.filter((x) => x.percorso === "/messages").length, 2, "nessun invio in più");
  } finally { await p.chiudi(); }
});

test("limite di velocità: al massimo 20 messaggi al secondo, gli altri aspettano il loro turno", async () => {
  let t = 0;
  const attese: number[] = [];
  const l = creaLimitatore(20, 1000, () => t, async (ms) => { attese.push(ms); t += ms; });
  const partenze: number[] = [];
  await Promise.all(Array.from({ length: 45 }, () => l.attendiTurno().then(() => partenze.push(t))));
  assert.equal(partenze.filter((x) => x === 0).length, 20);
  assert.equal(partenze.filter((x) => x === 1000).length, 20);
  assert.equal(partenze.filter((x) => x === 2000).length, 5);
  for (let i = 0; i + 20 < partenze.length; i++) assert.ok(partenze[i + 20] - partenze[i] >= 1000, "mai più di 20 in un secondo");
  // L'invio passa sempre dal limitatore (anche nei tentativi)
  const p = await prova();
  try {
    let turni = 0;
    await mandaTesto(leggiCollegamento(p.dip)!, { waId: MARIO, userId: "" }, "Ciao", { fetchFn: p.d360.fetch, risolvi: risolvi360, limitatore: { attendiTurno: async () => { turni++; } } });
    assert.equal(turni, 1);
  } finally { await p.chiudi(); }
});

test("contatore del mese e tetto: bloccano SOLO gli invii di Jarvis; esito incerto contato, rifiuto no; stima oltre i 1.000", async () => {
  const p = await prova();
  try {
    salvaImpostazioni(p.db, { whatsappTettoMessaggiMese: 2 });
    elaboraWebhook(p.db, ricevuto({ da: MARIO, testo: "Salve" }), "", p.t.ora);
    const id = contatto(p.db, MARIO).id;
    const manda = async (testo: string) => { const r = preparaRisposta(p.dip, id, testo); return inviaRisposta(p.dip, r.id, improntaRisposta(r)); };
    assert.equal((await manda("Uno")).inviata, true);
    // Un rifiuto sicuro (400) non conta
    p.d360.prossime.push({ stato: 400, corpo: { error: { code: 100 } } });
    assert.equal((await manda("Rifiutato")).inviata, false);
    assert.equal(riepilogoInviiWa(p.db, "Europe/Rome", p.t.ora).inviati, 1);
    assert.equal((await manda("Due")).inviata, true);
    const prima = p.d360.richieste.length;
    const terzo = await manda("Tre");
    assert.equal(terzo.inviata, false);
    assert.match(terzo.messaggio, /tetto di 2 messaggi.*dal telefono \(gratis\)/);
    assert.equal(p.d360.richieste.length, prima, "al tetto non parte nessuna richiesta");
    // Le «eco» (messaggi che Luigi scrive dal telefono) non si contano e non sono bloccate
    elaboraWebhook(p.db, eco({ a: MARIO, testo: "Rispondo io" }), "", p.t.ora);
    const r = riepilogoInviiWa(p.db, "Europe/Rome", p.t.ora);
    assert.equal(r.inviati, 2);
    assert.equal(r.perTipo.risposta, 2);
    assert.equal(r.raggiunto, true);
    // Esito incerto: resta contato
    salvaImpostazioni(p.db, { whatsappTettoMessaggiMese: 900 });
    p.d360.prossime.push({ stato: 500 });
    await assert.rejects(mandaTesto(leggiCollegamento(p.dip)!, { waId: MARIO, userId: "" }, "x", { fetchFn: p.d360.fetch, risolvi: risolvi360, contatore: { db: p.db, fuso: "Europe/Rome", tipo: "risposta" } }), (e: Error) => e instanceof InvioIncerto);
    assert.equal(riepilogoInviiWa(p.db, "Europe/Rome").inviati, 3);
    // Tetto anche per le prenotazioni dirette (conferme e modelli usano lo stesso contatore)
    salvaImpostazioni(p.db, { whatsappTettoMessaggiMese: 3 });
    assert.throws(() => prenotaInvio({ db: p.db, fuso: "Europe/Rome", tipo: "conferma" }), (e: Error) => e instanceof TettoMessaggi);
    // Stima: 1.100 messaggi → 100 oltre i 1.000 gratuiti × 0,0248 € = 2,48 €
    p.db.prepare("INSERT INTO wa_invii_api (mese, tipo, n) VALUES (?, 'modello', 1097) ON CONFLICT(mese, tipo) DO UPDATE SET n = 1097").run(meseDi(Date.now(), "Europe/Rome"));
    const s = riepilogoInviiWa(p.db, "Europe/Rome");
    assert.equal(s.inviati, 1100);
    assert.equal(s.stimaEur, 2.48);
    salvaImpostazioni(p.db, { whatsappPrezzoMessaggioEur: 0.05 });
    assert.equal(riepilogoInviiWa(p.db, "Europe/Rome").stimaEur, 5);
  } finally { await p.chiudi(); }
});

test("tetto: le conferme automatiche si fermano al tetto; /api/spesa mostra i messaggi di Jarvis e la stima", async () => {
  const { a, d360 } = await ambiente();
  try {
    await a.accedi();
    const v = await (await a.chiama("/api/spesa")).json();
    assert.deepEqual({ inviati: v.whatsapp.inviati, tetto: v.whatsapp.tetto, soglia: v.whatsapp.sogliaGratuita, prezzo: v.whatsapp.prezzoEur, stima: v.whatsapp.stimaEur }, { inviati: 0, tetto: 900, soglia: 1000, prezzo: 0.0248, stima: 0 });
    const imp = await a.chiama("/api/impostazioni", { method: "PUT", json: { whatsappTettoMessaggiMese: 0 } });
    assert.equal(imp.status, 200);
    assert.equal((await (await a.chiama("/api/spesa")).json()).whatsapp.raggiunto, true);
    assert.equal((await a.chiama("/api/impostazioni", { method: "PUT", json: { whatsappTettoMessaggiMese: -1 } })).status, 400);
    const { valutaConfermaWa } = await import("../src/whatsapp/rispostaAuto.js");
    await collega360(a.db);
    scriviCollegamento({ db: a.db, cifratore }, { ...leggiCollegamento({ db: a.db, cifratore })!, webhookSecret: "x".repeat(43) });
    salvaImpostazioni(a.db, { whatsappConfermeAutomatiche: true });
    elaboraWebhook(a.db, ricevuto({ da: MARIO, testo: "Buongiorno" }), "", Date.now());
    const c = contatto(a.db, MARIO);
    const lista = a.db.prepare("SELECT * FROM wa_messaggi").all() as never[];
    assert.match(valutaConfermaWa({ db: a.db, cifratore, fuso: "Europe/Rome" }, c, lista).motivo, /tetto mensile/);
  } finally { await a.chiudi(); await d360.chiudi(); }
});

test("vecchio collegamento della parte 1 («bsp») letto come 360dialog", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const { salvaSegreto } = await import("../src/impostazioni.js");
    salvaSegreto(db, cifratore, "whatsapp", JSON.stringify({ provider: "bsp", baseUrl: "https://waba-v2.360dialog.io", versione: "v27.0", phoneNumberId: "", token: "k", intestazione: "D360-API-KEY", appSecret: "", verifyToken: "" }));
    const c = leggiCollegamento({ db, cifratore })!;
    assert.equal(c.provider, "360dialog");
    assert.equal(c.webhookSecret, "");
    assert.equal(webhookAttivo(c), false, "senza segreto dell'intestazione il webhook resta spento");
  } finally { chiudi(); }
});
