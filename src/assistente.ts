// Il cuore di Jarvis: riceve una frase di Luigi e produce la risposta in streaming.
// Ordine: risposta a una conferma appena chiesta → calcolatrice (senza AI) → tetto di spesa → cervello con strumenti.
import type { Db } from "./db.js";
import type { Cervello, MessaggioCervello, RichiestaPasso, RispostaPasso, UsoToken } from "./cervello/tipi.js";
import { CervelloNonDisponibile, PassoInterrotto } from "./cervello/tipi.js";
import type { ClientCostructo } from "./costructo.js";
import { provaConto, diciNumero } from "./calcolo.js";
import { apriConversazione, aggiungiMessaggio, ultimiMessaggi } from "./conversazioni.js";
import { leggiImpostazioni } from "./impostazioni.js";
import { riepilogoMese, registraConsumo, costoUsd, stimaToken } from "./consumi.js";
import { registra } from "./registro.js";
import { elencaMemorie, type Vista } from "./memorie.js";
import { impegniProssimiGiorni, descriviImpegno } from "./agenda.js";
import { marcaDati } from "./dati.js";
import { promptDiSistema } from "./prompt.js";
import { descriviAdesso } from "./tempo.js";
import { eseguiStrumento, strumentiPerVista, confermeAperte, rispondiConferma, type EventoFlusso, type ConfermaAperta } from "./strumenti.js";

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
/** Token massimi per risposta: Haiku ragiona in modo adattivo e con 1024 rischiava di troncare. */
const MAX_TOKEN = { normale: 4096, approfondito: 8192 };
const APPROFONDISCI = /\b(pensaci bene|ragionaci bene|pensaci con calma|ragiona bene|analizza bene)\b/i;

// ---------------------------------------------------------------- risposte a una conferma
// Una conferma si dà con il pulsante (id della conferma nella richiesta) oppure con una risposta
// ESPLICITA, che occupa tutto il messaggio, alla domanda appena fatta. Nel dubbio si richiede.
const SI = /^(s[iì][,\s]+)?(s[iì]|ok|okay|va bene|confermo|conferma|procedi|esatto|certo)([,\s]+(conferma|confermo|procedi|grazie))?[\s.!,]*$/i;
const NO = /^(no|annulla|lascia stare|lascia perdere|niente|non farlo)([,\s]+grazie)?[\s.!,]*$/i;
const ORDINALI: Record<string, number> = {
  primo: 0, prima: 0, "1": 0, secondo: 1, seconda: 1, "2": 1, terzo: 2, terza: 2, "3": 2, quarto: 3, quarta: 3, "4": 3, quinto: 4, quinta: 4, "5": 4,
};
const SCELTA = /^(?:s[iì][,\s]+)?(?:(?:cancella|elimina|togli|rimuovi)\s+)?(?:il\s+|la\s+|lo\s+|l')?(?:numero\s+)?(primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|[1-5])(?:\s+(?:impegno|appuntamento|evento))?(?:\s+(?:della lista|dell'elenco|in lista|in elenco))?[\s.!,]*$/i;
const PAROLE_DI_CONFERMA = /\b(s[iì]|ok|okay|conferma|confermo|procedi|vai|annulla|primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|[1-5])\b/i;

type RispostaConferma = { tipo: "si" } | { tipo: "no" } | { tipo: "scelta"; indice: number } | { tipo: "dubbio" };

/** Interpreta un messaggio come risposta a una conferma. null = non è una risposta: si prosegue normalmente. */
export function leggiRispostaConferma(messaggio: string): RispostaConferma | null {
  const m = messaggio.trim();
  if (NO.test(m)) return { tipo: "no" };
  if (SI.test(m)) return { tipo: "si" };
  const scelta = SCELTA.exec(m);
  if (scelta) return { tipo: "scelta", indice: ORDINALI[scelta[1].toLowerCase()] };
  if (m.split(/\s+/).length <= 5 && PAROLE_DI_CONFERMA.test(m)) return { tipo: "dubbio" };
  return null;
}

function gestisciConferma(dip: Dipendenze, aperte: ConfermaAperta[], r: RispostaConferma, s: string): { messaggio: string; fatto: boolean } {
  // Quando Jarvis richiede, la domanda torna "appena fatta": la risposta al turno dopo vale ancora.
  const rinnova = () => { for (const c of aperte) dip.db.prepare("UPDATE conferme SET creata = ? WHERE id = ? AND stato = 'in_attesa'").run(Date.now(), c.id); };
  const richiedi = (quale: boolean) => (rinnova(), {
    fatto: false,
    messaggio: quale
      ? `${s}, non ho capito quale. Premi il pulsante giusto oppure rispondi per esempio «il secondo»; per lasciar perdere, «annulla».`
      : `${s}, non ho capito se vuoi confermare. Premi il pulsante oppure rispondi «sì, conferma»; per lasciar perdere, «annulla».`,
  });
  if (r.tipo === "no") {
    for (const c of aperte) rispondiConferma(dip.db, c.id, "annulla", dip.fuso);
    return { fatto: true, messaggio: "Va bene, non faccio niente." };
  }
  if (aperte.length > 1) {
    rinnova();
    return { fatto: false, messaggio: `${s}, ho ${aperte.length} richieste in attesa: usa i pulsanti per dirmi quale confermare, così non sbaglio.` };
  }
  const c = aperte[0];
  const scelta = (JSON.parse(c.dati) as { ids?: string[] }).ids;
  if (r.tipo === "dubbio") return richiedi(!!scelta && scelta.length > 1);
  if (r.tipo === "si") {
    if (scelta && scelta.length > 1) return richiedi(true);
    const esito = rispondiConferma(dip.db, c.id, "conferma", dip.fuso);
    return { fatto: esito.ok, messaggio: esito.messaggio };
  }
  if (!scelta || r.indice >= scelta.length) return richiedi(!!scelta);
  const esito = rispondiConferma(dip.db, c.id, r.indice, dip.fuso);
  return { fatto: esito.ok, messaggio: esito.messaggio };
}

// ---------------------------------------------------------------- coda delle chiamate e tetto di spesa
// Le chiamate al cervello passano una per volta (Jarvis ha un solo utente): prima di ognuna si
// ricontrolla la spesa del mese più una stima prudente del costo della chiamata; il consumo vero si
// registra prima di lasciare il posto alla successiva. Così dieci domande in parallelo non sfondano il tetto.
const code = new WeakMap<Db, Promise<void>>();

async function inCoda<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const prima = code.get(db) ?? Promise.resolve();
  let libera!: () => void;
  const mia = new Promise<void>((r) => { libera = r; });
  code.set(db, prima.then(() => mia));
  await prima;
  try { return await fn(); } finally { libera(); }
}

/** Token in ingresso stimati di una richiesta (sistema + messaggi + strumenti). */
function stimaIngresso(r: RichiestaPasso): number {
  return stimaToken(r.sistema) + stimaToken(JSON.stringify(r.messaggi)) + stimaToken(JSON.stringify(r.strumenti));
}

/** Consumo prudente di un passo interrotto senza dati dal fornitore: tutto l'ingresso e il doppio del testo arrivato. */
function stimaUsoInterrotto(r: RichiestaPasso, parziale: string): UsoToken {
  return { ingresso: stimaIngresso(r), uscita: Math.max(100, stimaToken(parziale) * 2), cacheLettura: 0, cacheScrittura: 0 };
}

function registraConsumiPasso(db: Db, modello: string, r: RispostaPasso, fuso: string): number {
  if (r.consumi?.length) return r.consumi.reduce((tot, c) => tot + registraConsumo(db, c.modello, c.uso, fuso), 0);
  return registraConsumo(db, modello, r.uso, fuso);
}

const TETTO = Symbol("tetto");
const FERMATO = Symbol("fermato");

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

  // 1) Risposta a una conferma chiesta nel turno precedente («sì, conferma», «il secondo», «annulla»): senza AI.
  const ultimaDomanda = [...storia].reverse().find((m) => m.ruolo === "utente")?.creato;
  const aperte = ultimaDomanda === undefined ? [] : confermeAperte(db, conv, ultimaDomanda);
  const risposta = aperte.length ? leggiRispostaConferma(messaggio) : null;
  if (risposta) {
    const r = gestisciConferma(dip, aperte, risposta, s);
    if (r.fatto) emetti({ tipo: "agenda" });
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
  const messaggioTetto = `${s}, ho raggiunto il tetto di spesa del mese per l'intelligenza artificiale. Mi fermo qui: puoi alzarlo nelle impostazioni. Calcoli, agenda e briefing funzionano lo stesso.`;
  const spesa = riepilogoMese(db, imp.tettoMensileUsd, fuso);
  if (spesa.raggiunto) {
    registra(db, "ai.chiamata", "negato", "sistema", { motivo: "tetto di spesa raggiunto", spesaUsd: spesa.spesaUsd, tettoUsd: spesa.tettoUsd });
    emetti({ tipo: "avviso", testo: "Tetto di spesa del mese raggiunto." });
    di(messaggioTetto);
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
  const scritture = new Map<string, number>();

  try {
    for (let passo = 0; passo < MAX_PASSI; passo++) {
      const richiesta: RichiestaPasso = {
        modello, sistema: promptDiSistema(s), messaggi, strumenti,
        maxToken: approfondito ? MAX_TOKEN.approfondito : MAX_TOKEN.normale, sforzo: approfondito ? "medium" : "low", segnale,
      };
      const inizioPasso = detto.length;
      const r = await inCoda(db, async () => {
        if (segnale?.aborted) return FERMATO;
        const stima = costoUsd(modello, { ingresso: stimaIngresso(richiesta), uscita: richiesta.maxToken, cacheLettura: 0, cacheScrittura: 0 });
        const ora = riepilogoMese(db, imp.tettoMensileUsd, fuso);
        if (ora.spesaUsd + stima > imp.tettoMensileUsd) {
          registra(db, "ai.chiamata", "negato", "sistema", { motivo: "tetto di spesa: la chiamata lo supererebbe", spesaUsd: ora.spesaUsd, tettoUsd: ora.tettoUsd });
          return TETTO;
        }
        try {
          const risposta = await cervello.passo(richiesta, (pezzo) => di(detto ? pezzo : pezzo.replace(/^\s+/, "")));
          costo += registraConsumiPasso(db, modello, risposta, fuso);
          return risposta;
        } catch (e) {
          // Anche una risposta interrotta (stop, nuova domanda, rete) consuma token: si registra lo stesso.
          if (!(e instanceof CervelloNonDisponibile)) {
            const uso = e instanceof PassoInterrotto && e.uso ? e.uso : stimaUsoInterrotto(richiesta, detto.slice(inizioPasso));
            costo += registraConsumo(db, modello, uso, fuso);
          }
          throw e;
        }
      });
      if (r === FERMATO) break;
      if (r === TETTO) {
        emetti({ tipo: "avviso", testo: "Tetto di spesa del mese raggiunto." });
        di(passo === 0 ? messaggioTetto : " Mi fermo: ho raggiunto il tetto di spesa del mese.");
        break;
      }
      if (r.fine === "rifiuto") {
        // Rifiuto a metà risposta: il testo già arrivato NON vale come risposta e non si salva.
        const parziale = detto.length > inizioPasso;
        if (parziale) {
          detto = detto.slice(0, inizioPasso);
          emetti({ tipo: "scarta", testo: detto });
          emetti({ tipo: "avviso", testo: "La risposta si è interrotta a metà: quella parte non vale." });
        }
        registra(db, "ai.chiamata", "negato", "sistema", { motivo: "rifiuto del modello", parziale });
        di(`${detto ? " " : ""}Su questo non posso aiutarti, ${s}.`);
        break;
      }
      messaggi.push({ ruolo: "jarvis", testo: r.testo, chiamate: r.chiamate, grezzo: r.grezzo });
      if (r.fine === "limite") { di("…"); break; }
      if (!r.chiamate.length) break;
      const risultati = [];
      for (const ch of r.chiamate) {
        const esito = await eseguiStrumento(ch.nome, ch.input, {
          db, fuso, vista: d.vista, messaggioLuigi: messaggio, conversazione: conv, costructo,
          linkCalendario: dip.linkCalendario, emetti, fetchFn: dip.fetchFn, scritture,
        });
        risultati.push({ id: ch.id, contenuto: esito.contenuto, errore: esito.errore });
      }
      messaggi.push({ ruolo: "risultati", risultati });
      if (passo === MAX_PASSI - 1) di(" Mi fermo qui per non girare a vuoto.");
    }
  } catch (e) {
    if (segnale?.aborted) {
      registra(db, "ai.chiamata", "errore", "sistema", { motivo: "risposta interrotta da Luigi" });
      return chiudi();
    }
    let testo: string;
    if (e instanceof CervelloNonDisponibile) testo = e.message;
    else if (e instanceof PassoInterrotto && e.motivo === "tempo") testo = "Claude non ha risposto in tempo.";
    else if (e instanceof PassoInterrotto) testo = "la connessione con Claude si è interrotta.";
    else testo = "c'è stato un problema tecnico imprevisto.";
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
