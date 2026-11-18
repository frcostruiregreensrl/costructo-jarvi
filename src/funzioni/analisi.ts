// Le funzioni WhatsApp nel giro (ogni minuto, dopo l'attribuzione dei contatti):
//  1) vocali → testo (funzione 1), se la trascrizione è accesa; altrimenti «vocale ricevuto, trascrizione spenta»;
//  2) foto e PDF dei contatti delle aziende → salvati in Jarvis (solo con l'interruttore acceso);
//  3) ogni messaggio nuovo (dal vivo, non dei gruppi) → riconoscimento senza AI di ore, foto, documenti, consegne, scontrini,
//     posizioni, appuntamenti, promesse, compleanni, «ricordati di», richieste di lavoro → PROPOSTE da confermare
//     (mai scritte direttamente in Costructo), promesse, scontrini (solo in Jarvis), domande a Luigi.
// Sempre per azienda: un contatto «da assegnare» aspetta la risposta di Luigi; il privato resta privato (agenda di Jarvis,
// mai Costructo); le chat private escluse da Luigi non si toccano. Nel registro mai i testi dei messaggi.
import { z } from "zod";
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { leggiImpostazioni, type Impostazioni } from "../impostazioni.js";
import { riepilogoMese } from "../consumi.js";
import { registra } from "../registro.js";
import { leggiCollegamento } from "../whatsapp/collegamento.js";
import { leggiContatto, mediaDi, nomeContatto, nuovoId } from "../whatsapp/archivio.js";
import { scaricaMedia } from "../whatsapp/media.js";
import { testoBreve } from "../whatsapp/telefono.js";
import { PRIVATO, type ContattoWa, type DipendenzeWhatsapp, type MessaggioWa } from "../whatsapp/tipi.js";
import { leggiChiavi, trascrittoreScelto, secondiStimati, costoTrascrizione, registraCostoTrascrizione, SPENTA, MAX_BYTE } from "../trascrizione/trascrizione.js";
import { creaProposta, leggiProposta, allegatiDi, datiDi, extraDi } from "../proposte/archivio.js";
import { contenutoCoerente } from "../proposte/firme.js";
import { MIME_ALLEGATI, MAX_ALLEGATI, type RiferimentoAllegato, type TipoProposta } from "../proposte/tipi.js";
import { dataBreve, fineGiorno, giornoDa, normalizza } from "./date.js";
import { dataIso } from "../tempo.js";
import {
  leggiAppuntamento, leggiCompleanno, leggiDatiFornitore, leggiDocumento, leggiOre, type OreLette, leggiPromessa, leggiRicordati, leggiRighe, leggiScadenza,
  richiestaLavoro, tipoFoto, eScontrino,
} from "./rilevatori.js";
import { cantieriCitati, cantieriDi, cantierePiuVicino, contropartiDi, contropartiPerNome, documentiDi, documentoDellAzienda, oVuoto, tutteLeParole, type CantiereNoto } from "./costructoLetture.js";
import { chiediOperaio, eOperaio, nonOperaio, operaioDelContatto, togliPosizioni } from "./operai.js";
import { estraiConAi, testoAi } from "./estrai.js";

/** Messaggi analizzati al massimo per giro; messaggi più vecchi di 7 giorni non si analizzano più. */
export const MAX_PER_GIRO = 100;
export const ETA_MASSIMA_ANALISI = 7 * 864e5;
/** Foto dello stesso contatto a meno di 2 minuti: una sola proposta (al massimo 5 foto). */
export const FOTO_INSIEME_MS = 2 * 60_000;
/** Cantiere più vicino: entro 1 km. */
export const RAGGIO_CANTIERE_M = 1000;
/** Nessun cantiere entro 1 km: si propone «nuovo sopralluogo?». */
export const NUOVO_SOPRALLUOGO = "Posizione mandata su WhatsApp: nessun cantiere entro 1 km. Nuovo sopralluogo?";

const MIME_AUDIO = /^audio\/(ogg|mpeg|mp3|mp4|aac|amr|opus|x-m4a|webm)$/;

const azienda = (dip: DipendenzeWhatsapp, id: string): AziendaCollegata | undefined => dip.aziendeCostructo().find((a) => a.id === id && a.client.configurato);
const escluso = (imp: Impostazioni, c: ContattoWa) => c.spazio === PRIVATO && imp.chatPrivateEscluse.includes(c.id);

function segnaMedia(db: Db, messaggioId: string, stato: string, ora: number, fornitore = "", secondi = 0) {
  db.prepare("INSERT OR REPLACE INTO wa_media_stato (messaggio_id, stato, fornitore, secondi, quando) VALUES (?,?,?,?,?)").run(messaggioId, stato, fornitore, secondi, ora);
}

// ---------------------------------------------------------------- 1) vocali
/**
 * Trascrive i vocali nuovi. L'audio si scarica solo se trascrizione E scaricamento sono accesi; si tiene solo in memoria
 * e si azzera subito dopo (anche in caso di errore). Il testo prende il posto del vocale nel messaggio (30 giorni).
 */
export async function giroVocali(dip: DipendenzeWhatsapp, limite = 10): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const vocali = db.prepare(`SELECT * FROM wa_messaggi WHERE tipo = 'audio' AND direzione = 'in' AND storico = 0 AND ricevuto > ?
      AND id NOT IN (SELECT messaggio_id FROM wa_media_stato) ORDER BY ricevuto LIMIT ?`).all(ora - 2 * 864e5, limite) as MessaggioWa[];
  if (!vocali.length) return 0;
  const imp = leggiImpostazioni(db);
  const trascrittore = imp.whatsappScaricaAllegati ? trascrittoreScelto(imp.trascrizioneFornitore, leggiChiavi(db, dip.cifratore), dip.fetchTrascrizione) : null;
  const scrivi = (m: MessaggioWa, t: string) => db.prepare("UPDATE wa_messaggi SET testo = ? WHERE id = ?").run(testoBreve(`${t}${m.testo ? ` ${m.testo}` : ""}`), m.id);
  let fatte = 0;
  for (const m of vocali) {
    const c = leggiContatto(db, m.contatto_id);
    const x = mediaDi(m);
    if (!trascrittore || !c || c.gruppo || m.gruppo_id || escluso(imp, c) || !x.idMedia) { scrivi(m, SPENTA); segnaMedia(db, m.id, "spenta", ora); continue; }
    let audio: Buffer | null = null;
    try {
      const scaricato = await scaricaMedia(leggiCollegamento(dip), x.idMedia, { fetchFn: dip.fetchFn, risolvi: dip.risolvi, maxByte: MAX_BYTE[trascrittore.fornitore] });
      audio = scaricato.dati;
      if (!MIME_AUDIO.test(scaricato.mime)) { scrivi(m, "Vocale ricevuto: formato non riconosciuto, non trascritto."); segnaMedia(db, m.id, "formato", ora); continue; }
      const secondi = secondiStimati(audio.length);
      const spesa = riepilogoMese(db, imp.tettoMensileUsd, dip.fuso, ora).spesaUsd;
      if (spesa + costoTrascrizione(trascrittore.fornitore, secondi) > imp.tettoMensileUsd) {
        scrivi(m, "Vocale ricevuto: non trascritto (tetto di spesa del mese raggiunto).");
        segnaMedia(db, m.id, "tetto", ora, trascrittore.fornitore);
        registra(db, "whatsapp.vocale", "negato", "sistema", { messaggio: m.id, motivo: "tetto di spesa" });
        continue;
      }
      const r = await trascrittore.trascrivi(audio, scaricato.mime);
      registraCostoTrascrizione(db, trascrittore.fornitore, r.secondi, dip.fuso, ora);
      scrivi(m, r.testo ? `Vocale: ${r.testo}` : "Vocale ricevuto: nessuna parola riconosciuta.");
      segnaMedia(db, m.id, "trascritto", ora, trascrittore.fornitore, r.secondi);
      registra(db, "whatsapp.vocale", "fatto", "sistema", { messaggio: m.id, fornitore: trascrittore.fornitore, secondi: r.secondi });
      fatte++;
    } catch (e) {
      scrivi(m, "Vocale ricevuto: trascrizione non riuscita, ascoltalo dal telefono.");
      segnaMedia(db, m.id, "errore", ora, trascrittore.fornitore);
      registra(db, "whatsapp.vocale", "errore", "sistema", { messaggio: m.id, motivo: String((e as Error).message ?? e).slice(0, 120) });
    } finally {
      audio?.fill(0); // l'audio non resta da nessuna parte
    }
  }
  return fatte;
}

// ---------------------------------------------------------------- 2) foto e PDF
/**
 * Scarica foto e PDF dei contatti delle aziende (mai privati, mai da assegnare, mai gruppi), solo con l'interruttore acceso.
 * Anche dei 7 giorni prima dell'accensione (gli id degli allegati di WhatsApp valgono 30 giorni): le proposte già nate senza
 * allegato lo ricevono, e le foto non ancora usate si rianalizzano.
 */
export async function giroAllegati(dip: DipendenzeWhatsapp, limite = 10): Promise<number> {
  const { db } = dip;
  if (!leggiImpostazioni(db).whatsappScaricaAllegati) return 0;
  const ora = dip.ora?.() ?? Date.now();
  const lista = db.prepare(`SELECT m.* FROM wa_messaggi m JOIN wa_contatti c ON c.id = m.contatto_id
      WHERE m.tipo IN ('image','document') AND m.direzione = 'in' AND m.storico = 0 AND m.gruppo_id = '' AND c.gruppo = 0
      AND c.spazio <> '' AND c.spazio <> ? AND m.ricevuto > ? AND m.revocato = 0 AND m.id NOT IN (SELECT messaggio_id FROM wa_media_stato)
      ORDER BY m.ricevuto DESC LIMIT ?`).all(PRIVATO, ora - ETA_MASSIMA_ANALISI, limite) as MessaggioWa[];
  let n = 0;
  for (const m of lista) {
    const x = mediaDi(m);
    if (!x.idMedia || (x.mime && !(MIME_ALLEGATI as readonly string[]).includes(x.mime.split(";")[0].trim()))) { segnaMedia(db, m.id, "formato", ora); continue; }
    try {
      const s = await scaricaMedia(leggiCollegamento(dip), x.idMedia, { fetchFn: dip.fetchFn, risolvi: dip.risolvi, maxByte: 10 * 1024 * 1024 });
      if (!(MIME_ALLEGATI as readonly string[]).includes(s.mime) || !contenutoCoerente(s.dati, s.mime)) { s.dati.fill(0); segnaMedia(db, m.id, "formato", ora); continue; }
      const estensione = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp", "application/pdf": "pdf" }[s.mime] ?? "bin";
      const nome = (x.nomeFile || `${m.tipo === "image" ? "foto" : "documento"}-${dataIso(m.quando, dip.fuso)}.${estensione}`).slice(0, 120);
      db.prepare("INSERT OR IGNORE INTO wa_allegati (id, messaggio_id, contatto_id, mime, nome, dimensione, sha256, dati, scaricato) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(nuovoId("f"), m.id, m.contatto_id, s.mime, nome, s.dimensione, s.sha256, s.dati, ora);
      segnaMedia(db, m.id, "scaricato", ora);
      registra(db, "whatsapp.allegato", "fatto", "sistema", { messaggio: m.id, tipo: m.tipo, dimensione: s.dimensione });
      // Proposte già nate da questo messaggio senza allegato (scaricamento acceso dopo): ricevono l'allegato (nuova impronta).
      const rif = allegatoDi(db, m.id);
      if (rif) {
        for (const p of db.prepare("SELECT * FROM proposte WHERE messaggio_id = ? AND allegati = '[]' AND stato IN ('da_confermare','errore','attesa_costructo')").all(m.id) as Array<{ id: string; tipo: string; avvisi: string }>) {
          if ((p.tipo === "rinnovo_documento" || p.tipo === "documento_fornitore") && rif.mime !== "application/pdf") continue;
          const extra = extraDi(p);
          extra.note = extra.note.filter((x) => !/non scaricato/.test(x));
          db.prepare("UPDATE proposte SET allegati = ?, avvisi = ?, aggiornata = ? WHERE id = ?").run(JSON.stringify([rif]), JSON.stringify(extra), ora, p.id);
        }
        // Una foto analizzata quando lo scaricamento era spento si rianalizza.
        db.prepare("DELETE FROM wa_analisi WHERE messaggio_id = ? AND esito LIKE '%non scaricata%'").run(m.id);
      }
      n++;
    } catch (e) {
      segnaMedia(db, m.id, /grande/.test(String((e as Error).message)) ? "troppo_grande" : "errore", ora);
      registra(db, "whatsapp.allegato", "errore", "sistema", { messaggio: m.id, motivo: String((e as Error).message ?? e).slice(0, 120) });
    }
  }
  return n;
}

function allegatoDi(db: Db, messaggioId: string): RiferimentoAllegato | null {
  const r = db.prepare("SELECT id, nome, mime, dimensione, sha256 FROM wa_allegati WHERE messaggio_id = ?").get(messaggioId) as { id: string; nome: string; mime: string; dimensione: number; sha256: string } | undefined;
  return r ? { allegatoId: r.id, nome: r.nome, mime: r.mime, dimensione: r.dimensione, sha256: r.sha256 } : null;
}

// ---------------------------------------------------------------- 3) analisi dei messaggi
export interface EsitoFunzioni { analizzati: number; proposte: number; promesse: number; scontrini: number; domande: number }

interface Contesto { dip: DipendenzeWhatsapp; db: Db; ora: number; imp: Impostazioni; esito: EsitoFunzioni; cantieri: Map<string, Promise<CantiereNoto[]>> }
interface Risultato { stato: "fatta" | "attesa"; cantiere?: CantiereNoto; esito?: Record<string, unknown> }

/** Testo del messaggio (per foto e documenti il testo è già la didascalia: non si ripete). */
const testoDi = (m: MessaggioWa) => { const x = mediaDi(m); return (m.testo || x.didascalia || "").trim(); };

async function cantieriAzienda(k: Contesto, aziendaId: string): Promise<CantiereNoto[]> {
  const a = azienda(k.dip, aziendaId);
  if (!a) return [];
  if (!k.cantieri.has(aziendaId)) k.cantieri.set(aziendaId, oVuoto(cantieriDi(k.db, a, k.ora)));
  return k.cantieri.get(aziendaId)!;
}

function nuova(k: Contesto, n: Parameters<typeof creaProposta>[1]): string | null {
  try {
    const r = creaProposta(k.db, n, k.ora);
    if (r.nuova) k.esito.proposte++;
    return r.proposta.id;
  } catch (e) {
    registra(k.db, "proposta.prepara", "errore", "jarvis", { tipo: n.tipo, motivo: String((e as Error).message).slice(0, 120) });
    return null;
  }
}

/** Cantiere del messaggio: citato nel testo; altrimenti l'ultimo cantiere della chat nelle ultime 24 ore (mai dalla posizione di un operaio). */
async function cantiereDelMessaggio(k: Contesto, c: ContattoWa, testo: string): Promise<{ trovato?: CantiereNoto; candidati: CantiereNoto[] }> {
  const cantieri = await cantieriAzienda(k, c.spazio);
  const citati = cantieriCitati(testo, cantieri);
  if (citati.length === 1) return { trovato: citati[0], candidati: citati };
  if (citati.length > 1) return { candidati: citati };
  const ultimo = k.db.prepare(`SELECT a.cantiere_id FROM wa_analisi a JOIN wa_messaggi m ON m.id = a.messaggio_id
      WHERE m.contatto_id = ? AND a.cantiere_id <> '' AND a.azienda_id = ? AND m.quando > ? ORDER BY m.quando DESC LIMIT 1`).get(c.id, c.spazio, k.ora - 864e5) as { cantiere_id: string } | undefined;
  const daChat = ultimo ? cantieri.find((x) => x.id === ultimo.cantiere_id) : undefined;
  return daChat ? { trovato: daChat, candidati: [daChat] } : { candidati: [] };
}

const notaCantiere = (candidati: CantiereNoto[]) => candidati.length > 1
  ? `Quale cantiere? Ne ho trovati più di uno: ${candidati.slice(0, 5).map((x) => x.nome).join(", ")}.`
  : "Cantiere da scegliere: dal messaggio non si capisce.";

async function analizzaPrivato(k: Contesto, m: MessaggioWa, c: ContattoWa): Promise<Risultato> {
  const t = testoDi(m);
  const nome = nomeContatto(c);
  const base = { aziendaId: PRIVATO, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid } as const;
  if (m.direzione === "eco") {
    promessa(k, m, c, t);
    const a = leggiAppuntamento(t, k.ora, k.dip.fuso);
    if (a) nuova(k, { ...base, tipo: "agenda_privata", chiave: `wa:${m.wamid}:agenda`, titolo: `Appuntamento con ${nome}`, dati: { titolo: `Appuntamento con ${nome}`, data: a.data, ora: a.ora } });
    return { stato: "fatta" };
  }
  const comp = leggiCompleanno(t, k.ora, k.dip.fuso);
  if (comp) {
    const chi = comp.chi ?? (comp.mio ? nome : "");
    nuova(k, { ...base, tipo: "agenda_privata", chiave: `wa:${m.wamid}:compleanno`, titolo: `Compleanno${chi ? ` di ${chi}` : ""}`, dati: { titolo: `Compleanno${chi ? ` di ${chi}` : ""}`, data: comp.data }, note: chi ? [] : ["Di chi è il compleanno? Correggi il titolo."] });
    return { stato: "fatta" };
  }
  const ric = leggiRicordati(t, k.ora, k.dip.fuso);
  if (ric) {
    nuova(k, { ...base, tipo: "agenda_privata", chiave: `wa:${m.wamid}:ricorda`, titolo: ric.cosa, dati: { titolo: ric.cosa, data: ric.data ?? giornoDa(k.ora, 1, k.dip.fuso), ora: ric.ora }, note: ric.data ? [] : ["Giorno non detto: ho messo domani, correggilo se serve."] });
    return { stato: "fatta" };
  }
  const a = leggiAppuntamento(t, k.ora, k.dip.fuso);
  if (a) nuova(k, { ...base, tipo: "agenda_privata", chiave: `wa:${m.wamid}:agenda`, titolo: `Appuntamento con ${nome}`, dati: { titolo: `Appuntamento con ${nome}`, data: a.data, ora: a.ora } });
  return { stato: "fatta" };
}

/** Promessa di Luigi (eco): «ti mando il preventivo domani». Una per messaggio. Le promesse precedenti si chiudono se Luigi manda un documento. */
function promessa(k: Contesto, m: MessaggioWa, c: ContattoWa, t: string): void {
  if (["document", "image"].includes(m.tipo)) {
    k.db.prepare("UPDATE promesse SET stato = 'mantenuta' WHERE contatto_id = ? AND stato = 'aperta' AND creata <= ?").run(c.id, m.quando);
    return;
  }
  const aperte = k.db.prepare("SELECT id, chiave AS cosa FROM promesse WHERE contatto_id = ? AND stato = 'aperta'").all(c.id) as Array<{ id: string; cosa: string }>;
  for (const p of aperte) {
    const parola = normalizza(p.cosa).split(/[^a-z]+/).find((x) => x.length >= 5);
    if (parola && normalizza(t).includes(parola) && /\b(ecco|ti ho (mandato|inviato)|in allegato|allego|come promesso|fatto)\b/.test(normalizza(t))) k.db.prepare("UPDATE promesse SET stato = 'mantenuta' WHERE id = ?").run(p.id);
  }
  const p = leggiPromessa(t, k.ora, k.dip.fuso);
  if (!p) return;
  const scadenza = fineGiorno(p.data, k.dip.fuso);
  const r = k.db.prepare("INSERT OR IGNORE INTO promesse (id, contatto_id, messaggio_id, cosa, chiave, scadenza, stato, creata) VALUES (?,?,?,?,?,?, 'aperta', ?)")
    .run(nuovoId("q"), c.id, m.id, p.testo, p.cosa, scadenza, m.quando);
  if (r.changes) { k.esito.promesse++; registra(k.db, "whatsapp.promessa", "fatto", "jarvis", { contatto: c.id, messaggio: m.id }); }
}

async function analizzaLavoro(k: Contesto, m: MessaggioWa, c: ContattoWa): Promise<Risultato> {
  const { db, dip } = k;
  const t = testoDi(m);
  const x = mediaDi(m);
  const nome = nomeContatto(c);
  const base = { aziendaId: c.spazio, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid } as const;
  // La scelta «operaio» vale solo per l'azienda attuale del contatto (un operaio di un'altra azienda qui non conta).
  const op = operaioDelContatto(db, c.id, c.spazio);
  const operaio = !!op?.operaio_id || eOperaio(db, c.id);

  if (m.direzione === "eco") {
    promessa(k, m, c, t);
    const a = leggiAppuntamento(t, k.ora, dip.fuso);
    if (a) {
      const ct = await cantiereDelMessaggio(k, c, t);
      const titolo = `${a.sopralluogo ? "Sopralluogo" : "Appuntamento"} con ${nome}`;
      nuova(k, { ...base, tipo: "agenda", chiave: `wa:${m.wamid}:agenda`, titolo, dati: { data: a.data, ora: a.ora, titolo, cantiereId: ct.trovato?.id }, nomi: ct.trovato ? { cantiereId: ct.trovato.nome } : {} });
      return { stato: "fatta", cantiere: ct.trovato };
    }
    return { stato: "fatta" };
  }

  // ---- posizione (funzione 9). Mai per gli operai (GDPR): la posizione non si usa e non resta salvata.
  if (m.tipo === "location") {
    if (operaio) { togliPosizioni(db, c.id); return { stato: "fatta", esito: { posizione: "operaio: non usata" } }; }
    // Contatto non ancora chiarito: la posizione non si usa (e non è stata salvata) finché Luigi non dice che non è un operaio.
    if (!nonOperaio(db, c)) {
      if (!op) { chiediOperaio(db, c.id, c.spazio, k.ora); k.esito.domande++; }
      return { stato: "fatta", esito: { posizione: "non usata: contatto non ancora chiarito" } };
    }
    if (typeof x.lat !== "number" || typeof x.lon !== "number") return { stato: "fatta" };
    const vicino = cantierePiuVicino({ lat: x.lat, lon: x.lon }, await cantieriAzienda(k, c.spazio));
    if (vicino && vicino.metri <= RAGGIO_CANTIERE_M) return { stato: "fatta", cantiere: vicino.cantiere, esito: { vicino: vicino.cantiere.nome, metri: Math.round(vicino.metri) } };
    nuova(k, {
      ...base, tipo: "richiesta_lavoro", chiave: `wa:${m.wamid}:sopralluogo`, titolo: `Nuovo sopralluogo? Posizione di ${nome}`,
      dati: { nome, telefono: c.wa_id ? `+${c.wa_id}` : undefined, indirizzo: x.didascalia || `${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`, descrizione: NUOVO_SOPRALLUOGO },
      note: [vicino ? `Il cantiere più vicino è ${vicino.cantiere.nome}, a ${(vicino.metri / 1000).toFixed(1)} km.` : "Nessun cantiere con coordinate in Costructo."],
    });
    return { stato: "fatta", esito: { sopralluogo: true } };
  }

  // ---- documenti (funzioni 14, 15, 16, 17)
  if (m.tipo === "document" || m.tipo === "image") {
    const doc = leggiDocumento(x.nomeFile ?? "", x.didascalia ?? "");
    const all = allegatoDi(db, m.id);
    if (doc?.categoria === "scontrino" || (m.tipo === "image" && eScontrino(x.didascalia ?? ""))) {
      // Funzione 17: solo in Jarvis. Prima Nota esclusa (decisione di Luigi in sospeso): nessuna scrittura in Costructo.
      const r = db.prepare("INSERT OR IGNORE INTO scontrini (id, messaggio_id, contatto_id, spazio, descrizione, allegato_id, creato) VALUES (?,?,?,?,?,?,?)")
        .run(nuovoId("s"), m.id, c.id, c.spazio, testoBreve(x.didascalia || x.nomeFile || "Scontrino", 300), all?.allegatoId ?? "", k.ora);
      if (r.changes) { k.esito.scontrini++; registra(db, "whatsapp.scontrino", "fatto", "jarvis", { messaggio: m.id, contatto: c.id }); }
      return { stato: "fatta" };
    }
    if (doc?.categoria === "rinnovo" && m.tipo === "document") return rinnovo(k, m, c, doc.tipoDocumento ?? "Documento", all);
    if (doc?.categoria === "fornitore" && m.tipo === "document") {
      const a = azienda(dip, c.spazio);
      const omonimi = a ? contropartiPerNome(nome, await oVuoto(contropartiDi(db, a, k.ora))) : [];
      const f = leggiDatiFornitore(`${x.didascalia ?? ""} ${x.nomeFile ?? ""}`, k.ora, dip.fuso);
      const fornitore = omonimi.length === 1 ? String(omonimi[0].nome || omonimi[0].ragioneSociale) : nome;
      nuova(k, {
        ...base, tipo: "documento_fornitore", chiave: `wa:${m.wamid}:documento`, titolo: `${doc.tipo === "preventivo" ? "Preventivo" : "Fattura"} di ${fornitore}${f.numero ? ` n. ${f.numero}` : ""}`,
        dati: { fornitore, tipo: doc.tipo, ...f }, allegati: all && all.mime === "application/pdf" ? [all] : [],
        note: [...(all ? [] : ["PDF non scaricato (scaricamento spento o non riuscito)."]), "Costructo controlla i doppioni con lo SDI."],
      });
      return { stato: "fatta" };
    }
    if (doc?.categoria === "ddt") return carico(k, m, c, t, all);
    if (m.tipo === "image") return foto(k, m, c, t, all, operaio);
    return { stato: "fatta" };
  }

  // ---- testo (e vocali trascritti)
  if (!t) return { stato: "fatta" };
  const ore = leggiOre(t, k.ora, dip.fuso);
  if (ore.length) {
    // Funzione 19. Le ore si propongono solo per i contatti che Luigi ha detto essere operai DI QUESTA azienda.
    if (!op) { chiediOperaio(db, c.id, c.spazio, k.ora); k.esito.domande++; return { stato: "attesa" }; }
    if (op.operaio_id) {
      let ultimo: Risultato = { stato: "fatta" };
      const futuri: string[] = [];
      for (const [n, o] of ore.entries()) {
        if (o.futuro) { futuri.push(`${String(o.ore).replace(".", ",")} ore il ${dataBreve(o.data!)}`); continue; }
        ultimo = await oreProposta(k, m, c, op.operaio_id, op.nome, o, ore.length > 1 ? n + 1 : 0);
      }
      if (futuri.length) {
        registra(db, "proposta.prepara", "negato", "jarvis", { tipo: "ore", motivo: "ore di un giorno futuro", messaggio: m.id });
        return { ...ultimo, esito: { ...(ultimo.esito ?? {}), futuro: `Ore di un giorno che non è ancora arrivato: non proposte (${futuri.join(", ")}).` } };
      }
      return ultimo;
    }
  }
  if (/\b(consegn\w*|arrivat\w*|scaricat\w*|ddt|bolla)\b/i.test(t) && leggiRighe(t).length) return carico(k, m, c, t, null);
  if (!operaio && richiestaLavoro(t)) {
    // Funzione 12: nome, indirizzo e sopralluogo con l'AI (solo se serve), sempre controllati. Nessun prezzo, nessuna risposta automatica.
    const Schema = z.object({ nome: testoAi(140), indirizzo: testoAi(300), descrizione: testoAi(1000), sopralluogoData: testoAi(10), sopralluogoOra: testoAi(5) });
    const ai = await estraiConAi(dip, "richiesta di lavoro", { nome: "nome di chi scrive, se lo dice", indirizzo: "indirizzo del lavoro", descrizione: "che lavoro chiede, in una frase", sopralluogoData: "data del sopralluogo chiesto AAAA-MM-GG", sopralluogoOra: "ora HH:MM" }, t, Schema);
    const sopralluogo = ai?.sopralluogoData && /^\d{4}-\d{2}-\d{2}$/.test(ai.sopralluogoData) && ai.sopralluogoOra && /^([01]\d|2[0-3]):[0-5]\d$/.test(ai.sopralluogoOra) ? { data: ai.sopralluogoData, ora: ai.sopralluogoOra } : undefined;
    nuova(k, {
      ...base, tipo: "richiesta_lavoro", chiave: `wa:${m.wamid}:richiesta`, titolo: `Nuova richiesta di lavoro da ${ai?.nome ?? nome}`,
      dati: { nome: ai?.nome ?? nome, telefono: c.wa_id ? `+${c.wa_id}` : undefined, indirizzo: ai?.indirizzo, descrizione: ai?.descrizione ?? t.slice(0, 2000), sopralluogo },
      note: ["Jarvis non ha risposto e non risponde con prezzi o impegni."],
    });
    return { stato: "fatta" };
  }
  const a = leggiAppuntamento(t, k.ora, dip.fuso);
  if (a) {
    const ct = await cantiereDelMessaggio(k, c, t);
    const titolo = `${a.sopralluogo ? "Sopralluogo" : "Appuntamento"} con ${nome}`;
    nuova(k, { ...base, tipo: "agenda", chiave: `wa:${m.wamid}:agenda`, titolo, dati: { data: a.data, ora: a.ora, titolo, cantiereId: ct.trovato?.id }, nomi: ct.trovato ? { cantiereId: ct.trovato.nome } : {} });
    return { stato: "fatta", cantiere: ct.trovato };
  }
  // Nessuna proposta: si ricorda solo il cantiere citato (per il riassunto della sera e il diario).
  const citati = cantieriCitati(t, await cantieriAzienda(k, c.spazio));
  return { stato: "fatta", ...(citati.length === 1 ? { cantiere: citati[0] } : {}) };
}

async function oreProposta(k: Contesto, m: MessaggioWa, c: ContattoWa, operaioId: string, nomeOperaio: string, ore: OreLette, voce = 0): Promise<Risultato> {
  const { db, dip } = k;
  const data = ore.data ?? giornoDa(k.ora, 0, dip.fuso);
  const cantieri = await cantieriAzienda(k, c.spazio);
  const citati = cantieriCitati(ore.cantiere ?? ore.testo, cantieri);
  const cantiere = citati.length === 1 ? citati[0] : undefined;
  // Prima si guarda in Costructo (/v1/ore → verifica.esiste): se il rapportino c'è già, niente proposta.
  const a = azienda(dip, c.spazio);
  if (a) {
    try {
      if ((await a.client.oreVerifica({ operaioId, data, ...(cantiere ? { cantiereId: cantiere.id } : {}) })).esiste) {
        registra(db, "proposta.prepara", "negato", "jarvis", { tipo: "ore", motivo: "rapportino già presente in Costructo", messaggio: m.id });
        return { stato: "fatta", cantiere, esito: { ore: "già presente in Costructo" } };
      }
    } catch { /* lettura non disponibile: Costructo controllerà i doppioni (409) */ }
  }
  nuova(k, {
    aziendaId: c.spazio, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid, tipo: "ore", chiave: `wa:${m.wamid}:ore${voce ? `:${voce}` : ""}`,
    titolo: `Ore di ${nomeOperaio}: ${String(ore.ore).replace(".", ",")} il ${dataBreve(data)}${cantiere ? ` (${cantiere.nome})` : ""}`,
    dati: { operaioId, cantiereId: cantiere?.id, data, ore: ore.ore, oreEconomia: ore.oreEconomia, descrizione: "Ore mandate su WhatsApp" },
    nomi: { operaioId: nomeOperaio, ...(cantiere ? { cantiereId: cantiere.nome } : {}) },
    note: [...(cantiere ? [] : [notaCantiere(citati)]), ...(ore.data ? [] : ["Giorno non detto: ho messo oggi."])],
  });
  return { stato: "fatta", cantiere };
}

async function foto(k: Contesto, m: MessaggioWa, c: ContattoWa, t: string, all: RiferimentoAllegato | null, operaio: boolean): Promise<Risultato> {
  const { db, dip } = k;
  if (!all) return { stato: "fatta", esito: { foto: "non scaricata (scaricamento spento)" } };
  let ct = await cantiereDelMessaggio(k, c, t);
  if (!ct.trovato && !operaio) {
    // Funzione 13: per i contatti che NON sono operai si può usare una posizione mandata nell'ultima ora.
    const pos = db.prepare("SELECT media FROM wa_messaggi WHERE contatto_id = ? AND tipo = 'location' AND quando > ? ORDER BY quando DESC LIMIT 1").get(c.id, m.quando - 3600_000) as { media: string } | undefined;
    if (pos) {
      const p = mediaDi(pos);
      if (typeof p.lat === "number" && typeof p.lon === "number") {
        const v = cantierePiuVicino({ lat: p.lat, lon: p.lon }, await cantieriAzienda(k, c.spazio));
        if (v && v.metri <= RAGGIO_CANTIERE_M) ct = { trovato: v.cantiere, candidati: [v.cantiere] };
      }
    }
  }
  // Foto vicine dello stesso contatto: una sola proposta (al massimo 5 foto).
  const aperta = db.prepare(`SELECT p.id FROM proposte p JOIN wa_messaggi w ON w.id = p.messaggio_id WHERE p.tipo = 'foto' AND p.contatto_id = ? AND p.stato = 'da_confermare'
      AND w.quando >= ? ORDER BY w.quando DESC LIMIT 1`).get(c.id, m.quando - FOTO_INSIEME_MS) as { id: string } | undefined;
  if (aperta) {
    const p = leggiProposta(db, aperta.id)!;
    const lista = allegatiDi(p);
    if (lista.length < MAX_ALLEGATI && !lista.some((a) => a.allegatoId === all.allegatoId)) {
      lista.push(all);
      const dati = datiDi(p);
      if (!dati.cantiereId && ct.trovato) dati.cantiereId = ct.trovato.id;
      if (t && !dati.descrizione) dati.descrizione = t.slice(0, 500);
      if (tipoFoto(t) === "problema") dati.tipo = "problema";
      const extra = extraDi(p);
      if (ct.trovato) extra.nomi.cantiereId = ct.trovato.nome;
      db.prepare("UPDATE proposte SET allegati = ?, dati = ?, avvisi = ?, aggiornata = ? WHERE id = ?").run(JSON.stringify(lista), JSON.stringify(dati), JSON.stringify(extra), k.ora, p.id);
      return { stato: "fatta", cantiere: ct.trovato };
    }
  }
  const tipo = tipoFoto(t);
  nuova(k, {
    aziendaId: c.spazio, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid, tipo: "foto", chiave: `wa:${m.wamid}:foto`,
    titolo: `Foto ${tipo === "problema" ? "di un problema" : "di cantiere"}${ct.trovato ? ` · ${ct.trovato.nome}` : ""} (da ${nomeContatto(c)})`,
    dati: { cantiereId: ct.trovato?.id, data: dataIso(m.quando, dip.fuso), tipo, descrizione: t ? t.slice(0, 500) : undefined },
    allegati: [all], nomi: ct.trovato ? { cantiereId: ct.trovato.nome } : {}, note: ct.trovato ? [] : [notaCantiere(ct.candidati)],
  });
  return { stato: "fatta", cantiere: ct.trovato };
}

async function rinnovo(k: Contesto, m: MessaggioWa, c: ContattoWa, tipoDocumento: string, all: RiferimentoAllegato | null): Promise<Risultato> {
  const { db, dip } = k;
  const x = mediaDi(m);
  const nome = nomeContatto(c);
  const a = azienda(dip, c.spazio);
  const voci = a ? await oVuoto(documentiDi(db, a, k.ora)) : [];
  const parolaTipo = normalizza(tipoDocumento).split(/[^a-z]+/)[0];
  // Funzione 15: si cerca la voce del SUBAPPALTATORE: tutte le parole del nome di chi scrive, a parole intere, nella ditta;
  // mai i documenti dell'azienda stessa. Nessuna o più voci: la voce resta vuota e si chiede a Luigi.
  const nomeAzienda = dip.aziende().find((x) => x.id === c.spazio)?.nome ?? "";
  const trovate = voci.filter((v) => {
    const tipo = ` ${normalizza(`${v.tipoDocumento ?? ""} ${v.tipo ?? ""} ${v.titolo ?? ""} ${v.nome ?? ""}`).replace(/[^a-z0-9]+/g, " ")} `;
    const ditta = `${v.ditta ?? ""} ${v.intestatario ?? ""}`;
    return tipo.includes(` ${parolaTipo} `) && !documentoDellAzienda(v, nomeAzienda) && tutteLeParole(nome, ditta);
  });
  const voce = trovate.length === 1 ? trovate[0] : undefined;
  const scadenza = leggiScadenza(`${x.didascalia ?? ""} ${x.nomeFile ?? ""}`, k.ora, dip.fuso);
  nuova(k, {
    aziendaId: c.spazio, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid, tipo: "rinnovo_documento", chiave: `wa:${m.wamid}:rinnovo`,
    titolo: `${tipoDocumento} di ${voce?.ditta || voce?.intestatario || nome}`,
    dati: { voceId: voce?.id, ditta: voce ? undefined : nome, tipoDocumento, dataScadenza: scadenza ?? undefined },
    allegati: all && all.mime === "application/pdf" ? [all] : [],
    nomi: voce ? { voceId: String(voce.titolo || voce.nome || voce.tipoDocumento || voce.id) } : {},
    note: [...(voce ? [] : [trovate.length > 1
      ? `Di quale voce si tratta? In Costructo ne corrispondono ${trovate.length}: scegli tu in Costructo.`
      : "Di quale voce si tratta? In Costructo non ne ho trovata una sola della ditta: indico solo il nome della ditta."]),
      ...(scadenza ? [] : ["Scadenza non scritta nel messaggio: inseriscila tu (Jarvis non legge il PDF)."]), ...(all ? [] : ["PDF non scaricato (scaricamento spento o non riuscito)."])],
  });
  return { stato: "fatta" };
}

async function carico(k: Contesto, m: MessaggioWa, c: ContattoWa, t: string, all: RiferimentoAllegato | null): Promise<Risultato> {
  const { db, dip } = k;
  const righe = leggiRighe(t);
  const ct = await cantiereDelMessaggio(k, c, t);
  const a = azienda(dip, c.spazio);
  const inventario = a ? await oVuoto(a.client.inventarioLista()) : [];
  const note: string[] = [];
  const righeFinali = righe.map((r) => {
    const n = normalizza(r.descrizione);
    const oggetto = inventario.find((o) => normalizza(String(o.descrizione || o.nome || "")) === n);
    if (!oggetto && inventario.length) note.push(`«${r.descrizione}» non è in magazzino: nuovo articolo?`);
    return { ...r, ...(oggetto?.id ? { oggettoId: String(oggetto.id) } : {}) };
  });
  // Differenze: solo segnalate (mai corrette) rispetto a un'altra consegna dello stesso contatto nello stesso giorno.
  const giorno = dataIso(m.quando, dip.fuso);
  const altre = db.prepare("SELECT dati FROM proposte WHERE tipo = 'carico_magazzino' AND contatto_id = ? AND messaggio_id <> ? AND creata > ?").all(c.id, m.id, k.ora - 864e5) as Array<{ dati: string }>;
  for (const altra of altre) {
    const prima = (datiDi({ dati: altra.dati }).righe as Array<{ descrizione: string; quantita: number; unita: string }> | undefined) ?? [];
    for (const r of righeFinali) {
      const p = prima.find((x) => normalizza(x.descrizione) === normalizza(r.descrizione) && x.unita === r.unita);
      if (p && p.quantita !== r.quantita) note.push(`Differenza da controllare: «${r.descrizione}» ${p.quantita} ${p.unita} in un altro messaggio, qui ${r.quantita}.`);
    }
  }
  if (!righeFinali.length) note.push("Righe da scrivere: nel messaggio non ci sono quantità chiare (Jarvis non legge il PDF).");
  nuova(k, {
    aziendaId: c.spazio, contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid, tipo: "carico_magazzino", chiave: `wa:${m.wamid}:carico`,
    titolo: `Consegna da ${nomeContatto(c)} del ${dataBreve(giorno)}${ct.trovato ? ` · ${ct.trovato.nome}` : ""}`,
    dati: { fornitore: nomeContatto(c), cantiereId: ct.trovato?.id, righe: righeFinali.length ? righeFinali : undefined }, allegati: all ? [all] : [],
    nomi: ct.trovato ? { cantiereId: ct.trovato.nome } : {}, note: ["Quantità solo proposte: le controlli tu.", ...note],
  });
  return { stato: "fatta", cantiere: ct.trovato };
}

/** Analizza i messaggi nuovi (una volta sola ciascuno). */
export async function giroFunzioni(dip: DipendenzeWhatsapp, limite = MAX_PER_GIRO): Promise<EsitoFunzioni> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const imp = leggiImpostazioni(db);
  const esito: EsitoFunzioni = { analizzati: 0, proposte: 0, promesse: 0, scontrini: 0, domande: 0 };
  // I vocali aspettano la trascrizione; foto e PDF aspettano lo scaricamento (se acceso). I contatti «da assegnare» aspettano Luigi.
  const lista = db.prepare(`SELECT m.* FROM wa_messaggi m JOIN wa_contatti c ON c.id = m.contatto_id
      WHERE m.direzione IN ('in','eco') AND m.storico = 0 AND m.gruppo_id = '' AND c.gruppo = 0 AND c.spazio <> '' AND m.revocato = 0
      AND m.quando > ? AND m.id NOT IN (SELECT messaggio_id FROM wa_analisi)
      AND NOT (m.tipo = 'audio' AND m.direzione = 'in' AND m.id NOT IN (SELECT messaggio_id FROM wa_media_stato))
      AND NOT (? = 1 AND m.tipo IN ('image','document') AND m.direzione = 'in' AND c.spazio <> ? AND m.id NOT IN (SELECT messaggio_id FROM wa_media_stato))
      ORDER BY m.contatto_id, m.quando LIMIT ?`).all(ora - ETA_MASSIMA_ANALISI, imp.whatsappScaricaAllegati ? 1 : 0, PRIVATO, limite) as MessaggioWa[];
  if (!lista.length) return esito;
  const k: Contesto = { dip, db, ora, imp, esito, cantieri: new Map() };
  const salva = db.prepare("INSERT OR REPLACE INTO wa_analisi (messaggio_id, stato, azienda_id, cantiere_id, cantiere_nome, esito, quando) VALUES (?,?,?,?,?,?,?)");
  for (const m of lista) {
    const c = leggiContatto(db, m.contatto_id);
    if (!c) continue;
    let r: Risultato;
    try {
      if (c.spazio === PRIVATO) r = escluso(imp, c) ? { stato: "fatta", esito: { escluso: true } } : await analizzaPrivato(k, m, c);
      else r = await analizzaLavoro(k, m, c);
    } catch (e) {
      registra(db, "funzioni.analisi", "errore", "sistema", { messaggio: m.id, motivo: String((e as Error).message ?? e).slice(0, 120) });
      r = { stato: "fatta", esito: { errore: true } };
    }
    salva.run(m.id, r.stato, c.spazio, r.cantiere?.id ?? "", r.cantiere?.nome ?? "", JSON.stringify(r.esito ?? {}), ora);
    esito.analizzati++;
  }
  if (esito.proposte || esito.promesse || esito.scontrini || esito.domande) registra(db, "funzioni.analisi", "fatto", "sistema", { ...esito });
  return esito;
}

/**
 * «Proponi in Costructo» dalla pagina WhatsApp: rifà l'analisi di UN messaggio per il tipo scelto da Luigi.
 * Per il privato solo «agenda_privata». Restituisce l'id della proposta (nuova o già esistente).
 */
export async function proponiDaMessaggio(dip: DipendenzeWhatsapp, messaggioId: string, tipo: TipoProposta): Promise<string> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const m = db.prepare("SELECT * FROM wa_messaggi WHERE id = ?").get(messaggioId) as MessaggioWa | undefined;
  if (!m) throw new Error("Messaggio non trovato (forse più vecchio di 30 giorni).");
  const c = leggiContatto(db, m.contatto_id);
  if (!c || c.gruppo) throw new Error("Dai gruppi Jarvis non prepara proposte.");
  if (!c.spazio) throw new Error("Prima dimmi di quale azienda è questo contatto.");
  const imp = leggiImpostazioni(db);
  const k: Contesto = { dip, db, ora, imp, esito: { analizzati: 0, proposte: 0, promesse: 0, scontrini: 0, domande: 0 }, cantieri: new Map() };
  const t = testoDi(m);
  const x = mediaDi(m);
  const nome = nomeContatto(c);
  const base = { contattoId: c.id, messaggioId: m.id, rifEsterno: m.wamid, chiave: `wa:${m.wamid}:${tipo}` };
  const crea = (n: Omit<Parameters<typeof creaProposta>[1], "contattoId" | "messaggioId" | "rifEsterno" | "chiave">) => {
    const r = creaProposta(db, { ...base, ...n }, ora);
    return r.proposta.id;
  };
  if (c.spazio === PRIVATO) {
    if (tipo !== "agenda_privata") throw new Error("Le chat private non vanno in Costructo: posso solo segnarlo nell'agenda privata di Jarvis.");
    const a = leggiAppuntamento(t, ora, dip.fuso) ?? (() => { const r = leggiRicordati(t, ora, dip.fuso); return r?.data ? { data: r.data, ora: r.ora } : null; })();
    return crea({ tipo, aziendaId: PRIVATO, titolo: `Da WhatsApp: ${nome}`, dati: { titolo: `${nome}: ${t.slice(0, 100) || "promemoria"}`, data: a?.data ?? giornoDa(ora, 1, dip.fuso), ora: a?.ora }, note: a ? [] : ["Controlla il giorno."] });
  }
  if (tipo === "agenda_privata") throw new Error("Questo contatto è di un'azienda: usa un appuntamento in agenda di Costructo.");
  const op = operaioDelContatto(db, c.id, c.spazio);
  const ct = await cantiereDelMessaggio(k, c, t);
  const nomiCantiere: Record<string, string> = ct.trovato ? { cantiereId: ct.trovato.nome } : {};
  const all = allegatoDi(db, m.id);
  switch (tipo) {
    case "ore": {
      if (!op?.operaio_id) throw new Error("Prima dimmi quale operaio è questo contatto (per questa azienda).");
      const o = leggiOre(t, ora, dip.fuso).find((x) => !x.futuro);
      return crea({ tipo, aziendaId: c.spazio, titolo: `Ore di ${op.nome}`, dati: { operaioId: op.operaio_id, cantiereId: ct.trovato?.id, data: o?.data ?? giornoDa(ora, 0, dip.fuso), ore: o?.ore, oreEconomia: o?.oreEconomia }, nomi: { operaioId: op.nome, ...nomiCantiere }, note: o ? [] : ["Ore da scrivere."] });
    }
    case "foto":
      if (!all) throw new Error("La foto non è scaricata: accendi «Scarica foto e PDF» in Impostazioni.");
      return crea({ tipo, aziendaId: c.spazio, titolo: `Foto da ${nome}`, dati: { cantiereId: ct.trovato?.id, data: dataIso(m.quando, dip.fuso), tipo: tipoFoto(t), descrizione: t || undefined }, allegati: [all], nomi: nomiCantiere });
    case "documento_fornitore": {
      const f = leggiDatiFornitore(`${x.didascalia ?? ""} ${x.nomeFile ?? ""}`, ora, dip.fuso);
      const d = leggiDocumento(x.nomeFile ?? "", x.didascalia ?? "");
      return crea({ tipo, aziendaId: c.spazio, titolo: `Documento di ${nome}`, dati: { fornitore: nome, tipo: d?.tipo ?? "fattura", ...f }, allegati: all?.mime === "application/pdf" ? [all] : [] });
    }
    case "rinnovo_documento":
      await rinnovo(k, m, c, leggiDocumento(x.nomeFile ?? "", x.didascalia ?? "")?.tipoDocumento ?? "Documento", all);
      return (db.prepare("SELECT id FROM proposte WHERE chiave_doppione = ?").get(`wa:${m.wamid}:rinnovo`) as { id: string }).id;
    case "carico_magazzino": {
      await carico(k, m, c, t, all);
      return (db.prepare("SELECT id FROM proposte WHERE chiave_doppione = ?").get(`wa:${m.wamid}:carico`) as { id: string }).id;
    }
    case "richiesta_lavoro":
      return crea({ tipo, aziendaId: c.spazio, titolo: `Richiesta di lavoro da ${nome}`, dati: { nome, telefono: c.wa_id ? `+${c.wa_id}` : undefined, descrizione: t || "Da completare" } });
    case "agenda": {
      const a = leggiAppuntamento(t, ora, dip.fuso);
      return crea({ tipo, aziendaId: c.spazio, titolo: `Appuntamento con ${nome}`, dati: { data: a?.data, ora: a?.ora, titolo: `Appuntamento con ${nome}`, descrizione: t.slice(0, 1000) || undefined, cantiereId: ct.trovato?.id }, nomi: nomiCantiere, note: a ? [] : ["Giorno da scegliere."] });
    }
    case "diario":
      return crea({ tipo, aziendaId: c.spazio, titolo: `Diario: nota di ${nome}`, dati: { cantiereId: ct.trovato?.id, data: dataIso(m.quando, dip.fuso), testo: `${nome}: ${t}`.slice(0, 4000) }, nomi: nomiCantiere });
    default:
      throw new Error("Da un messaggio non posso preparare questo tipo di proposta.");
  }
}
