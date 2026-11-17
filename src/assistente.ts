// Il cuore di Jarvis: riceve una frase di Luigi e produce la risposta in streaming.
// Ordine: conferme in attesa → calcolatrice (senza AI) → tetto di spesa → cervello con strumenti.
import type { Db } from "./db.js";
import type { Cervello, MessaggioCervello } from "./cervello/tipi.js";
import { CervelloNonDisponibile } from "./cervello/tipi.js";
import type { ClientCostructo } from "./costructo.js";
import { provaConto, diciNumero } from "./calcolo.js";
import { apriConversazione, aggiungiMessaggio, ultimiMessaggi } from "./conversazioni.js";
import { leggiImpostazioni } from "./impostazioni.js";
import { riepilogoMese, registraConsumo } from "./consumi.js";
import { registra } from "./registro.js";
import { elencaMemorie, type Vista } from "./memorie.js";
import { impegniProssimiGiorni, descriviImpegno } from "./agenda.js";
import { marcaDati } from "./dati.js";
import { promptDiSistema } from "./prompt.js";
import { descriviAdesso } from "./tempo.js";
import { eseguiStrumento, strumentiPerVista, confermaInAttesa, rispondiConferma, type EventoFlusso } from "./strumenti.js";

export interface Dipendenze {
  db: Db;
  fuso: string;
  modelloPredefinito: string;
  modelloApprofondito: string;
  cervello: () => Promise<Cervello>;
  costructo: () => ClientCostructo | null;
  linkCalendario: () => string;
  fetchFn?: typeof fetch;
}

export interface Domanda { messaggio: string; vista: Vista; conversazione?: string }

const MAX_PASSI = 5;
const APPROFONDISCI = /\b(pensaci bene|ragionaci bene|pensaci con calma|ragiona bene|analizza bene)\b/i;
const SI = /^(s[iì]|ok|okay|va bene|confermo|conferma|procedi|esatto|certo|vai)\b[\s.!,]*$/i;
const NO = /^(no|annulla|lascia stare|lascia perdere|niente|non farlo)\b[\s.!,]*$/i;
const ORDINALI: Array<[RegExp, number]> = [[/\b(primo|prima|1)\b/i, 0], [/\b(secondo|seconda|2)\b/i, 1], [/\b(terzo|terza|3)\b/i, 2], [/\b(quarto|quarta|4)\b/i, 3], [/\b(quinto|quinta|5)\b/i, 4]];

export async function rispondi(dip: Dipendenze, d: Domanda, emetti: (e: EventoFlusso) => void, segnale?: AbortSignal): Promise<void> {
  const { db, fuso } = dip;
  const imp = leggiImpostazioni(db);
  const s = imp.comeChiamarmi;
  const messaggio = d.messaggio.replace(/\s+/g, " ").trim().slice(0, 2000);
  const conv = apriConversazione(db, d.vista, d.conversazione);
  const storia = ultimiMessaggi(db, conv, 12);
  aggiungiMessaggio(db, conv, "utente", messaggio);
  let detto = "";
  let costo = 0;
  const di = (t: string) => { detto += t; emetti({ tipo: "delta", testo: t }); };
  const chiudi = () => {
    if (detto.trim()) aggiungiMessaggio(db, conv, "jarvis", detto.trim());
    emetti({ tipo: "fine", conversazione: conv, costoUsd: costo });
  };

  // 1) Risposta a una conferma in attesa («sì», «annulla», «il secondo»): senza AI.
  const attesa = confermaInAttesa(db, conv);
  if (attesa && (SI.test(messaggio) || NO.test(messaggio) || ORDINALI.some(([re]) => re.test(messaggio) && messaggio.split(" ").length <= 4))) {
    const scelta = NO.test(messaggio) ? "annulla" : (ORDINALI.find(([re]) => re.test(messaggio))?.[1] ?? "conferma");
    const r = rispondiConferma(db, attesa.id, scelta, fuso);
    if (r.ok) emetti({ tipo: "agenda" });
    di(r.messaggio);
    return chiudi();
  }

  // 2) Calcolatrice istantanea: nessuna AI, costo zero.
  const conto = provaConto(messaggio);
  if (conto !== null) {
    emetti({ tipo: "modello", modello: "calcolatrice" });
    emetti({ tipo: "numero", etichetta: "RISULTATO", valore: conto, suffisso: "" });
    di(`Fa ${diciNumero(conto)}, ${s}.`);
    return chiudi();
  }

  // 3) Tetto di spesa: al limite Jarvis si ferma e avvisa. Il cervello NON viene chiamato.
  const spesa = riepilogoMese(db, imp.tettoMensileUsd, fuso);
  if (spesa.raggiunto) {
    registra(db, "ai.chiamata", "negato", "sistema", { motivo: "tetto di spesa raggiunto", spesaUsd: spesa.spesaUsd, tettoUsd: spesa.tettoUsd });
    emetti({ tipo: "avviso", testo: "Tetto di spesa del mese raggiunto." });
    di(`${s}, ho raggiunto il tetto di spesa del mese per l'intelligenza artificiale. Mi fermo qui: puoi alzarlo nelle impostazioni. Calcoli, agenda e briefing funzionano lo stesso.`);
    return chiudi();
  }

  // 4) Cervello.
  const approfondito = APPROFONDISCI.test(messaggio);
  const modello = approfondito ? dip.modelloApprofondito : dip.modelloPredefinito;
  let cervello: Cervello;
  try {
    cervello = await dip.cervello();
  } catch (e) {
    const testo = e instanceof CervelloNonDisponibile ? e.message : "Il cervello non è disponibile.";
    registra(db, "ai.chiamata", "errore", "sistema", { motivo: testo });
    di(`${s}, in questo momento non posso ragionare: ${testo}`);
    return chiudi();
  }
  emetti({ tipo: "modello", modello });

  const costructo = dip.costructo();
  const messaggi: MessaggioCervello[] = storia.map((m) => (m.ruolo === "utente" ? { ruolo: "utente", testo: m.testo } : { ruolo: "jarvis", testo: m.testo, chiamate: [] }));
  messaggi.push({ ruolo: "utente", testo: contestoDelTurno(dip, d.vista, costructo) + `\n\nMessaggio di Luigi:\n${messaggio}` });
  const strumenti = strumentiPerVista(d.vista);

  try {
    for (let passo = 0; passo < MAX_PASSI; passo++) {
      if (passo > 0 && riepilogoMese(db, imp.tettoMensileUsd, fuso).raggiunto) {
        di(` Mi fermo: ho raggiunto il tetto di spesa del mese.`);
        break;
      }
      const r = await cervello.passo(
        { modello, sistema: promptDiSistema(s), messaggi, strumenti, maxToken: approfondito ? 4096 : 1024, sforzo: approfondito ? "medium" : "low", segnale },
        (pezzo) => di(detto ? pezzo : pezzo.replace(/^\s+/, "")),
      );
      costo += registraConsumo(db, modello, r.uso, fuso);
      if (r.fine === "rifiuto") {
        registra(db, "ai.chiamata", "negato", "sistema", { motivo: "rifiuto del modello" });
        di(`Su questo non posso aiutarti, ${s}.`);
        break;
      }
      messaggi.push({ ruolo: "jarvis", testo: r.testo, chiamate: r.chiamate, grezzo: r.grezzo });
      if (r.fine === "limite") { di("…"); break; }
      if (!r.chiamate.length) break;
      const risultati = [];
      for (const ch of r.chiamate) {
        const esito = await eseguiStrumento(ch.nome, ch.input, {
          db, fuso, vista: d.vista, messaggioLuigi: messaggio, conversazione: conv, costructo,
          linkCalendario: dip.linkCalendario, emetti, fetchFn: dip.fetchFn,
        });
        risultati.push({ id: ch.id, contenuto: esito.contenuto, errore: esito.errore });
      }
      messaggi.push({ ruolo: "risultati", risultati });
      if (passo === MAX_PASSI - 1) di(" Mi fermo qui per non girare a vuoto.");
    }
  } catch (e) {
    if (segnale?.aborted) return chiudi();
    const testo = e instanceof CervelloNonDisponibile ? e.message : "la connessione con il cervello si è interrotta.";
    registra(db, "ai.chiamata", "errore", "sistema", { motivo: testo });
    di(`${detto ? " " : ""}${s}, ${testo} Riprova tra un istante.`);
  }
  const dopo = riepilogoMese(db, imp.tettoMensileUsd, fuso);
  if (!spesa.quasi && dopo.quasi && !dopo.raggiunto) emetti({ tipo: "avviso", testo: "Hai usato l'80% del tetto di spesa del mese." });
  return chiudi();
}

/** Contesto che cambia a ogni turno: data, agenda locale, ricordi. Tutto marcato come dati. */
function contestoDelTurno(dip: Dipendenze, vista: Vista, costructo: ClientCostructo | null): string {
  const ora = Date.now();
  const parti = [
    `Adesso è ${descriviAdesso(ora, dip.fuso)} (fuso ${dip.fuso}). Scheda aperta: ${vista.toUpperCase()}.`,
    `Costructo: ${costructo?.configurato && vista !== "privato" ? "collegato (sola lettura, usa gli strumenti)" : "non disponibile in questa scheda"}.`,
    "Ricordi:",
    marcaDati("memoria", elencaMemorie(dip.db, vista).slice(0, 60).map((m) => `[${m.spazio}] ${m.testo}`)),
  ];
  if (vista !== "lavoro") {
    parti.push("Agenda privata di Jarvis, prossimi 7 giorni:", marcaDati("agenda_jarvis", impegniProssimiGiorni(dip.db, 7, dip.fuso).slice(0, 40).map((i) => descriviImpegno(i, dip.fuso))));
  }
  return parti.join("\n");
}
