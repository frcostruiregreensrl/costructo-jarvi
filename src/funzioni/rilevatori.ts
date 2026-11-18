// Riconoscimento SENZA AI di quello che c'è in un messaggio: ore lavorate, appuntamenti, promesse, compleanni,
// «ricordati di», richieste di lavoro, documenti (preventivi, fatture, DURC, DDT, scontrini), righe di consegna.
// Prima sempre questo (costo zero, niente dati inventati); l'AI (Haiku) solo dove serve davvero e sempre controllata con zod.
import { leggiData, leggiOra, normalizza } from "./date.js";

const numero = (s: string) => Number(s.replace(",", "."));

// ---------------------------------------------------------------- ore (funzione 19)
export interface OreLette { ore: number; oreEconomia?: number; cantiere?: string; data?: string; descrizione?: string }

/** «8 ore cantiere Rossi», «oggi 7,5 h da Bianchi, 2 in economia», «ieri 8 ore in via Roma». */
export function leggiOre(testo: string, ora: number, fuso: string): OreLette | null {
  const t = testo.replace(/\s+/g, " ").trim();
  const m = /(?:^|[^\d:.,])(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:ore|h)\b(?!\s*\d)/i.exec(t);
  if (!m) return null;
  const ore = numero(m[1]);
  if (!(ore > 0 && ore <= 24)) return null;
  // «alle ore 15», «dalle 8 alle 17»: sono orari, non ore lavorate.
  if (/\b(alle|dalle)\s+ore\b/i.test(t.slice(Math.max(0, m.index - 8), m.index + m[0].length + 2))) return null;
  const out: OreLette = { ore };
  const eco = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:ore|h)?\s*(?:in|di|a)\s+economia/i.exec(t);
  if (eco && eco.index !== m.index) {
    const e = numero(eco[1]);
    if (e >= 0 && e <= ore) out.oreEconomia = e;
  }
  const c = /\b(?:cantiere|cant\.)\s+(?:di\s+|del\s+|della\s+|in\s+)?([A-Za-zÀ-ÿ'][\wÀ-ÿ' .]{1,40}?)(?=\s*(?:[,;!?\n]|$|\s(?:oggi|ieri|domani|e|con|per|dalle|alle|in economia|\d)\b))/i.exec(t)
    ?? /\b(?:presso|da|dai|dal|dalla|in via|a casa)\s+([A-ZÀ-Ý][\wÀ-ÿ']{1,30}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ']{1,30})?)/.exec(t);
  if (c) out.cantiere = c[1].replace(/\s+/g, " ").trim().replace(/[.]$/, "");
  const d = leggiData(t, ora, fuso, false);
  if (d) out.data = d;
  return out;
}

// ---------------------------------------------------------------- appuntamenti (funzione 6)
const APPUNTAMENTO = /\b(ci vediamo|ci vedremo|vediamoci|appuntamento|passo|passiamo|passero|passeremo|vengo|veniamo|verro|verremo|sopralluogo|incontriamoci|ci incontriamo|fissato|fissiamo|confermo per|riunione)\b/;

export interface AppuntamentoLetto { data: string; ora?: string; sopralluogo: boolean }

/** «ci vediamo domani alle 10», «passo giovedì alle 9 in cantiere», «sopralluogo il 12/03 alle 15». Senza giorno: niente. */
export function leggiAppuntamento(testo: string, ora: number, fuso: string): AppuntamentoLetto | null {
  const t = normalizza(testo);
  if (!APPUNTAMENTO.test(t)) return null;
  if (/\?\s*$/.test(t.trim()) && !/\b(confermo|fissato|ok|va bene|perfetto)\b/.test(t)) return null; // una domanda non è ancora un appuntamento
  const data = leggiData(t, ora, fuso, true);
  if (!data) return null;
  const o = leggiOra(t);
  return { data, ...(o ? { ora: o } : {}), sopralluogo: /\bsopralluogo\b/.test(t) };
}

// ---------------------------------------------------------------- promesse di Luigi (funzione 2)
const VERBI_PROMESSA = /\b(ti|le|vi|gli)\s+(mando|mandero|invio|inviero|giro|girero|faccio avere|faro avere|porto|portero|preparo|preparero|richiamo|chiamo|chiamero|faccio sapere|faro sapere|rispondo|rispondero|confermo|confermero)\b/;
const QUANDO_PROMESSA = /\b(oggi|stasera|stamattina|in giornata|domani|dopodomani|entro\s+(?:oggi|domani|stasera|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|fine settimana|\d{1,2}[/\-]\d{1,2})|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|\d{1,2}[/\-]\d{1,2}|a breve|subito|piu tardi|dopo pranzo|in mattinata|nel pomeriggio)\b/;

export interface PromessaLetta { cosa: string; data: string }

/** Messaggio scritto da Luigi: «ti mando il preventivo domani», «le faccio sapere entro venerdì». */
export function leggiPromessa(testo: string, ora: number, fuso: string): PromessaLetta | null {
  const t = normalizza(testo).replace(/\s+/g, " ");
  const v = VERBI_PROMESSA.exec(t);
  if (!v) return null;
  const dopo = t.slice(v.index + v[0].length);
  const q = QUANDO_PROMESSA.exec(dopo) ?? QUANDO_PROMESSA.exec(t.slice(0, v.index));
  if (!q) return null;
  let cosa = dopo.slice(0, q.index === undefined || dopo.indexOf(q[0]) < 0 ? 60 : dopo.indexOf(q[0])).replace(/\b(entro|per|in)\s*$/, "").trim();
  cosa = cosa.replace(/^(il|lo|la|i|gli|le|un|una|uno|l')\s*/, "").replace(/[,.;!?].*$/, "").trim();
  const verbo = v[2];
  if (!cosa) cosa = /chiam/.test(verbo) ? "una chiamata" : /sapere|rispond|conferm/.test(verbo) ? "una risposta" : "quanto promesso";
  const quando = q[0].replace(/^entro\s+/, "");
  const data = /a breve|subito|piu tardi|dopo pranzo|in mattinata|nel pomeriggio/.test(quando) ? leggiData("oggi", ora, fuso) : leggiData(quando, ora, fuso, true);
  if (!data) return null;
  return { cosa: cosa.slice(0, 80), data };
}

// ---------------------------------------------------------------- vita privata (funzione 10)
export interface CompleannoLetto { data: string; chi?: string; mio: boolean }

/** «Il 3 maggio è il compleanno di Marco», «domani è il mio compleanno», «Giulia compie gli anni il 12/04». */
export function leggiCompleanno(testo: string, ora: number, fuso: string): CompleannoLetto | null {
  const t = testo.replace(/\s+/g, " ");
  const n = normalizza(t);
  if (!/\b(compleanno|compie (gli )?anni|fa gli anni)\b/.test(n)) return null;
  const data = leggiData(n, ora, fuso, true);
  if (!data) return null;
  const mio = /\b(mio compleanno|compio (gli )?anni|faccio gli anni)\b/.test(n);
  const di = /compleanno (?:di|del|della)\s+([A-ZÀ-Ý][\wÀ-ÿ']{1,30}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ']{1,30})?)/.exec(t) ?? /\b([A-ZÀ-Ý][\wÀ-ÿ']{1,30})\s+(?:compie|fa) gli anni/.exec(t);
  return { data, mio, ...(di ? { chi: di[1] } : {}) };
}

export interface RicordaLetto { cosa: string; data?: string; ora?: string }

/** «ricordati di comprare il latte domani», «non dimenticare di chiamare la nonna». */
export function leggiRicordati(testo: string, ora: number, fuso: string): RicordaLetto | null {
  const t = testo.replace(/\s+/g, " ").trim();
  const m = /\b(?:ricordati|ricordami|ricordatevi|non dimenticare|non dimenticarti|non scordarti|ricorda)\s+(?:di|che)\s+(.{3,140})/i.exec(t);
  if (!m) return null;
  const cosa = m[1].replace(/[.!?]+$/, "").trim();
  const data = leggiData(cosa, ora, fuso, true) ?? undefined;
  const o = leggiOra(cosa) ?? undefined;
  return { cosa: cosa.slice(0, 120), ...(data ? { data } : {}), ...(o ? { ora: o } : {}) };
}

// ---------------------------------------------------------------- nuova richiesta di lavoro (funzione 12)
const INTENTO = /\b(vorrei|vorremmo|potete|potreste|potrebbe|mi serve|mi servirebbe|ci serve|ci servirebbe|avrei bisogno|avremmo bisogno|chiedo|richiedo|mi fate|ci fate|siete disponibili|fate anche|vi contatto per|mi interessa)\b/;
const LAVORO = /\b(preventivo|sopralluogo|ristruttur\w*|rifare|rifacimento|sistemare|lavor[oi]|impermeabilizz\w*|infiltrazion\w*|cappotto|tetto|bagno|cucina|facciata|pavimento|massetto|intonac\w*|demoli\w*|ampliamento|muro|recinzione|tinteggi\w*|cartongesso)\b/;

/** Un messaggio che chiede un lavoro nuovo («vorrei un preventivo per rifare il bagno»). */
export const richiestaLavoro = (testo: string) => { const t = normalizza(testo); return INTENTO.test(t) && LAVORO.test(t); };

// ---------------------------------------------------------------- documenti (funzioni 14, 15, 16, 17)
export type CategoriaDocumento = "fornitore" | "rinnovo" | "ddt" | "scontrino";
export interface DocumentoLetto { categoria: CategoriaDocumento; tipo?: "preventivo" | "fattura"; tipoDocumento?: string }

const RINNOVO: Array<[RegExp, string]> = [
  [/\bdurc\b/, "DURC"], [/\bvisura\b/, "Visura camerale"], [/\bpolizz\w*|\brc\s?t\b|\brcto\b/, "Polizza assicurativa"], [/\bdvr\b/, "DVR"],
  [/\bpiano operativo di sicurezza\b|\bp\.?o\.?s\.?\b(?!\s*(?:bancomat|pagamento))/, "POS (piano operativo di sicurezza)"], [/\battestat\w*/, "Attestato"],
  [/\bidoneit\w*/, "Idoneità sanitaria"], [/\bcassa edile\b/, "Iscrizione Cassa Edile"], [/\bunilav\b/, "UNILAV"], [/\bpatente a crediti\b/, "Patente a crediti"],
];

/** Che documento è, dal nome del file e dalla didascalia. Nel dubbio: null. */
export function leggiDocumento(nomeFile: string, didascalia: string): DocumentoLetto | null {
  const t = normalizza(`${nomeFile} ${didascalia}`).replace(/[_.\-]+/g, " ");
  for (const [re, nome] of RINNOVO) if (re.test(t)) return { categoria: "rinnovo", tipoDocumento: nome };
  if (/\b(d d t|ddt|bolla|bolle|documento di trasporto|consegna|consegnato|consegnati|scarico merce)\b/.test(t)) return { categoria: "ddt" };
  if (/\b(scontrino|scontrini|ricevuta fiscale|carburante|gasolio|benzina|pedaggio|ristorante|pranzo|parcheggio|autostrada)\b/.test(t)) return { categoria: "scontrino" };
  if (/\b(preventivo|offerta|quotazione|quote|quotation)\b/.test(t)) return { categoria: "fornitore", tipo: "preventivo" };
  if (/\b(fattura|fatture|fatt|ft|invoice|proforma|pro forma|nota di credito)\b/.test(t)) return { categoria: "fornitore", tipo: "fattura" };
  return null;
}

/** Un'immagine con questa didascalia è uno scontrino? */
export const eScontrino = (didascalia: string) => leggiDocumento("", didascalia)?.categoria === "scontrino";

export interface DatiFornitore { numero?: string; piva?: string; data?: string; importo?: number }

/** Numero, partita IVA, data e importo SOLO se scritti (didascalia o nome del file). Mai calcolati. */
export function leggiDatiFornitore(testo: string, ora: number, fuso: string): DatiFornitore {
  const out: DatiFornitore = {};
  const n = /\b(?:n\.?|nr\.?|num\.?|numero)\s*[:°º]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{0,19})/i.exec(testo);
  if (n) out.numero = n[1];
  const p = /\b(\d{11})\b/.exec(testo.replace(/\s+/g, " "));
  if (p) out.piva = p[1];
  const d = leggiData(testo.replace(/[_]+/g, " "), ora, fuso, false);
  if (d) out.data = d;
  const imp = /(?:€|euro|eur|totale|importo)\s*[:=]?\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?|\d+\.\d{1,2})\b/i.exec(testo)
    ?? /\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(?:€|euro|eur)\b/i.exec(testo);
  if (imp) {
    const s = imp[1];
    const v = /,\d{1,2}$/.test(s) || /\.\d{3}/.test(s) ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
    if (Number.isFinite(v)) out.importo = v;
  }
  return out;
}

/** Scadenza scritta («scadenza 12/03/2027», «valido fino al 3 maggio 2027»). */
export function leggiScadenza(testo: string, ora: number, fuso: string): string | null {
  const m = /\b(?:scad\w*|valid\w* fino al|valid\w* al|fino al)\s*[:]?\s*(.{4,30})/i.exec(testo.replace(/[_]+/g, " "));
  return m ? leggiData(m[1], ora, fuso, true) : null;
}

// ---------------------------------------------------------------- consegne (funzione 16)
const UNITA = "sacchi|sacco|pz|pezzi|pezzo|mt|metri|metro|mq|m2|m3|mc|m|kg|q|quintali|quintale|t|ton|tonnellate|bancali|bancale|litri|litro|lt|l|rotoli|rotolo|scatole|scatola|barre|barra|tubi|tubo|confezioni|conf|secchi|secchio|fusti|fusto";
export interface RigaLetta { descrizione: string; quantita: number; unita: string }

/** «20 sacchi di cemento, 3 bancali di mattoni e 50 m di tubo»: solo le righe scritte chiaramente. */
export function leggiRighe(testo: string): RigaLetta[] {
  const out: RigaLetta[] = [];
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNITA})\\b\\.?\\s*(?:di\\s+|del\\s+|della\\s+|de\\s+)?([A-Za-zÀ-ÿ][^,;\\n]{1,80}?)(?=\\s*(?:[,;\\n]|\\se\\s+\\d|$)|\\s+(?:in |al |per il |presso il |presso |nel |a )?(?:cantiere|via)\\b)`, "gi");
  for (const m of testo.matchAll(re)) {
    const q = numero(m[1]);
    if (!(q > 0)) continue;
    out.push({ quantita: q, unita: m[2].toLowerCase(), descrizione: m[3].trim().replace(/[.]$/, "").slice(0, 200) });
    if (out.length >= 100) break;
  }
  return out;
}

/** Foto di un problema (rotto, guasto, perdita, crepa…) oppure di un lavoro fatto. */
export const tipoFoto = (testo: string): "fatto" | "problema" =>
  /\b(rott\w*|guast\w*|perdit\w*|crep\w*|problem\w*|dann\w*|infiltraz\w*|ferm[oa]|crollat\w*|cedut\w*|mancan\w*|allagat\w*|urgente)\b/.test(normalizza(testo)) ? "problema" : "fatto";

/** Una risposta con prezzi o impegni economici (mai nelle risposte proposte da Jarvis). */
export const parlaDiPrezzi = (testo: string) =>
  /(\d[\d.,]*\s*(?:€|euro|eur)\b|€\s*\d)|\b(costa|costerebbe|costerà|prezzo|a corpo|preventivo di|sconto|totale di)\b\s*[:]?\s*\d/i.test(testo);

/** Toglie prezzi e importi da un testo proposto dall'AI: al loro posto «[da completare]» (decide Luigi). */
export const togliPrezzi = (testo: string) => testo
  .replace(/(\d[\d.,]*\s*(?:€|euro|eur)\b|€\s*\d[\d.,]*)/gi, "[da completare]")
  .replace(/\b(costa|costerebbe|costerà|prezzo|a corpo|preventivo di|sconto|totale di)(\s*[:]?\s*)\d[\d.,]*/gi, "$1$2[da completare]");
