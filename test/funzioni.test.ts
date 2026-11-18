// Fase 3b — le 20 funzioni WhatsApp. Tutto con server finti: Costructo (con la pagina Proposte, anche assente: 404/405/403,
// e i doppioni 409), Meta (anche gli allegati), trascrizione finta, cervello finto. Nessuna rete vera, nessun numero vero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio, cifratore, avviaAmbiente, type Ambiente } from "./aiuto.js";
import { avviaMetaFinto, webhook, ricevuto, eco, PHONE_NUMBER_ID, type MetaFinto } from "./metaFinto.js";
import { avviaCostructoFinto, propostePagina, verificaOre, TOKEN, TOKEN_2, type Finto } from "./costructoFinto.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import type { RichiestaPasso } from "../src/cervello/tipi.js";
import type { Db } from "../src/db.js";
import { salvaSegreto, salvaImpostazioni, leggiImpostazioni } from "../src/impostazioni.js";
import { aziendeCollegate } from "../src/aziende.js";
import { salvaCollegamento } from "../src/whatsapp/collegamento.js";
import { elaboraWebhook } from "../src/whatsapp/elabora.js";
import { creaServizioWhatsapp } from "../src/whatsapp/servizio.js";
import { proponiTesto } from "../src/whatsapp/risposte.js";
import { PROMPT_CLASSIFICA_WA } from "../src/whatsapp/classifica.js";
import { pulisciWhatsappVecchio } from "../src/whatsapp/archivio.js";
import type { ContattoWa, DipendenzeWhatsapp, MessaggioWa } from "../src/whatsapp/tipi.js";
import { PROMPT_ESTRAZIONE } from "../src/funzioni/estrai.js";
import { dimenticaLetture } from "../src/funzioni/costructoLetture.js";
import { leggiOre, leggiAppuntamento, leggiPromessa, leggiRighe, leggiDocumento, leggiDatiFornitore, parlaDiPrezzi } from "../src/funzioni/rilevatori.js";
import { leggiData, giornoDa, distanzaMetri } from "../src/funzioni/date.js";
import { rispondiOperaio, domandeOperaioAperte } from "../src/funzioni/operai.js";
import { briefingFunzioni, linkWaMe } from "../src/funzioni/briefingFunzioni.js";
import { cercaOvunque } from "../src/funzioni/cerca.js";
import { rubrica, proponiContatto } from "../src/funzioni/rubrica.js";
import { preparaDiario } from "../src/funzioni/diario.js";
import { creaProposta, leggiProposta, improntaProposta, correggiProposta, proposteVisibili, pulisciFunzioniVecchie, vistaProposta, validaDati } from "../src/proposte/archivio.js";
import { mandaProposta, mandaProposte, aggiornaStatiProposte, nomeAziendaDi } from "../src/proposte/invio.js";
import type { RigaProposta } from "../src/proposte/tipi.js";
import { salvaChiave } from "../src/trascrizione/trascrizione.js";
import { eseguiStrumento, rispondiConferma, type ContestoStrumenti, type EventoFlusso } from "../src/strumenti.js";
import { CONSERVAZIONE_MS } from "../src/conversazioni.js";
import { dataIso } from "../src/tempo.js";

const SEGRETO_APP = "segretoappfinto0123456789abcdef";
const VERIFICA = "parola-di-verifica-finta-123";
const AZIENDE = [
  { id: "a1", nome: "FR Costruire Green", token: TOKEN },
  { id: "a2", nome: "Edilgreen", token: TOKEN_2 },
];
// Numeri finti
const OPERAIO = "393335550001";
const CLIENTE = "393339990000";   // controparte di FR Costruire Green
const PRIVATA = "393336660001";
const NUOVO = "393337770002";
const FORNITORE = "393331112222"; // «Idraulica Bianchi» in Costructo (FR Costruire Green)
const MINUTO = 60_000;
/** Un «JPEG» finto con i primi byte giusti (Jarvis e Costructo controllano il formato). */
const jpeg = (t: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(t)]);
const FUSO = "Europe/Rome";

function cervelloFunzioni() {
  return creaCervelloFinto((r: RichiestaPasso) => {
    const u = r.messaggi.at(-1)!;
    if (u.ruolo !== "utente") return { testo: "ok" };
    if (r.sistema === PROMPT_CLASSIFICA_WA) return { testo: JSON.stringify({ riassunto: "Riassunto finto", urgente: false, motivo: "", tocca: false, azienda: "" }), uso: { ingresso: 300, uscita: 40, cacheLettura: 0, cacheScrittura: 0 } };
    if (r.sistema === PROMPT_ESTRAZIONE) {
      // Estrazione finta: nome e indirizzo «dal messaggio», e un campo non valido che zod deve scartare.
      return { testo: JSON.stringify({ nome: "Paola Verdi", indirizzo: "via Roma 3, Milano", descrizione: "Rifare il bagno", sopralluogoData: "domani", sopralluogoOra: "10:00" }), uso: { ingresso: 200, uscita: 50, cacheLettura: 0, cacheScrittura: 0 } };
    }
    if (/BOZZA di una risposta WhatsApp/.test(r.sistema)) return { testo: "Buongiorno, il lavoro costa 5.000 € più IVA, prezzo 4800 a corpo." };
    return { testo: "ok" };
  });
}

function trascrizioneFinta(testo = "Domani alle 9 porto il cemento in cantiere Villa Rosa") {
  const richieste: Array<{ url: string; intestazioni: Headers; corpo: string }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    richieste.push({ url, intestazioni: new Headers(init?.headers), corpo: typeof init?.body === "string" ? init.body : "(modulo)" });
    if (url.startsWith("https://speech.googleapis.com/")) return new Response(JSON.stringify({ results: [{ alternatives: [{ transcript: testo }] }], totalBilledTime: "15s" }), { status: 200 });
    if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ text: testo }), { status: 200 });
    throw new Error("rete non ammessa nei test");
  }) as typeof fetch;
  return { richieste, f };
}

interface Prova { db: Db; meta: MetaFinto; costructo: Finto; pagina: ReturnType<typeof propostePagina>; dip: DipendenzeWhatsapp; t: { ora: number }; chiudi: () => Promise<void> }

const iso = (ms: number) => new Date(ms).toISOString();

async function prova(opz: { paginaProposte?: boolean; doppione?: (c: Record<string, unknown>) => string | null } = {}): Promise<Prova> {
  const { db, chiudi } = dbProvvisorio();
  const meta = await avviaMetaFinto();
  const costructo = await avviaCostructoFinto();
  const ora = Date.now();
  const domani10 = new Date(`${giornoDa(ora, 1, FUSO)}T10:00:00+01:00`).getTime();
  const pagina = propostePagina(opz.doppione);
  Object.assign(costructo.risposte, {
    "/cantieri": { corpo: { cantieri: [{ id: "C1", nome: "Villa Rosa", lat: 45.0, lon: 9.0, cliente: "Cliente Prova" }, { id: "C2", nome: "Scuola Verdi", lat: 45.2, lon: 9.2 }] } },
    "/operai": { corpo: { operai: [{ id: "O1", nome: "Mario Rossi", attivo: true }, { id: "O2", nome: "Gino Neri", attivo: true }] } },
    "/controparti": (r: { parametri: URLSearchParams }) => r.parametri.get("telefono")
      ? { corpo: { controparti: [] } }
      : { corpo: { controparti: [{ id: "K1", nome: "Idraulica Bianchi", telefono: "333 111 2222" }, { id: "K2", nome: "Bianchi Srl" }, { id: "K3", nome: "Cliente Prova", telefono: "+39 333 999 0000" }, { id: "K4", nome: "Nuovo Fornitore" }] } },
    "/documenti": { corpo: { documenti: [{ id: "D1", tipoDocumento: "DURC", ditta: "FR Costruire Green", scadenza: "2026-12-01" }, { id: "D2", tipoDocumento: "DURC", ditta: "Idraulica Bianchi" }, { id: "D7", tipoDocumento: "DURC", ditta: "Idraulica Bianchi", di_chi: "azienda" }] } },
    "/briefing": { corpo: { fatture: [{ numero: "12", cliente: "Cliente Prova", residuo: 1234.5, scadenza: "2026-11-01" }, { numero: "13", cliente: "Cliente Prova", residuo: 99, scadenza: "2099-01-01" }] } },
    "/preventivi": { corpo: { preventivi: [{ numero: "P7", cliente: "Cliente Prova", stato: "inviato", dataInvio: dataIso(ora - 10 * 864e5, FUSO) }, { numero: "P8", cliente: "Cliente Prova", stato: "inviato", dataInvio: dataIso(ora - 2 * 864e5, FUSO) }, { numero: "P9", stato: "accettato", dataInvio: "2026-01-01" }] } },
    "/agenda": { corpo: { impegni: [{ titolo: "Sopralluogo", inizio: iso(domani10), cliente: "Cliente Prova", telefono: "+39 333 999 0000", luogo: "Villa Rosa" }] } },
    "/ore": verificaOre(false),
    "/inventario": { corpo: { inventario: [{ id: "I1", descrizione: "sacchi di cemento" }] } },
    "/cerca": { corpo: { risultati: [{ titolo: "Preventivo bagno Rossi", tipo: "preventivo" }] } },
  });
  if (opz.paginaProposte !== false) { costructo.risposte["/proposte"] = pagina.gestisci; costructo.risposte["/proposte/:id"] = pagina.gestisci; }
  salvaSegreto(db, cifratore, "costructo_url", costructo.url);
  salvaSegreto(db, cifratore, "costructo_aziende", JSON.stringify(AZIENDE));
  await salvaCollegamento({ db, cifratore }, { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: "EAAtokenfintosolopertest1234567890", appSecret: SEGRETO_APP, verifyToken: VERIFICA });
  const cervello = cervelloFunzioni();
  const t = { ora };
  const fonte = { db, cifratore, urlAmbiente: "", tokenAmbiente: "" };
  const dip: DipendenzeWhatsapp = {
    db, cifratore, fuso: FUSO, cervello: async () => cervello, modello: "claude-haiku-5-5",
    aziende: () => AZIENDE.map(({ id, nome }) => ({ id, nome })), aziendeCostructo: () => aziendeCollegate(fonte),
    invia: null, fetchFn: meta.fetch, ora: () => t.ora, attesaRiprova: async () => {},
  };
  dimenticaLetture(db);
  return { db, meta, costructo, pagina, dip, t, chiudi: async () => { await meta.chiudi(); await costructo.chiudi(); chiudi(); } };
}

const arriva = (p: Prova, corpo: ReturnType<typeof webhook>) => elaboraWebhook(p.db, corpo, PHONE_NUMBER_ID, p.t.ora);
const assegna = (db: Db, waId: string, spazio: string) => db.prepare("UPDATE wa_contatti SET spazio = ?, fonte_spazio = 'luigi' WHERE wa_id = ?").run(spazio, waId);
const contatto = (db: Db, waId: string) => db.prepare("SELECT * FROM wa_contatti WHERE wa_id = ?").get(waId) as ContattoWa;
const proposte = (db: Db) => db.prepare("SELECT * FROM proposte ORDER BY creata, rowid").all() as RigaProposta[];
const datiP = (p: RigaProposta) => JSON.parse(p.dati) as Record<string, unknown>;
const postCostructo = (f: Finto) => f.richieste.filter((r) => r.metodo === "POST");
const postMeta = (m: MetaFinto) => m.richieste.filter((r) => r.metodo === "POST");
async function giro(p: Prova, dopo = 3 * MINUTO) { p.t.ora += dopo; return creaServizioWhatsapp(p.dip).giroOra(); }
const nomeAz = (p: Prova) => nomeAziendaDi(p.dip);
/** L'operaio: Luigi ha già detto chi è. */
function operaio(p: Prova) {
  arriva(p, ricevuto({ da: OPERAIO, nome: "Mario R.", testo: "Buongiorno" }));
  assegna(p.db, OPERAIO, "a1");
  rispondiOperaio(p.db, contatto(p.db, OPERAIO).id, "a1", { id: "O1", nome: "Mario Rossi" });
}

// ------------------------------------------------------------------ riconoscimento senza AI
test("rilevatori: ore, appuntamenti, promesse, righe, documenti, date, prezzi (senza AI)", () => {
  const ora = Date.UTC(2026, 10, 18, 9); // mercoledì 18/11/2026
  assert.deepEqual(leggiOre("8 ore cantiere Villa Rosa", ora, FUSO), [{ ore: 8, cantiere: "Villa Rosa", testo: "8 ore cantiere Villa Rosa" }]);
  assert.equal(leggiOre("oggi 7,5 h da Bianchi, 2 in economia", ora, FUSO)[0].oreEconomia, 2);
  assert.equal(leggiOre("ieri 8 ore cantiere Scuola Verdi", ora, FUSO)[0].data, "2026-11-17");
  assert.deepEqual(leggiOre("ci vediamo alle ore 15", ora, FUSO), [], "un orario non sono ore lavorate");
  assert.equal(leggiAppuntamento("Ci vediamo domani alle 10 in cantiere", ora, FUSO)?.ora, "10:00");
  assert.equal(leggiAppuntamento("Ci vediamo domani alle 10 in cantiere", ora, FUSO)?.data, "2026-11-19");
  assert.equal(leggiAppuntamento("quando ci vediamo per il sopralluogo?", ora, FUSO), null, "una domanda senza giorno non è un appuntamento");
  assert.deepEqual(leggiPromessa("Ok, ti mando il preventivo domani", ora, FUSO), { testo: "ti mando il preventivo domani", cosa: "preventivo", data: "2026-11-19" });
  assert.equal(leggiPromessa("Buongiorno. Ti mando la fattura entro il 30/11, grazie", ora, FUSO)?.testo, "Ti mando la fattura entro il 30/11, grazie", "la promessa intera");
  assert.equal(leggiPromessa("ti mando il preventivo", ora, FUSO), null, "senza un quando non è una promessa con scadenza");
  assert.deepEqual(leggiRighe("Consegnati 20 sacchi di cemento, 3 bancali di mattoni e 50 m di tubo"), [
    { quantita: 20, unita: "sacchi", descrizione: "cemento" }, { quantita: 3, unita: "bancali", descrizione: "mattoni" }, { quantita: 50, unita: "m", descrizione: "tubo" },
  ]);
  assert.equal(leggiDocumento("DURC_Bianchi.pdf", "")?.categoria, "rinnovo");
  assert.equal(leggiDocumento("Fattura_123.pdf", "")?.tipo, "fattura");
  assert.equal(leggiDocumento("doc.pdf", "ddt consegna")?.categoria, "ddt");
  assert.equal(leggiDocumento("", "scontrino gasolio")?.categoria, "scontrino");
  assert.deepEqual(leggiDatiFornitore("fattura n. 45 del 12/11/2026 totale 1.220,50 €", ora, FUSO), { numero: "45", data: "2026-11-12", importo: 1220.5 });
  assert.equal(leggiData("il 3 maggio", ora, FUSO), "2027-05-03", "data passata senza anno: l'anno dopo");
  assert.equal(leggiData("8.5 ore", ora, FUSO), null, "«8.5» non è l'8 maggio");
  assert.ok(Math.abs(distanzaMetri({ lat: 45, lon: 9 }, { lat: 45.009, lon: 9 }) - 1000) < 5);
  assert.ok(parlaDiPrezzi("costa 5.000 €") && !parlaDiPrezzi("arrivo alle 9"));
});

// ------------------------------------------------------------------ 19 · ore degli operai
test("19 ore: contatto non ancora noto → «Chi è questo contatto: operaio X?»; dopo la risposta, proposta «ore» da confermare (niente scritto in Costructo)", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: OPERAIO, nome: "Mario Rossi", testo: "Oggi 8 ore cantiere Villa Rosa, 2 in economia" }));
    assegna(p.db, OPERAIO, "a1");
    await giro(p);
    assert.equal(proposte(p.db).length, 0, "prima Jarvis chiede chi è");
    const domande = await domandeOperaioAperte(p.db, p.dip.aziende(), p.dip.aziendeCostructo());
    assert.equal(domande.length, 1);
    assert.match(domande[0].domanda, /Chi è questo contatto: Mario Rossi \(FR Costruire Green\) è l'operaio Mario Rossi\?/);
    assert.equal(domande[0].suggerito, "O1");
    assert.equal(domande[0].operai.length, 2);
    rispondiOperaio(p.db, contatto(p.db, OPERAIO).id, "a1", { id: "O1", nome: "Mario Rossi" });
    await giro(p);
    const [ore] = proposte(p.db);
    assert.equal(ore.tipo, "ore");
    assert.deepEqual(datiP(ore), { operaioId: "O1", cantiereId: "C1", data: dataIso(p.t.ora, FUSO), ore: 8, oreEconomia: 2, descrizione: "Ore mandate su WhatsApp" });
    assert.equal(ore.stato, "da_confermare");
    assert.equal(ore.chiave_doppione, `wa:${(p.db.prepare("SELECT wamid FROM wa_messaggi WHERE testo LIKE '%8 ore%'").get() as { wamid: string }).wamid}:ore`);
    assert.equal(postCostructo(p.costructo).length, 0, "nessuna scrittura in Costructo senza la conferma di Luigi");
    assert.ok(p.costructo.richieste.some((r) => r.percorso.startsWith("/api/assistente/v1/ore?operaioId=O1")), "prima controlla /v1/ore");
    // conferma con l'impronta del testo completo → Costructo riceve la proposta
    const e = await mandaProposta(p.dip, ore.id, improntaProposta(ore, nomeAz(p)));
    assert.ok(e.ok, e.messaggio);
    assert.equal(p.pagina.ricevute.length, 1);
    assert.deepEqual({ tipo: p.pagina.ricevute[0].tipo, origine: p.pagina.ricevute[0].origine, chiave: p.pagina.ricevute[0].chiaveDoppione }, { tipo: "ore", origine: "whatsapp", chiave: ore.chiave_doppione });
    assert.equal(leggiProposta(p.db, ore.id)!.stato, "inviata");
    // nessuna geolocalizzazione dei lavoratori: la posizione dell'operaio non si salva e non si usa
    arriva(p, ricevuto({ da: OPERAIO, tipo: "location", extra: { location: { latitude: 45.0001, longitude: 9.0001, name: "Cantiere" } } }));
    const pos = p.db.prepare("SELECT testo, media FROM wa_messaggi WHERE tipo = 'location'").get() as { testo: string; media: string };
    assert.doesNotMatch(pos.testo + pos.media, /45\.0001|9\.0001/);
    await giro(p);
    assert.equal(proposte(p.db).length, 1, "nessuna proposta dalla posizione di un operaio");
  } finally { await p.chiudi(); }
});

test("19 ore: rapportino già in Costructo → niente proposta; 409 di Costructo → «già presente in Costructo» e nient'altro", async () => {
  const p = await prova({ doppione: (c) => (c.tipo === "ore" ? "rapportino già presente per Mario Rossi" : null) });
  try {
    operaio(p);
    p.costructo.risposte["/ore"] = verificaOre(true);
    arriva(p, ricevuto({ da: OPERAIO, testo: "8 ore cantiere Villa Rosa" }));
    await giro(p);
    assert.equal(proposte(p.db).length, 0, "il rapportino c'è già: niente proposta");
    p.costructo.risposte["/ore"] = verificaOre(false);
    arriva(p, ricevuto({ da: OPERAIO, testo: "ieri 6 ore cantiere Scuola Verdi" }));
    await giro(p);
    const [o] = proposte(p.db);
    const e = await mandaProposta(p.dip, o.id, improntaProposta(o, nomeAz(p)));
    assert.equal(e.stato, "gia_presente");
    assert.match(e.messaggio, /già presente in Costructo/);
    assert.equal(postCostructo(p.costructo).length, 1, "un solo tentativo, nessun altro passo");
    assert.equal(leggiProposta(p.db, o.id)!.stato, "gia_presente");
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ proposte: sicurezza
test("proposte: impronta diversa rifiutata; idempotenza (stessa chiave, stesso webhook due volte); pagina Proposte assente (404/405/403) → resta in Jarvis", async () => {
  const p = await prova({ paginaProposte: false });
  try {
    operaio(p);
    const corpo = ricevuto({ da: OPERAIO, testo: "8 ore cantiere Villa Rosa", id: "wamid.ore.unico" });
    arriva(p, corpo);
    arriva(p, corpo);
    await giro(p);
    await giro(p);
    assert.equal(proposte(p.db).length, 1, "lo stesso messaggio non crea due proposte");
    const o = proposte(p.db)[0];
    assert.equal(creaProposta(p.db, { tipo: "ore", aziendaId: "a1", chiave: o.chiave_doppione, titolo: "x", dati: {} }).nuova, false);
    const vecchia = improntaProposta(o, nomeAz(p));
    correggiProposta(p.db, o.id, { ore: 9 });
    const rifiutata = await mandaProposta(p.dip, o.id, vecchia);
    assert.equal(rifiutata.ok, false);
    assert.match(rifiutata.messaggio, /cambiata dopo la conferma/);
    assert.equal(postCostructo(p.costructo).length, 0);
    for (const stato of [404, 405, 403]) {
      p.costructo.risposte["/proposte"] = { stato };
      const r = leggiProposta(p.db, o.id)!;
      const e = await mandaProposta(p.dip, o.id, improntaProposta(r, nomeAz(p)));
      assert.equal(e.stato, "attesa_costructo", `stato ${stato}`);
      assert.match(e.messaggio, /In attesa della pagina Proposte in Costructo/);
      assert.equal(leggiProposta(p.db, o.id)!.stato, "attesa_costructo");
    }
    // la pagina arriva: si rimanda, stessa chiave doppione (idempotente)
    p.costructo.risposte["/proposte"] = p.pagina.gestisci;
    p.costructo.risposte["/proposte/:id"] = p.pagina.gestisci;
    const r = leggiProposta(p.db, o.id)!;
    assert.ok((await mandaProposta(p.dip, o.id, improntaProposta(r, nomeAz(p)))).ok);
    assert.ok((await mandaProposta(p.dip, o.id, improntaProposta(r, nomeAz(p)))).ok, "già partita: nessun secondo invio");
    assert.equal(p.pagina.ricevute.length, 1);
    // stato da Costructo
    p.pagina.ricevute[0].stato = "accettata";
    assert.equal(await aggiornaStatiProposte(p.dip), 1);
    assert.equal(leggiProposta(p.db, o.id)!.stato_costructo, "accettata");
  } finally { await p.chiudi(); }
});

test("proposte: interruttore «proponi in automatico» spento di serie; acceso per un tipo manda solo quel tipo", async () => {
  const p = await prova();
  try {
    assert.deepEqual(leggiImpostazioni(p.db).proposteAutomatiche, []);
    operaio(p);
    arriva(p, ricevuto({ da: OPERAIO, testo: "8 ore cantiere Villa Rosa" }));
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Ci vediamo domani alle 10 in cantiere Villa Rosa" }));
    await giro(p);
    assert.equal(proposte(p.db).length, 2);
    assert.equal(postCostructo(p.costructo).length, 0, "spento: niente parte da solo");
    salvaImpostazioni(p.db, { proposteAutomatiche: ["ore"] });
    await giro(p);
    assert.deepEqual(p.pagina.ricevute.map((x) => x.tipo), ["ore"], "solo il tipo acceso");
    assert.equal(proposte(p.db).find((x) => x.tipo === "ore")!.automatica, 1);
    assert.equal(proposte(p.db).find((x) => x.tipo === "agenda")!.stato, "da_confermare");
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 1 · vocali
test("1 vocali: trascrizione spenta di serie («vocale ricevuto, trascrizione spenta»); accesa → testo, audio mai salvato, costo nella spesa", async () => {
  const p = await prova();
  const tr = trascrizioneFinta();
  p.dip.fetchTrascrizione = tr.f;
  try {
    assegna(p.db, CLIENTE, "a1");
    p.meta.media["aud1"] = { mime: "audio/ogg", dati: Buffer.from("OggS-vocale-finto-".repeat(50)) };
    arriva(p, ricevuto({ da: CLIENTE, tipo: "audio", extra: { audio: { id: "aud1", mime_type: "audio/ogg; codecs=opus", voice: true } } }));
    await giro(p);
    const spento = p.db.prepare("SELECT testo FROM wa_messaggi WHERE tipo = 'audio'").get() as { testo: string };
    assert.match(spento.testo, /Vocale ricevuto, trascrizione spenta/);
    assert.equal(p.meta.richieste.length, 0, "spenta: nessuno scaricamento");
    assert.equal(tr.richieste.length, 0);
    // accesa (scaricamento + Google con la chiave): il vocale diventa testo
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true, trascrizioneFornitore: "google" });
    salvaChiave(p.db, cifratore, "google", "AIzaFINTAchiave0123456789abcdef");
    p.meta.media["aud2"] = { mime: "audio/ogg", dati: Buffer.from("OggS-secondo-vocale-".repeat(50)) };
    arriva(p, ricevuto({ da: CLIENTE, tipo: "audio", extra: { audio: { id: "aud2", mime_type: "audio/ogg; codecs=opus", voice: true } } }));
    await giro(p);
    const fatto = p.db.prepare("SELECT m.testo, s.stato FROM wa_messaggi m JOIN wa_media_stato s ON s.messaggio_id = m.id WHERE m.media LIKE '%aud2%'").get() as { testo: string; stato: string };
    assert.equal(fatto.stato, "trascritto");
    assert.match(fatto.testo, /^Vocale: Domani alle 9 porto il cemento in cantiere Villa Rosa/);
    assert.equal(tr.richieste.length, 1);
    assert.equal(tr.richieste[0].intestazioni.get("x-goog-api-key"), "AIzaFINTAchiave0123456789abcdef");
    assert.match(tr.richieste[0].corpo, /"languageCode":"it-IT"/);
    assert.ok(p.meta.richieste.every((r) => r.metodo === "GET"), "scaricato con GET, nessun messaggio mandato");
    // l'audio non resta da nessuna parte: niente allegati salvati, niente byte del vocale nel database
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM wa_allegati").get() as { n: number }).n, 0);
    const tutto = JSON.stringify(p.db.prepare("SELECT * FROM wa_messaggi").all()) + JSON.stringify(p.db.prepare("SELECT * FROM wa_media_stato").all());
    assert.ok(!tutto.includes("OggS-secondo-vocale"), "l'audio non è salvato");
    const costo = p.db.prepare("SELECT costo_usd FROM consumi WHERE modello = 'trascrizione-google'").get() as { costo_usd: number };
    assert.ok(costo.costo_usd > 0, "la trascrizione conta nella spesa del mese");
    // tetto di spesa: niente trascrizione
    salvaImpostazioni(p.db, { tettoMensileUsd: 0 });
    p.meta.media["aud3"] = { mime: "audio/ogg", dati: Buffer.from("OggS-terzo") };
    arriva(p, ricevuto({ da: CLIENTE, tipo: "audio", extra: { audio: { id: "aud3", mime_type: "audio/ogg" } } }));
    await giro(p);
    assert.equal(tr.richieste.length, 1, "al tetto il vocale non va al fornitore");
    assert.match((p.db.prepare("SELECT testo FROM wa_messaggi WHERE media LIKE '%aud3%'").get() as { testo: string }).testo, /tetto di spesa/);
  } finally { await p.chiudi(); }
});

test("1 vocali: chiave della trascrizione cifrata, mai restituita né nel registro; OpenAI con multipart", async () => {
  const meta = await avviaMetaFinto();
  const tr = trascrizioneFinta("Ciao, richiamami");
  const a = await avviaAmbiente({ fetchWhatsapp: meta.fetch, fetchTrascrizione: tr.f });
  try {
    await a.accedi();
    const CHIAVE = "sk-proj-FINTA0123456789abcdefghij";
    const r = await (await a.chiama("/api/funzioni/impostazioni", { method: "PUT", json: { trascrizioneFornitore: "openai", chiaveOpenai: CHIAVE, scaricaAllegati: true } })).json();
    assert.deepEqual(r.trascrizione.chiaveImpostata, { google: false, openai: true });
    assert.equal(r.trascrizione.fornitore, "openai");
    assert.ok(r.trascrizione.listino.openai.alMinuto > 0, "costi mostrati in Impostazioni");
    const tutto = JSON.stringify(r) + JSON.stringify(await (await a.chiama("/api/funzioni/impostazioni")).json()) + JSON.stringify(a.db.prepare("SELECT * FROM registro").all()) + JSON.stringify(a.db.prepare("SELECT * FROM segreti").all());
    assert.ok(!tutto.includes(CHIAVE), "la chiave non esce mai e nel database è cifrata");
    assert.equal((await a.chiama("/api/funzioni/impostazioni", { method: "PUT", json: { chiaveGoogle: "corta" } })).status, 400);
    // un vocale con OpenAI
    await salvaCollegamento({ db: a.db, cifratore }, { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: "EAAtokenfintosolopertest1234567890", appSecret: SEGRETO_APP, verifyToken: VERIFICA });
    meta.media["v1"] = { mime: "audio/ogg", dati: Buffer.from("OggS-openai") };
    elaboraWebhook(a.db, ricevuto({ da: PRIVATA, tipo: "audio", extra: { audio: { id: "v1", mime_type: "audio/ogg" } } }), PHONE_NUMBER_ID);
    assegna(a.db, PRIVATA, "privato");
    await a.servizi.whatsapp.giroOra();
    assert.equal(tr.richieste[0]?.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(tr.richieste[0].intestazioni.get("authorization"), `Bearer ${CHIAVE}`);
    assert.match((a.db.prepare("SELECT testo FROM wa_messaggi WHERE tipo = 'audio'").get() as { testo: string }).testo, /Vocale: Ciao, richiamami/);
    // chat privata esclusa: niente trascrizione
    const id = contatto(a.db, PRIVATA).id;
    assert.equal((await a.chiama(`/api/funzioni/chat-escluse/${id}`, { method: "PUT", json: { escludi: true } })).status, 200);
    meta.media["v2"] = { mime: "audio/ogg", dati: Buffer.from("OggS-escluso") };
    elaboraWebhook(a.db, ricevuto({ da: PRIVATA, tipo: "audio", extra: { audio: { id: "v2", mime_type: "audio/ogg" } } }), PHONE_NUMBER_ID);
    await a.servizi.whatsapp.giroOra();
    assert.equal(tr.richieste.length, 1, "chat esclusa: non va al fornitore");
  } finally { await a.chiudi(); await meta.chiudi(); }
});

// ------------------------------------------------------------------ 2 · chi aspetta, promesse
test("2 chi aspetta una risposta e promesse non mantenute («ti mando il preventivo domani» → il giorno dopo nel briefing)", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Mi manda il preventivo per il bagno?" }));
    await giro(p);
    assert.equal(contatto(p.db, CLIENTE).spazio, "a1", "numero trovato in Costructo");
    let b = await briefingFunzioni({ db: p.db, fuso: FUSO, vista: "lavoro", aziende: p.dip.aziende(), collegate: p.dip.aziendeCostructo(), ora: p.t.ora });
    assert.deepEqual(b.aziende[0].aspettano.map((x) => x.contatto), ["Cliente Prova"]);
    arriva(p, eco({ a: CLIENTE, testo: "Certo, ti mando il preventivo domani", quando: p.t.ora }));
    await giro(p);
    const pr = p.db.prepare("SELECT * FROM promesse").all() as Array<{ cosa: string; stato: string }>;
    assert.deepEqual(pr.map((x) => [x.cosa, x.stato]), [["ti mando il preventivo domani", "aperta"]], "la promessa intera");
    // dopodomani: non mantenuta
    b = await briefingFunzioni({ db: p.db, fuso: FUSO, vista: "lavoro", aziende: p.dip.aziende(), collegate: p.dip.aziendeCostructo(), ora: p.t.ora + 2 * 864e5 });
    assert.equal(b.aziende[0].promesse[0].scaduta, true);
    assert.match(b.righe.join(" "), /FR Costruire Green: .*1 promessa non mantenuta/);
    // Luigi manda un documento: promessa mantenuta
    arriva(p, webhook("smb_message_echoes", { message_echoes: [{ from: "393400000001", to: CLIENTE, id: "wamid.eco.doc", timestamp: String(Math.floor(p.t.ora / 1000) + 300), type: "document", document: { id: "d9", filename: "Preventivo.pdf" } }] }));
    await giro(p);
    assert.equal((p.db.prepare("SELECT stato FROM promesse").get() as { stato: string }).stato, "mantenuta");
    // nella scheda Privato non ci sono le aziende
    const priv = await briefingFunzioni({ db: p.db, fuso: FUSO, vista: "privato", aziende: p.dip.aziende(), collegate: p.dip.aziendeCostructo(), ora: p.t.ora });
    assert.equal(priv.aziende.length, 0);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 3, 4, 8, 18 · briefing
test("3/4/8/18 briefing per azienda: riassunto per cantiere, solleciti con l'importo esatto e wa.me, preventivi in attesa, promemoria di domani (mai mandati da Jarvis)", async () => {
  const p = await prova();
  try {
    operaio(p);
    arriva(p, ricevuto({ da: OPERAIO, testo: "A Villa Rosa abbiamo finito il massetto" }));
    p.db.prepare(`INSERT INTO posta_messaggi (id, casella_id, uid, uid_validity, data, spazio, oggetto, estratto, salvato) VALUES ('m1','c',1,'1',?, 'a1', 'Villa Rosa: consegna', 'materiale', ?)`).run(p.t.ora, p.t.ora);
    await giro(p);
    const ora = p.t.ora;
    const b = await briefingFunzioni({ db: p.db, fuso: FUSO, vista: "tutto", aziende: p.dip.aziende(), collegate: p.dip.aziendeCostructo(), ora: new Date(`${dataIso(ora, FUSO)}T18:00:00+01:00`).getTime() });
    const fr = b.aziende.find((x) => x.id === "a1")!;
    const vr = fr.cantieri.find((c) => c.nome === "Villa Rosa")!;
    assert.ok(vr.messaggi >= 1 && vr.mail === 1, JSON.stringify(vr));
    // 4) sollecito: solo la fattura scaduta, importo esatto, link wa.me con il testo
    assert.equal(fr.solleciti.length, 1);
    assert.match(fr.solleciti[0].testo, /fattura n\. 12 con scadenza 01\/11\/2026 risulta ancora da saldare per 1\.234,50 €/);
    assert.equal(fr.solleciti[0].link, linkWaMe("393339990000", fr.solleciti[0].testo));
    assert.match(fr.solleciti[0].link!, /^https:\/\/wa\.me\/393339990000\?text=Buongiorno/);
    assert.equal(fr.solleciti[0].numero, "•••000", "nella pagina il numero è mascherato");
    // 8) solo il preventivo inviato da più di 7 giorni
    assert.deepEqual(fr.preventivi.map((x) => x.titolo.split(":")[0]), ["Preventivo n. P7 · Cliente Prova"]);
    assert.ok(fr.preventivi[0].link);
    assert.doesNotMatch(fr.preventivi[0].testo, /€|\d+,\d\d/, "nessun prezzo nei promemoria");
    // 18) appuntamento di domani con il testo per il cliente
    assert.equal(fr.appuntamentiDomani.length, 1);
    assert.match(fr.appuntamentiDomani[0].testo, /le ricordiamo l'appuntamento di domani .* alle 10:00 \(Villa Rosa\)/);
    assert.equal(b.modelliAttivi, false);
    // niente parte da Jarvis: nessun POST a Meta o a Costructo
    assert.equal(postMeta(p.meta).length, 0);
    assert.equal(postCostructo(p.costructo).length, 0);
    // la seconda azienda senza dati non rompe niente
    assert.ok(b.aziende.find((x) => x.id === "a2"));
  } finally { await p.chiudi(); }
});

test("18 modelli di Meta: spenti di serie (409); accesi servono conferma e impronta; mai in automatico", async () => {
  const meta = await avviaMetaFinto();
  const a = await avviaAmbiente({ fetchWhatsapp: meta.fetch });
  try {
    await a.accedi();
    await salvaCollegamento({ db: a.db, cifratore }, { provider: "meta", phoneNumberId: PHONE_NUMBER_ID, token: "EAAtokenfintosolopertest1234567890", appSecret: SEGRETO_APP, verifyToken: VERIFICA });
    const m = { telefono: "+39 333 999 0000", nome: "promemoria_appuntamento", lingua: "it", parametri: ["domani", "10:00"] };
    assert.equal((await a.chiama("/api/funzioni/modello/prepara", { method: "POST", json: m })).status, 409, "spenti di serie");
    await a.chiama("/api/funzioni/impostazioni", { method: "PUT", json: { modelliAttivi: true } });
    const pr = await (await a.chiama("/api/funzioni/modello/prepara", { method: "POST", json: m })).json();
    assert.match(pr.anteprima, /•••000/);
    assert.equal((await a.chiama("/api/funzioni/modello/invia", { method: "POST", json: { ...m, impronta: pr.impronta } })).status, 400, "senza conferma");
    assert.equal((await a.chiama("/api/funzioni/modello/invia", { method: "POST", json: { ...m, parametri: ["dopodomani", "10:00"], conferma: true, id: pr.id, impronta: pr.impronta } })).status, 409, "impronta diversa");
    assert.equal(meta.richieste.length, 0);
    assert.equal((await a.chiama("/api/funzioni/modello/invia", { method: "POST", json: { ...m, conferma: true, impronta: pr.impronta } })).status, 400, "senza l'id del promemoria preparato");
    const ok = await (await a.chiama("/api/funzioni/modello/invia", { method: "POST", json: { ...m, conferma: true, id: pr.id, impronta: pr.impronta } })).json();
    assert.ok(ok.ok, JSON.stringify(ok));
    // doppio clic: l'id vale una volta sola
    const doppio = await a.chiama("/api/funzioni/modello/invia", { method: "POST", json: { ...m, conferma: true, id: pr.id, impronta: pr.impronta } });
    assert.equal(doppio.status, 409);
    assert.match((await doppio.json()).errore, /già stato usato/);
    assert.equal(meta.richieste.length, 1);
    assert.deepEqual(meta.richieste[0].corpo.template, { name: "promemoria_appuntamento", language: { code: "it" }, components: [{ type: "body", parameters: [{ type: "text", text: "domani" }, { type: "text", text: "10:00" }] }] });
    assert.equal(meta.richieste[0].corpo.to, "393339990000");
    // il giro non manda mai modelli da solo
    await a.servizi.whatsapp.giroOra();
    assert.equal(meta.richieste.length, 1);
  } finally { await a.chiudi(); await meta.chiudi(); }
});

// ------------------------------------------------------------------ 5 · ricerca unica
test("5 ricerca unica (FTS5): WhatsApp + posta + Costructo; Lavoro mai il privato; Tutto il privato solo se chiesto; 30 giorni", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Il bagno è pronto per le piastrelle" }));
    arriva(p, ricevuto({ da: PRIVATA, nome: "Anna", testo: "Il bagno di casa perde ancora" }));
    assegna(p.db, CLIENTE, "a1");
    assegna(p.db, PRIVATA, "privato");
    p.db.prepare(`INSERT INTO posta_messaggi (id, casella_id, uid, uid_validity, data, spazio, oggetto, estratto, salvato) VALUES ('m2','c',2,'1',?, 'a2', 'Piastrelle per il bagno', 'ordine', ?)`).run(p.t.ora, p.t.ora);
    const opz = { db: p.db, aziende: p.dip.aziende(), collegate: p.dip.aziendeCostructo(), testo: "bagno" };
    const lavoro = await cercaOvunque({ ...opz, vista: "lavoro" });
    assert.ok(!lavoro.risultati.some((r) => r.spazio === "privato" || /perde ancora/.test(r.estratto)), "Lavoro: mai il privato");
    assert.ok(lavoro.risultati.some((r) => r.fonte === "whatsapp" && r.azienda === "FR Costruire Green"));
    assert.ok(lavoro.risultati.some((r) => r.fonte === "posta" && r.azienda === "Edilgreen"));
    assert.ok(lavoro.risultati.some((r) => r.fonte === "costructo" && /Preventivo bagno Rossi/.test(r.titolo)));
    assert.ok((await cercaOvunque({ ...opz, vista: "tutto" })).risultati.every((r) => r.spazio !== "privato"), "Tutto: il privato solo su richiesta");
    const conPrivato = await cercaOvunque({ ...opz, vista: "tutto", anchePrivato: true });
    assert.ok(conPrivato.privatoIncluso && conPrivato.risultati.some((r) => r.spazio === "privato"));
    const privato = await cercaOvunque({ ...opz, vista: "privato" });
    assert.ok(privato.risultati.length && privato.risultati.every((r) => r.spazio === "privato" && r.fonte !== "costructo"), "Privato: niente Costructo");
    // dall'AI: «anchePrivato» vale solo se Luigi l'ha chiesto con le sue parole
    const ev: EventoFlusso[] = [];
    const ctx = (msg: string): ContestoStrumenti => ({ db: p.db, fuso: FUSO, vista: "tutto", messaggioLuigi: msg, conversazione: "c1", aziende: p.dip.aziendeCostructo(), linkCalendario: () => "", emetti: (e) => ev.push(e), whatsapp: p.dip });
    assert.doesNotMatch((await eseguiStrumento("cerca_ovunque", { testo: "bagno", azienda: "", anchePrivato: true }, ctx("cerca bagno"))).contenuto, /perde ancora/);
    assert.match((await eseguiStrumento("cerca_ovunque", { testo: "bagno", azienda: "", anchePrivato: true }, ctx("cerca bagno anche nelle cose private"))).contenuto, /perde ancora/);
    // operatori FTS neutralizzati
    assert.doesNotThrow(() => cercaOvunque({ ...opz, vista: "lavoro", testo: 'bagno" OR NEAR(* -' }));
    // 30 giorni: il messaggio cancellato sparisce anche dall'indice
    pulisciWhatsappVecchio(p.db, p.t.ora + CONSERVAZIONE_MS + 864e5);
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM cerca_wa").get() as { n: number }).n, 0);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 6, 10 · agenda e vita privata
test("6/10 promesse in chat: lavoro → proposta «agenda» per Costructo; privato → agenda privata di Jarvis con la conferma (mai Costructo); chat escluse", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Ci vediamo domani alle 10 in cantiere Villa Rosa" }));
    arriva(p, ricevuto({ da: PRIVATA, nome: "Anna", testo: "Ricordati di comprare il vino per sabato" }));
    arriva(p, ricevuto({ da: PRIVATA, nome: "Anna", testo: "Il 3 maggio è il compleanno di Marco" }));
    assegna(p.db, PRIVATA, "privato");
    await giro(p);
    const lista = proposte(p.db);
    const agenda = lista.find((x) => x.tipo === "agenda")!;
    assert.deepEqual(datiP(agenda), { data: giornoDa(p.t.ora, 1, FUSO), ora: "10:00", titolo: "Appuntamento con Cliente Prova", cantiereId: "C1" });
    assert.equal(agenda.azienda_id, "a1");
    const private_ = lista.filter((x) => x.tipo === "agenda_privata");
    assert.equal(private_.length, 2);
    assert.ok(private_.every((x) => x.azienda_id === "privato"));
    assert.match(private_.map((x) => x.titolo).join(" | "), /comprare il vino per sabato.*Compleanno di Marco|Compleanno di Marco.*comprare il vino/);
    // il privato non va mai in Costructo
    assert.throws(() => creaProposta(p.db, { tipo: "ore", aziendaId: "privato", chiave: "x", titolo: "x", dati: {} }), /privat/);
    // nella scheda Lavoro le proposte private non si vedono
    assert.ok(proposteVisibili(p.db, "lavoro").every((x) => x.azienda_id !== "privato"));
    assert.ok(proposteVisibili(p.db, "privato").every((x) => x.azienda_id === "privato"));
    // conferma → impegno nell'agenda di Jarvis, niente a Costructo
    const c = private_.find((x) => /Compleanno/.test(x.titolo))!;
    const e = await mandaProposta(p.dip, c.id, improntaProposta(c, nomeAz(p)));
    assert.ok(e.ok, e.messaggio);
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM impegni WHERE titolo = 'Compleanno di Marco'").get() as { n: number }).n, 1);
    assert.equal(postCostructo(p.costructo).length, 0);
    // chat esclusa: niente promemoria
    salvaImpostazioni(p.db, { chatPrivateEscluse: [contatto(p.db, PRIVATA).id] });
    arriva(p, ricevuto({ da: PRIVATA, testo: "Ricordati di chiamare la nonna domani" }));
    await giro(p);
    assert.equal(proposte(p.db).filter((x) => x.tipo === "agenda_privata").length, 2);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 7 · documenti al volo
test("7 documenti al volo: «manda a Bianchi il DURC di FR Costruire Green» → proposta «invio_documenti» con la conferma; azienda sbagliata → rifiuto", async () => {
  const p = await prova();
  try {
    const ev: EventoFlusso[] = [];
    const ctx = (msg: string, vista: "lavoro" | "tutto" = "lavoro"): ContestoStrumenti => ({ db: p.db, fuso: FUSO, vista, messaggioLuigi: msg, conversazione: "c1", aziende: p.dip.aziendeCostructo(), linkCalendario: () => "", emetti: (e) => ev.push(e), whatsapp: p.dip });
    // due aziende e nessun nome: chiede
    const chiede = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "DURC", azienda: "" }, ctx("manda a Bianchi il DURC"));
    assert.match(chiede.contenuto, /Di quale azienda è il documento: FR Costruire Green o Edilgreen\?/);
    // nomina FR ma l'AI chiede Edilgreen: rifiutato
    const sbagliata = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "DURC", azienda: "Edilgreen" }, ctx("manda a Bianchi il DURC di FR Costruire Green"));
    assert.match(sbagliata.contenuto, /Hai nominato FR Costruire Green, ma il documento cercato è di Edilgreen: non preparo niente/);
    assert.equal(proposte(p.db).length, 0);
    // documento di un'altra ditta: rifiutato
    p.costructo.risposte["/documenti"] = { corpo: { documenti: [{ id: "D9", tipoDocumento: "Visura", ditta: "Altra Ditta Srl" }] } };
    dimenticaLetture(p.db);
    const altrui = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "Visura", azienda: "FR Costruire Green" }, ctx("manda a Bianchi la visura di FR Costruire Green"));
    assert.match(altrui.contenuto, /non è di FR Costruire Green/);
    assert.equal(proposte(p.db).length, 0);
    // giusto: proposta + conferma con il testo completo
    // due DURC propri: chiede quale
    p.costructo.risposte["/documenti"] = { corpo: { documenti: [{ id: "D1", tipoDocumento: "DURC", di_chi: "azienda", scadenza: "2026-12-01" }, { id: "D3", tipoDocumento: "DURC", di_chi: "azienda", scadenza: "2026-06-01" }] } };
    dimenticaLetture(p.db);
    const due = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "DURC", azienda: "FR Costruire Green" }, ctx("manda a Bianchi il DURC di FR Costruire Green"));
    assert.match(due.contenuto, /Ho trovato 2 documenti «DURC» di FR Costruire Green: quale mando\? DURC \(ID D1, scade il 01\/12\/2026\); DURC \(ID D3, scade il 01\/06\/2026\)/);
    // destinatario ambiguo (due «Bianchi»): chiede
    p.costructo.risposte["/documenti"] = { corpo: { documenti: [{ id: "D1", tipoDocumento: "DURC", ditta: "FR Costruire Green", scadenza: "2026-12-01" }, { id: "D2", tipoDocumento: "DURC", ditta: "Idraulica Bianchi" }] } };
    dimenticaLetture(p.db);
    const chi = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Bianchi", documento: "DURC", azienda: "FR Costruire Green" }, ctx("manda a Bianchi il DURC di FR Costruire Green"));
    assert.match(chi.contenuto, /A chi, di preciso\? Idraulica Bianchi, Bianchi Srl/);
    assert.equal(proposte(p.db).length, 0);
    const ok = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "DURC", azienda: "FR Costruire Green" }, ctx("manda a Bianchi il DURC di FR Costruire Green"));
    assert.match(ok.contenuto, /NON mandata/);
    const [pr] = proposte(p.db);
    assert.deepEqual(datiP(pr), { voceIds: ["D1"], destinatario: "Idraulica Bianchi", controparteId: "K1" }, "solo il DURC di FR, non quello del subappaltatore; controparte risolta in Costructo");
    const conferma = ev.find((e) => e.tipo === "conferma") as Extract<EventoFlusso, { tipo: "conferma" }>;
    assert.match(conferma.domanda, /Proposta per Costructo · FR Costruire Green[\s\S]*Documenti: D1 \(DURC \(ID D1, scade il 01\/12\/2026\)\)[\s\S]*Destinatario: Idraulica Bianchi/);
    assert.equal(postCostructo(p.costructo).length, 0, "niente parte senza il sì");
    const r = await rispondiConferma(p.db, conferma.id, "conferma", FUSO, Date.now(), undefined, p.dip);
    assert.ok(r.ok, r.messaggio);
    assert.deepEqual(p.pagina.ricevute.map((x) => [x.tipo, (x.dati as { voceIds: string[] }).voceIds]), [["invio_documenti", ["D1"]]]);
    // nella scheda Privato lo strumento non c'è
    const priv = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Bianchi", documento: "DURC", azienda: "" }, { ...ctx("manda a Bianchi il DURC"), vista: "privato" as never });
    assert.ok(priv.errore);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 9 · posizione
test("9 posizione → cantiere più vicino (entro 1 km); più lontano → «nuovo sopralluogo?»", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Buongiorno" }));
    await giro(p); // trovato in Costructo: è un cliente, non un operaio
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", tipo: "location", extra: { location: { latitude: 45.003, longitude: 9.0, name: "Qui" } } }));
    await giro(p);
    const a = p.db.prepare("SELECT a.cantiere_nome, a.esito FROM wa_analisi a JOIN wa_messaggi m ON m.id = a.messaggio_id WHERE m.tipo = 'location'").get() as { cantiere_nome: string; esito: string };
    assert.equal(a.cantiere_nome, "Villa Rosa");
    assert.ok(JSON.parse(a.esito).metri < 400);
    assert.equal(proposte(p.db).length, 0);
    arriva(p, ricevuto({ da: CLIENTE, tipo: "location", extra: { location: { latitude: 45.1, longitude: 9.0, address: "Via Lontana 1" } } }));
    await giro(p);
    const [s] = proposte(p.db);
    assert.equal(s.tipo, "richiesta_lavoro");
    assert.match(String(datiP(s).descrizione), /Nuovo sopralluogo\?/);
    assert.equal(datiP(s).indirizzo, "Via Lontana 1");
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 11 · rubrica
test("11 rubrica: in Costructo, operaio, sconosciuto con controparti suggerite → proposta «contatto» (numero intero solo nella proposta)", async () => {
  const p = await prova();
  try {
    operaio(p);
    arriva(p, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Buongiorno" }));
    arriva(p, ricevuto({ da: NUOVO, nome: "Nuovo Fornitore", testo: "Buongiorno" }));
    assegna(p.db, CLIENTE, "a1");
    assegna(p.db, NUOVO, "a1");
    const [fr] = await rubrica(p.db, p.dip.aziende().slice(0, 1), p.dip.aziendeCostructo());
    const stato = Object.fromEntries(fr.contatti.map((c) => [c.nome, c.stato]));
    assert.deepEqual(stato, { "Mario R.": "operaio", "Cliente Prova": "in_costructo", "Nuovo Fornitore": "sconosciuto" });
    const nuovo = fr.contatti.find((c) => c.nome === "Nuovo Fornitore")!;
    assert.deepEqual(nuovo.suggerite, [{ id: "K4", nome: "Nuovo Fornitore" }]);
    assert.equal(nuovo.numero, "•••002");
    assert.ok(p.costructo.richieste.some((r) => r.percorso.includes("/controparti?telefono=")), "cerca anche per telefono");
    const id = await proponiContatto(p.db, p.dip.aziende(), p.dip.aziendeCostructo(), nuovo.id, "K4");
    assert.deepEqual(datiP(leggiProposta(p.db, id)!), { controparteId: "K4", telefono: `+${NUOVO}` });
    await assert.rejects(proponiContatto(p.db, p.dip.aziende(), p.dip.aziendeCostructo(), nuovo.id, "K99"), /non trovata/);
    assert.equal(postCostructo(p.costructo).length, 0);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 12 · richiesta di lavoro
test("12 nuova richiesta di lavoro → proposta (estrazione con Haiku controllata da zod); nessuna risposta automatica; mai prezzi nelle risposte", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: NUOVO, nome: "Paola", testo: "Buongiorno, vorrei un preventivo per rifare il bagno in via Roma 3" }));
    assegna(p.db, NUOVO, "a1");
    await giro(p);
    const [r] = proposte(p.db);
    assert.equal(r.tipo, "richiesta_lavoro");
    // «sopralluogoData: domani» non è una data valida: zod la scarta (niente sopralluogo inventato)
    assert.deepEqual(datiP(r), { nome: "Paola Verdi", telefono: `+${NUOVO}`, indirizzo: "via Roma 3, Milano", descrizione: "Rifare il bagno" });
    assert.equal(postMeta(p.meta).length, 0, "Jarvis non risponde da solo");
    assert.ok(!JSON.stringify(p.db.prepare("SELECT * FROM registro").all()).includes("rifare il bagno"), "nel registro niente testi");
    // la risposta proposta dall'AI non contiene prezzi
    const testo = await proponiTesto(p.dip, contatto(p.db, NUOVO).id);
    assert.doesNotMatch(testo, /5\.000|4800/);
    assert.match(testo, /\[da completare\]/);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 13, 14, 15, 16, 17 · allegati
test("13 foto → cantiere giusto: scaricate solo con l'interruttore (entro 5 minuti), foto vicine in una proposta, problema riconosciuto", async () => {
  const p = await prova();
  try {
    operaio(p);
    p.meta.media["img1"] = { mime: "image/jpeg", dati: jpeg("JPEG-finto-1") };
    p.meta.media["img2"] = { mime: "image/jpeg", dati: jpeg("JPEG-finto-2") };
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "img1", mime_type: "image/jpeg", caption: "Villa Rosa: crepa nel muro" } } }));
    await giro(p);
    assert.equal(p.meta.richieste.length, 0, "scaricamento spento di serie: nessuna richiesta a Meta");
    assert.equal(proposte(p.db).length, 0);
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "img1", mime_type: "image/jpeg", caption: "Villa Rosa: crepa nel muro" } }, id: "wamid.foto.a" }));
    p.t.ora += 30_000;
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "img2", mime_type: "image/jpeg" } }, id: "wamid.foto.b" }));
    await giro(p);
    assert.ok(p.meta.richieste.some((r) => r.host === "graph.facebook.com") && p.meta.richieste.some((r) => r.host === "lookaside.fbsbx.com"), "metadati e file, con il token solo verso Meta");
    assert.ok(p.meta.richieste.every((r) => r.intestazioni.authorization === "Bearer EAAtokenfintosolopertest1234567890"));
    const foto = proposte(p.db).filter((x) => x.tipo === "foto");
    assert.equal(foto.length, 1, "foto vicine: una proposta");
    assert.equal(JSON.parse(foto[0].allegati).length, 3, "anche la foto arrivata prima dell'accensione (ultimi 7 giorni) viene recuperata");
    assert.deepEqual({ ...datiP(foto[0]), data: undefined }, { cantiereId: "C1", tipo: "problema", descrizione: "Villa Rosa: crepa nel muro", data: undefined });
    // conferma: gli allegati partono in base64 con nome e formato
    const e = await mandaProposta(p.dip, foto[0].id, improntaProposta(foto[0], nomeAz(p)));
    assert.ok(e.ok, e.messaggio);
    const all = p.pagina.ricevute[0].allegati as Array<{ nome: string; mime: string; base64: string }>;
    assert.deepEqual(all.map((x) => [x.mime, Buffer.from(x.base64, "base64").subarray(3).toString()]), [["image/jpeg", "JPEG-finto-1"], ["image/jpeg", "JPEG-finto-1"], ["image/jpeg", "JPEG-finto-2"]]);
    // i contatti privati non si scaricano mai
    arriva(p, ricevuto({ da: PRIVATA, tipo: "image", extra: { image: { id: "img1", mime_type: "image/jpeg" } } }));
    assegna(p.db, PRIVATA, "privato");
    const prima = p.meta.richieste.length;
    await giro(p);
    assert.equal(p.meta.richieste.length, prima);
  } finally { await p.chiudi(); }
});

test("14/15/16/17 documenti: fattura fornitore, DURC del subappaltatore, consegne (differenze solo segnalate), scontrini solo in Jarvis (Prima Nota esclusa)", async () => {
  const p = await prova();
  try {
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    p.meta.media["pdf1"] = { mime: "application/pdf", dati: Buffer.from("%PDF-fattura") };
    p.meta.media["pdf2"] = { mime: "application/pdf", dati: Buffer.from("%PDF-durc") };
    p.meta.media["img9"] = { mime: "image/jpeg", dati: jpeg("JPEG-scontrino") };
    // FORNITORE è «Idraulica Bianchi» in Costructo (FR Costruire Green)
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "document", extra: { document: { id: "pdf1", mime_type: "application/pdf", filename: "Fattura_45.pdf", caption: "fattura n. 45 del 12/11/2026 totale 1.220,00 €" } } }));
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "document", extra: { document: { id: "pdf2", mime_type: "application/pdf", filename: "DURC.pdf", caption: "DURC aggiornato, scadenza 15/03/2027" } } }));
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", testo: "Consegnati 20 sacchi di cemento e 3 bancali di mattoni in cantiere Villa Rosa" }));
    p.t.ora += 5 * MINUTO;
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", testo: "Scusate, consegnati 18 sacchi di cemento" }));
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "image", extra: { image: { id: "img9", mime_type: "image/jpeg", caption: "scontrino gasolio" } } }));
    await giro(p);
    const per = (t: string) => proposte(p.db).filter((x) => x.tipo === t);
    const [f] = per("documento_fornitore");
    assert.deepEqual(datiP(f), { fornitore: "Idraulica Bianchi", tipo: "fattura", numero: "45", data: "2026-11-12", importo: 1220 });
    assert.equal(JSON.parse(f.allegati)[0].mime, "application/pdf");
    const [d] = per("rinnovo_documento");
    assert.deepEqual(datiP(d), { voceId: "D2", tipoDocumento: "DURC", dataScadenza: "2027-03-15" });
    const carichi = per("carico_magazzino");
    assert.equal(carichi.length, 2);
    assert.deepEqual(datiP(carichi[0]).righe, [{ quantita: 20, unita: "sacchi", descrizione: "cemento" }, { quantita: 3, unita: "bancali", descrizione: "mattoni" }]);
    assert.equal(datiP(carichi[0]).cantiereId, "C1");
    assert.match(carichi[1].avvisi, /Differenza da controllare: «cemento» 20 sacchi in un altro messaggio, qui 18/);
    assert.deepEqual(datiP(carichi[1]).righe, [{ quantita: 18, unita: "sacchi", descrizione: "cemento" }], "le quantità restano quelle scritte: niente corretto da solo");
    // scontrino: solo in Jarvis, nessuna proposta, nessuna scrittura in Costructo (Prima Nota esclusa)
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM scontrini").get() as { n: number }).n, 1);
    assert.ok(!proposte(p.db).some((x) => /scontrino|prima.?nota/i.test(x.tipo + x.titolo)));
    // conferma in blocco: «manda le 3 proposte», ognuna con la sua impronta
    const voci = [f, d, carichi[0]].map((x) => ({ id: x.id, impronta: improntaProposta(x, nomeAz(p)) }));
    const e = await mandaProposte(p.dip, voci);
    assert.equal(e.esiti.filter((x) => x.ok).length, 3, e.messaggio);
    assert.ok(postCostructo(p.costructo).every((r) => r.percorso === "/api/assistente/v1/proposte"), "l'unica scrittura è POST /proposte");
    assert.ok(!p.costructo.richieste.some((r) => /prima.?nota/i.test(r.percorso)));
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 20 · diario
test("20 bozza del diario di cantiere dai messaggi e dalle foto del giorno → proposta «diario»", async () => {
  const p = await prova();
  try {
    operaio(p);
    arriva(p, ricevuto({ da: OPERAIO, testo: "Villa Rosa: arrivato il calcestruzzo" }));
    arriva(p, ricevuto({ da: OPERAIO, testo: "8 ore cantiere Villa Rosa" }));
    await giro(p);
    const id = await preparaDiario(p.db, p.dip.aziendeCostructo(), "a1", "C1", dataIso(p.t.ora, FUSO), FUSO, p.t.ora);
    const d = datiP(leggiProposta(p.db, id)!);
    assert.equal(d.cantiereId, "C1");
    assert.match(String(d.testo), /Diario del .* · Villa Rosa\n- \d+:\d\d Mario Rossi: Riassunto finto/);
    assert.match(String(d.testo), /Ore proposte: Mario Rossi 8/);
    await assert.rejects(preparaDiario(p.db, p.dip.aziendeCostructo(), "a1", "C2", dataIso(p.t.ora, FUSO), FUSO, p.t.ora), /non ho trovato/);
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ attribuzione per azienda
test("contatti da assegnare: nessuna funzione finché Luigi non dice di quale azienda è; poi riparte", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: NUOVO, nome: "Sconosciuto", testo: "Ci vediamo domani alle 9 per il sopralluogo" }));
    await giro(p);
    assert.equal(contatto(p.db, NUOVO).spazio, "");
    assert.equal(proposte(p.db).length, 0, "da assegnare: niente proposte");
    assegna(p.db, NUOVO, "a2");
    await giro(p);
    const [a] = proposte(p.db);
    assert.equal(a.azienda_id, "a2", "la proposta va all'azienda scelta da Luigi");
    assert.equal(a.titolo, "Sopralluogo con Sconosciuto");
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ 30 giorni
test("30 giorni: proposte, allegati, promesse, scontrini e analisi si cancellano; restano le scelte di Luigi (operai)", async () => {
  const p = await prova();
  try {
    operaio(p);
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    p.meta.media["img1"] = { mime: "image/jpeg", dati: jpeg("JPEG") };
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "img1", mime_type: "image/jpeg", caption: "Villa Rosa" } } }));
    arriva(p, eco({ a: OPERAIO, testo: "ti mando il programma domani" }));
    await giro(p);
    assert.ok(proposte(p.db).length && (p.db.prepare("SELECT COUNT(*) n FROM wa_allegati").get() as { n: number }).n === 1);
    const dopo = p.t.ora + CONSERVAZIONE_MS + 864e5;
    pulisciWhatsappVecchio(p.db, dopo);
    pulisciFunzioniVecchie(p.db, dopo);
    for (const t of ["proposte", "wa_allegati", "promesse", "scontrini", "wa_analisi", "wa_media_stato", "cerca_wa"]) {
      assert.equal((p.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0, t);
    }
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM wa_operai").get() as { n: number }).n, 1, "la scelta di Luigi resta");
  } finally { await p.chiudi(); }
});

// ------------------------------------------------------------------ API della pagina Proposte
async function ambienteProposte(): Promise<{ a: Ambiente; f: Finto; meta: MetaFinto; pagina: ReturnType<typeof propostePagina> }> {
  const meta = await avviaMetaFinto();
  const f = await avviaCostructoFinto();
  const pagina = propostePagina();
  f.risposte["/proposte"] = pagina.gestisci;
  f.risposte["/cantieri"] = { corpo: [{ id: "C1", nome: "Villa Rosa" }] };
  f.risposte["/operai"] = { corpo: { operai: [{ id: "O1", nome: "Mario Rossi", attivo: true }] } };
  const cervello = cervelloFunzioni();
  const a = await avviaAmbiente({ cervello: async () => cervello, fetchWhatsapp: meta.fetch });
  salvaSegreto(a.db, cifratore, "costructo_url", f.url);
  salvaSegreto(a.db, cifratore, "costructo_aziende", JSON.stringify(AZIENDE));
  return { a, f, meta, pagina };
}

test("API Proposte: testo completo e impronta; correzione; invio solo con {conferma: true} e impronte giuste; scheda Lavoro senza il privato", async () => {
  const { a, f, meta, pagina } = await ambienteProposte();
  try {
    await a.accedi();
    const p1 = creaProposta(a.db, { tipo: "ore", aziendaId: "a1", chiave: "wa:x:ore", titolo: "Ore di Mario Rossi", dati: { operaioId: "O1", data: "2026-11-18", ore: 8 }, nomi: { operaioId: "Mario Rossi" } }).proposta;
    creaProposta(a.db, { tipo: "agenda_privata", aziendaId: "privato", chiave: "wa:y:agenda", titolo: "Cena", dati: { titolo: "Cena", data: "2026-11-20", ora: "20:30" } });
    const lavoro = await (await a.chiama("/api/proposte?vista=lavoro")).json();
    assert.deepEqual(lavoro.proposte.map((x: { tipo: string }) => x.tipo), ["ore"], "Lavoro: niente privato");
    const v = lavoro.proposte[0];
    assert.equal(v.completa, false, "manca il cantiere");
    assert.match(v.testoCompleto, /Proposta per Costructo · FR Costruire Green\nTipo: Ore \(rapportino\)\nTitolo: Ore di Mario Rossi\nOperaio: O1 \(Mario Rossi\)/);
    f.risposte["/proposte/:id"] = pagina.gestisci;
    // incompleta: non parte
    let e = await (await a.chiama("/api/proposte/manda", { method: "POST", json: { conferma: true, voci: [{ id: v.id, impronta: v.impronta }] } })).json();
    assert.match(e.esiti[0].messaggio, /Mancano dei dati: Cantiere/);
    const scelte = await (await a.chiama(`/api/proposte/${v.id}/scelte`)).json();
    assert.deepEqual(scelte.cantieri, [{ id: "C1", nome: "Villa Rosa" }]);
    // il nome mandato dal browser si ignora: lo prende il server da Costructo
    const corretta = await (await a.chiama(`/api/proposte/${v.id}`, { method: "PATCH", json: { dati: { cantiereId: "C1" }, nomi: { cantiereId: "Nome falso dal browser" } } })).json();
    assert.ok(corretta.completa);
    assert.equal(corretta.nomi.cantiereId, "Villa Rosa");
    assert.notEqual(corretta.impronta, v.impronta);
    const sconosciuto = await a.chiama(`/api/proposte/${v.id}`, { method: "PATCH", json: { dati: { operaioId: "O2" } } });
    assert.equal(sconosciuto.status, 400, "operaio che non è di questa azienda in Costructo");
    assert.equal((await a.chiama(`/api/proposte/${v.id}`, { method: "PATCH", json: { dati: { descrizione: "Rifinito" } } })).status, 200);
    assert.equal((await a.chiama(`/api/proposte/${v.id}`, { method: "PATCH", json: { dati: { chiaveDoppione: "x" } } })).status, 400, "campi non previsti rifiutati");
    const attuale = vistaProposta(leggiProposta(a.db, p1.id)!, (id) => (id === "a1" ? "FR Costruire Green" : id));
    // senza conferma o con l'impronta vecchia: niente
    assert.equal((await a.chiama("/api/proposte/manda", { method: "POST", json: { voci: [{ id: v.id, impronta: attuale.impronta }] } })).status, 400);
    e = await (await a.chiama("/api/proposte/manda", { method: "POST", json: { conferma: true, voci: [{ id: v.id, impronta: corretta.impronta }] } })).json();
    assert.equal(e.esiti[0].ok, false, "impronta di prima della seconda correzione");
    assert.equal(pagina.ricevute.length, 0);
    e = await (await a.chiama("/api/proposte/manda", { method: "POST", json: { conferma: true, voci: [{ id: v.id, impronta: attuale.impronta }] } })).json();
    assert.ok(e.esiti[0].ok, e.messaggio);
    assert.equal(pagina.ricevute.length, 1);
    assert.equal(f.richieste.filter((r) => r.metodo === "POST").length, 1);
    assert.equal(meta.richieste.length, 0);
    // tipi per «Proponi in Costructo»
    const tipi = await (await a.chiama("/api/proposte/tipi")).json();
    assert.ok(tipi.some((t: { tipo: string; perCostructo: boolean }) => t.tipo === "agenda_privata" && !t.perCostructo));
  } finally { await a.chiudi(); await f.chiudi(); await meta.chiudi(); }
});

test("API «Proponi in Costructo» da un messaggio WhatsApp: per azienda, mai dal privato verso Costructo, mai dai gruppi", async () => {
  const { a, f, meta } = await ambienteProposte();
  try {
    await a.accedi();
    elaboraWebhook(a.db, ricevuto({ da: CLIENTE, nome: "Cliente Prova", testo: "Domani alle 15 sopralluogo a Villa Rosa" }), PHONE_NUMBER_ID);
    elaboraWebhook(a.db, ricevuto({ da: PRIVATA, nome: "Anna", testo: "Cena venerdì alle 20" }), PHONE_NUMBER_ID);
    const msg = (w: string) => (a.db.prepare("SELECT m.id FROM wa_messaggi m JOIN wa_contatti c ON c.id = m.contatto_id WHERE c.wa_id = ?").get(w) as { id: string }).id;
    let r = await a.chiama("/api/proposte/da-messaggio", { method: "POST", json: { messaggioId: msg(CLIENTE), tipo: "agenda" } });
    assert.equal(r.status, 400, "contatto da assegnare");
    assert.match((await r.json()).errore, /di quale azienda/);
    assegna(a.db, CLIENTE, "a1");
    assegna(a.db, PRIVATA, "privato");
    r = await a.chiama("/api/proposte/da-messaggio", { method: "POST", json: { messaggioId: msg(CLIENTE), tipo: "agenda" } });
    const v = await r.json();
    assert.equal(v.tipo, "agenda");
    assert.equal(v.dati.ora, "15:00");
    assert.equal((await a.chiama("/api/proposte/da-messaggio", { method: "POST", json: { messaggioId: msg(PRIVATA), tipo: "agenda" } })).status, 400, "il privato non va in Costructo");
    const priv = await (await a.chiama("/api/proposte/da-messaggio", { method: "POST", json: { messaggioId: msg(PRIVATA), tipo: "agenda_privata" } })).json();
    assert.equal(priv.azienda, "privato");
    assert.equal(priv.perCostructo, false);
    // la pagina WhatsApp mostra le proposte nate dal messaggio
    const chat = await (await a.chiama(`/api/whatsapp/chat/${contatto(a.db, CLIENTE).id}`)).json();
    assert.equal(chat.messaggi.at(-1).proposte[0].tipo, "agenda");
    assert.equal(f.richieste.filter((x) => x.metodo === "POST").length, 0);
    assert.equal(meta.richieste.length, 0);
  } finally { await a.chiudi(); await f.chiudi(); await meta.chiudi(); }
});

// ------------------------------------------------------------------ correzioni dopo la revisione indipendente
test("revisione B: l'operaio vale per azienda — contatto spostato a un'altra azienda → si chiede di nuovo; operaio non di quell'azienda → non parte", async () => {
  const p = await prova();
  try {
    operaio(p); // operaio O1 di FR Costruire Green (a1)
    // Luigi sposta il contatto a Edilgreen: le ore NON usano l'operaio di a1, Jarvis chiede di nuovo (per a2)
    p.db.prepare("UPDATE wa_contatti SET spazio = 'a2', fonte_spazio = 'luigi' WHERE wa_id = ?").run(OPERAIO);
    arriva(p, ricevuto({ da: OPERAIO, testo: "8 ore cantiere Villa Rosa" }));
    await giro(p);
    assert.equal(proposte(p.db).length, 0, "nessuna proposta con l'operaio dell'altra azienda");
    const aperte = p.db.prepare("SELECT azienda_id FROM wa_domande_operaio WHERE stato = 'aperta'").all() as Array<{ azienda_id: string }>;
    assert.deepEqual(aperte.map((x) => x.azienda_id), ["a2"], "domanda per la nuova azienda");
    // domanda aperta per a1 che non vale più dopo il cambio: chiusa
    const c = contatto(p.db, OPERAIO);
    p.db.prepare("INSERT INTO wa_domande_operaio (id, contatto_id, azienda_id, creata, stato) VALUES ('ox', ?, 'a1', ?, 'aperta')").run(c.id, p.t.ora);
    const { assegnaSpazio } = await import("../src/whatsapp/archivio.js");
    assegnaSpazio(p.db, c.id, "a2", "luigi");
    assert.equal((p.db.prepare("SELECT stato FROM wa_domande_operaio WHERE id = 'ox'").get() as { stato: string }).stato, "risposta");
    // proposta «ore» con un operaio che in Costructo non è dell'azienda: ricontrollo prima di mandare
    const pr = creaProposta(p.db, { tipo: "ore", aziendaId: "a2", chiave: "prova:ore:a2", titolo: "Ore", dati: { operaioId: "O1", cantiereId: "C1", data: dataIso(p.t.ora, FUSO), ore: 8 } }).proposta;
    p.costructo.risposte2["/operai"] = { corpo: { operai: [{ id: "O9", nome: "Altro Operaio", attivo: true }] } };
    const e = await mandaProposta(p.dip, pr.id, improntaProposta(pr, nomeAz(p)));
    assert.equal(e.ok, false);
    assert.match(e.messaggio, /non è tra gli operai attivi di Edilgreen/);
    assert.equal(postCostructo(p.costructo).length, 0, "il token di Edilgreen non manda l'operaio di FR");
  } finally { await p.chiudi(); }
});

test("revisione C: DURC — tutte le parole del nome a parole intere, mai i documenti dell'azienda stessa, nessuna o più voci → voce vuota e domanda", async () => {
  const p = await prova();
  try {
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    const durc = (id: string, caption = "DURC aggiornato") => ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "document", id: `wamid.${id}`, extra: { document: { id, mime_type: "application/pdf", filename: "DURC.pdf", caption } } });
    p.meta.media["d1"] = { mime: "application/pdf", dati: Buffer.from("%PDF-1") };
    // D7 è della ditta «Idraulica Bianchi» ma è un documento dell'azienda (di_chi): escluso. Resta solo D2.
    arriva(p, durc("d1"));
    await giro(p);
    assert.equal(datiP(proposte(p.db)[0]).voceId, "D2");
    // «Bianchi» non deve corrispondere a «Bianchini Srl» (parole intere), e servono TUTTE le parole del nome
    p.costructo.risposte["/documenti"] = { corpo: { documenti: [{ id: "D5", tipoDocumento: "DURC", ditta: "Bianchini Idraulica Srl" }, { id: "D6", tipoDocumento: "DURC", ditta: "Bianchi Costruzioni" }] } };
    dimenticaLetture(p.db);
    p.meta.media["d2"] = { mime: "application/pdf", dati: Buffer.from("%PDF-2") };
    arriva(p, durc("d2"));
    await giro(p);
    const nessuna = proposte(p.db)[1];
    assert.equal(datiP(nessuna).voceId, undefined);
    assert.equal(datiP(nessuna).ditta, "Idraulica Bianchi");
    assert.match(nessuna.avvisi, /Di quale voce si tratta\?/);
    // due voci della ditta: non sceglie
    p.costructo.risposte["/documenti"] = { corpo: { documenti: [{ id: "D8", tipoDocumento: "DURC", ditta: "Idraulica Bianchi" }, { id: "D9", tipoDocumento: "DURC", intestatario: "Idraulica Bianchi Srl" }] } };
    dimenticaLetture(p.db);
    p.meta.media["d3"] = { mime: "application/pdf", dati: Buffer.from("%PDF-3") };
    arriva(p, durc("d3"));
    await giro(p);
    const due = proposte(p.db)[2];
    assert.equal(datiP(due).voceId, undefined);
    assert.match(due.avvisi, /ne corrispondono 2/);
  } finally { await p.chiudi(); }
});

test("revisione D: posizioni — mai dai gruppi, mai da contatti non chiariti; diventato operaio → via coordinate, cantiere vicino e «nuovo sopralluogo?»", async () => {
  const p = await prova();
  try {
    const pos = (da: string, extra: Record<string, unknown> = {}) => ricevuto({ da, tipo: "location", extra: { location: { latitude: 45.1, longitude: 9.0, address: "Via Lontana 1" } }, ...extra });
    arriva(p, pos(NUOVO, { gruppo: "gruppo-1" }));
    arriva(p, pos(NUOVO));
    const salvate = p.db.prepare("SELECT testo, media FROM wa_messaggi WHERE tipo = 'location'").all() as Array<{ testo: string; media: string }>;
    assert.ok(salvate.every((x) => !/45\.1|Lontana/.test(x.testo + x.media)), JSON.stringify(salvate));
    assert.match(salvate[0].testo, /nel gruppo \(non salvata\)/);
    assert.match(salvate[1].testo, /non salvata: Jarvis la usa solo per clienti e fornitori/);
    // assegnato da Luigi ma non ancora chiarito: niente proposta, si chiede se è un operaio
    assegna(p.db, NUOVO, "a1");
    await giro(p);
    assert.equal(proposte(p.db).length, 0);
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM wa_domande_operaio WHERE stato = 'aperta'").get() as { n: number }).n, 1);
    // Luigi: «non è un operaio» → la posizione si salva e si usa
    rispondiOperaio(p.db, contatto(p.db, NUOVO).id, "a1", null);
    arriva(p, pos(NUOVO));
    await giro(p);
    const s = proposte(p.db).find((x) => x.chiave_doppione.endsWith(":sopralluogo"))!;
    assert.equal(datiP(s).indirizzo, "Via Lontana 1");
    arriva(p, ricevuto({ da: NUOVO, tipo: "location", extra: { location: { latitude: 45.002, longitude: 9.0 } } }));
    await giro(p);
    assert.ok((p.db.prepare("SELECT COUNT(*) n FROM wa_analisi WHERE cantiere_nome = 'Villa Rosa'").get() as { n: number }).n === 1);
    // poi Luigi corregge: è un operaio → via tutto quello che veniva dalle sue posizioni
    rispondiOperaio(p.db, contatto(p.db, NUOVO).id, "a1", { id: "O2", nome: "Gino Neri" });
    const tutto = JSON.stringify(p.db.prepare("SELECT testo, media FROM wa_messaggi WHERE tipo = 'location'").all()) + JSON.stringify(p.db.prepare("SELECT * FROM wa_analisi").all());
    assert.ok(!/45\.1|45\.002|Lontana|Villa Rosa/.test(tutto), tutto);
    assert.equal(leggiProposta(p.db, s.id)!.stato, "scartata");
  } finally { await p.chiudi(); }
});

test("revisione A: fasce orarie, ore future rifiutate, più ore nello stesso messaggio; «domani» a mezzanotte di Roma", async () => {
  const ora = Date.UTC(2026, 10, 18, 9);
  assert.deepEqual(leggiOre("dalle 7-12 fatte 5 ore cantiere Villa Rosa", ora, FUSO).map((x) => [x.ore, x.data]), [[5, undefined]], "«7-12» è una fascia oraria, non il 7 dicembre");
  const due = leggiOre("Villa Rosa 8h, domani 6h", ora, FUSO);
  assert.deepEqual(due.map((x) => [x.ore, x.data, !!x.futuro]), [[8, undefined, false], [6, "2026-11-19", true]]);
  assert.equal(validaDatiOre("2026-11-19", "2026-11-18"), false, "ore di domani: rifiutate anche dallo schema");
  assert.equal(validaDatiOre("2026-11-18", "2026-11-18"), true);
  // mezzanotte a Roma: alle 00:30 del 19 (23:30 UTC del 18) «domani» è il 20; alle 23:30 del 18 (22:30 UTC) è il 19
  assert.equal(leggiData("domani", Date.UTC(2026, 10, 18, 23, 30), FUSO), "2026-11-20");
  assert.equal(leggiData("domani", Date.UTC(2026, 10, 18, 22, 30), FUSO), "2026-11-19");
  assert.equal(giornoDa(Date.UTC(2026, 10, 18, 23, 30), 0, FUSO), "2026-11-19");
  // nel giro: due voci → due proposte; ore di domani → nessuna proposta
  const p = await prova();
  try {
    operaio(p);
    arriva(p, ricevuto({ da: OPERAIO, testo: "Villa Rosa 8h, Scuola Verdi 6h" }));
    arriva(p, ricevuto({ da: OPERAIO, testo: "domani 8 ore cantiere Villa Rosa" }));
    await giro(p);
    const ore = proposte(p.db).filter((x) => x.tipo === "ore");
    assert.deepEqual(ore.map((x) => [datiP(x).ore, datiP(x).cantiereId]), [[8, "C1"], [6, "C2"]]);
    assert.match(JSON.stringify(p.db.prepare("SELECT esito FROM wa_analisi").all()), /giorno che non è ancora arrivato/);
  } finally { await p.chiudi(); }
});
const validaDatiOre = (data: string, oggi: string) => validaDati("ore", { operaioId: "O1", cantiereId: "C1", data, ore: 8 }, oggi).ok;

test("revisione: impronta di tutto il carico — foto aggiunta dopo la conferma → la vecchia conferma non vale; 404 con «campo» non è la pagina mancante; il finto è stretto", async () => {
  const p = await prova();
  try {
    operaio(p);
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    p.meta.media["a1"] = { mime: "image/jpeg", dati: jpeg("uno") };
    p.meta.media["a2"] = { mime: "image/jpeg", dati: jpeg("due") };
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "a1", mime_type: "image/jpeg", caption: "Villa Rosa" } } }));
    await giro(p);
    const vista = proposte(p.db)[0];
    const vecchia = improntaProposta(vista, nomeAz(p));
    arriva(p, ricevuto({ da: OPERAIO, tipo: "image", extra: { image: { id: "a2", mime_type: "image/jpeg" } } }));
    await giro(p);
    assert.equal(JSON.parse(leggiProposta(p.db, vista.id)!.allegati).length, 2);
    const e = await mandaProposta(p.dip, vista.id, vecchia);
    assert.equal(e.ok, false);
    assert.match(e.messaggio, /cambiata dopo la conferma/);
    assert.equal(postCostructo(p.costructo).length, 0);
    // 404 con «campo»: Costructo non trova un dato → errore, NON «in attesa della pagina»
    p.costructo.risposte["/proposte"] = { stato: 404, corpo: { error: "Cantiere non trovato", campo: "cantiereId" } };
    const ora = leggiProposta(p.db, vista.id)!;
    const e2 = await mandaProposta(p.dip, vista.id, improntaProposta(ora, nomeAz(p)));
    assert.equal(e2.stato, "errore");
    assert.match(e2.messaggio, /Costructo non trova «cantiereId»/);
    // il finto rifiuta campi in più (come Costructo): Jarvis non ne manda
    const { controllaCorpo } = await import("./costructoFinto.js");
    assert.deepEqual(controllaCorpo({ tipo: "ore", chiaveDoppione: "a b", origine: "whatsapp", titolo: "x", dati: { ore: 1, extra: 2 } }), ["chiaveDoppione", "dati.extra"]);
  } finally { await p.chiudi(); }
});

test("revisione: messaggio cancellato da chi l'ha mandato → via allegati, proposte non partite, scontrini e promesse", async () => {
  const p = await prova();
  try {
    operaio(p);
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    p.meta.media["f1"] = { mime: "image/jpeg", dati: jpeg("foto") };
    p.meta.media["s1"] = { mime: "image/jpeg", dati: jpeg("scontrino") };
    arriva(p, ricevuto({ da: OPERAIO, id: "wamid.foto", tipo: "image", extra: { image: { id: "f1", mime_type: "image/jpeg", caption: "Villa Rosa" } } }));
    arriva(p, ricevuto({ da: OPERAIO, id: "wamid.scontrino", tipo: "image", extra: { image: { id: "s1", mime_type: "image/jpeg", caption: "scontrino gasolio" } } }));
    arriva(p, eco({ a: OPERAIO, id: "wamid.promessa", testo: "ti mando il programma domani" }));
    await giro(p);
    assert.equal(proposte(p.db).length, 1);
    for (const w of ["wamid.foto", "wamid.scontrino", "wamid.promessa"]) {
      arriva(p, webhook("messages", { messages: [{ from: OPERAIO, id: `rev.${w}`, timestamp: String(Math.floor(p.t.ora / 1000)), type: "revoke", revoke: { original_message_id: w } }] }));
    }
    assert.equal(proposte(p.db)[0].stato, "scartata");
    for (const t of ["wa_allegati", "scontrini", "promesse"]) assert.equal((p.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0, t);
  } finally { await p.chiudi(); }
});

test("revisione: proposta rimasta «in invio» → ritrovata in Costructo per chiave doppione, altrimenti «esito incerto» (si può rimandare)", async () => {
  const p = await prova();
  try {
    const { recuperaBloccate, ESITO_INCERTO } = await import("../src/proposte/invio.js");
    const a = creaProposta(p.db, { tipo: "agenda", aziendaId: "a1", chiave: "prova:bloccata:1", titolo: "Uno", dati: { data: "2026-12-01", titolo: "Uno" } }).proposta;
    const b = creaProposta(p.db, { tipo: "agenda", aziendaId: "a1", chiave: "prova:bloccata:2", titolo: "Due", dati: { data: "2026-12-01", titolo: "Due" } }).proposta;
    // «a» era arrivata a Costructo prima che Jarvis si fermasse
    p.pagina.gestisci({ metodo: "POST", percorso: "/proposte", parametri: new URLSearchParams(), corpo: { tipo: "agenda", chiaveDoppione: "prova:bloccata:1", origine: "whatsapp", titolo: "Uno", dati: { data: "2026-12-01", titolo: "Uno" } } });
    p.db.prepare("UPDATE proposte SET stato = 'in_invio', aggiornata = ?").run(p.t.ora - 11 * MINUTO);
    assert.equal(await recuperaBloccate(p.dip), 2);
    assert.equal(leggiProposta(p.db, a.id)!.stato, "inviata");
    assert.equal(leggiProposta(p.db, b.id)!.stato, "errore");
    assert.equal(leggiProposta(p.db, b.id)!.esito, ESITO_INCERTO);
    const e = await mandaProposta(p.dip, b.id, improntaProposta(leggiProposta(p.db, b.id)!, nomeAz(p)));
    assert.ok(e.ok, "rimandata: nessun doppione");
    assert.equal(p.pagina.ricevute.length, 2);
  } finally { await p.chiudi(); }
});

test("revisione: primi byte del file controllati; scaricamento acceso dopo → le proposte dei 7 giorni prima ricevono il PDF", async () => {
  const p = await prova();
  try {
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "document", extra: { document: { id: "x1", mime_type: "application/pdf", filename: "Fattura_9.pdf" } } }));
    arriva(p, ricevuto({ da: FORNITORE, nome: "Idraulica Bianchi", tipo: "image", extra: { image: { id: "x2", mime_type: "image/jpeg", caption: "Villa Rosa" } } }));
    await giro(p);
    const fattura = proposte(p.db).find((x) => x.tipo === "documento_fornitore")!;
    assert.equal(fattura.allegati, "[]");
    p.meta.media["x1"] = { mime: "application/pdf", dati: Buffer.from("%PDF-1.7 vero") };
    p.meta.media["x2"] = { mime: "image/jpeg", dati: Buffer.from("non è un jpeg") };
    salvaImpostazioni(p.db, { whatsappScaricaAllegati: true });
    p.t.ora += 2 * 864e5;
    await giro(p);
    assert.equal(JSON.parse(leggiProposta(p.db, fattura.id)!.allegati).length, 1, "il PDF arriva alla proposta già nata");
    assert.doesNotMatch(leggiProposta(p.db, fattura.id)!.avvisi, /non scaricato/);
    assert.equal((p.db.prepare("SELECT stato FROM wa_media_stato WHERE messaggio_id = (SELECT id FROM wa_messaggi WHERE tipo = 'image')").get() as { stato: string }).stato, "formato", "un falso JPEG non si salva");
    assert.equal((p.db.prepare("SELECT COUNT(*) n FROM wa_allegati").get() as { n: number }).n, 1);
  } finally { await p.chiudi(); }
});

test("revisione: alla seconda conferma il controllo dell'azienda si rifà con il messaggio vero di Luigi", async () => {
  const p = await prova();
  try {
    const ev: EventoFlusso[] = [];
    const ctx: ContestoStrumenti = { db: p.db, fuso: FUSO, vista: "lavoro", messaggioLuigi: "il DURC di FR Costruire Green per Bianchi", conversazione: "c2", aziende: p.dip.aziendeCostructo(), linkCalendario: () => "", emetti: (e) => ev.push(e), whatsapp: p.dip };
    // niente «manda» nel messaggio: serve la conferma; l'AI però chiede Edilgreen
    const r = await eseguiStrumento("costructo_proponi_documenti", { destinatario: "Idraulica Bianchi", documento: "DURC", azienda: "Edilgreen" }, ctx);
    assert.match(r.contenuto, /serve la conferma/);
    const c = ev.find((e) => e.tipo === "conferma") as Extract<EventoFlusso, { tipo: "conferma" }>;
    const esito = await rispondiConferma(p.db, c.id, "conferma", FUSO, Date.now(), undefined, p.dip);
    assert.equal(esito.ok, false);
    assert.match(esito.messaggio, /Hai nominato FR Costruire Green, ma il documento cercato è di Edilgreen/);
    assert.equal(proposte(p.db).length, 0);
  } finally { await p.chiudi(); }
});
