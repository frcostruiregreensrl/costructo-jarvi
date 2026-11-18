// Conferme di ricezione automatiche su WhatsApp (autonomia livello 2). Partono SOLO se TUTTE queste regole sono vere
// (nel dubbio: niente):
//  - l'interruttore «Conferme automatiche WhatsApp» nelle Impostazioni è acceso (spento di serie) e WhatsApp è collegato;
//  - la chat NON è un gruppo, il messaggio è arrivato dal vivo (mai dallo storico) ed è stato classificato dall'AI;
//  - il contatto è di un'azienda (mai ai contatti privati o non ancora assegnati);
//  - nessun messaggio parla di pagamenti, importi o impegni: né per l'AI né per il controllo senza AI (testo, didascalie, nomi dei file);
//  - Luigi non ha già risposto dal telefono dopo quel messaggio;
//  - siamo dentro la finestra di 24 ore di WhatsApp;
//  - al massimo una conferma per contatto ogni 7 giorni e 20 al giorno in tutto.
// Testo FISSO e breve (niente scritto dall'AI). Nel registro: contatto, ultime 3 cifre del numero, motivo.
import { leggiImpostazioni } from "../impostazioni.js";
import { registra } from "../registro.js";
import { inizioGiorno } from "../tempo.js";
import { parlaDiDenaro } from "../posta/analisi.js";
import { leggiCollegamento, invioPronto } from "./collegamento.js";
import { mandaTesto } from "./invio.js";
import { leggiContatto, salvaMessaggio, statoChat } from "./archivio.js";
import { testiDi } from "./classifica.js";
import { mascheraTelefono } from "./telefono.js";
import { FINESTRA_MS, PRIVATO, type ContattoWa, type DipendenzeWhatsapp, type MessaggioWa } from "./tipi.js";

export const MAX_AL_GIORNO_WA = 20;
export const GIORNI_PER_CONTATTO_WA = 7;
/** Solo messaggi arrivati da meno di un'ora (dopo, una conferma non ha più senso). */
const ETA_MASSIMA_MS = 3600_000;
export const TESTO_CONFERMA_WA = "Buongiorno, abbiamo ricevuto il suo messaggio e le risponderemo appena possibile. "
  + "Questo è un messaggio automatico di sola conferma di ricezione: non contiene accettazioni o impegni.";

export interface ValutazioneWa { invia: boolean; motivo: string }

/** Decide se a questi messaggi (dello stesso contatto) può partire la conferma automatica. Non scrive niente. */
export function valutaConfermaWa(dip: Pick<DipendenzeWhatsapp, "db" | "cifratore" | "fuso" | "ora">, c: ContattoWa, lista: MessaggioWa[]): ValutazioneWa {
  const ora = dip.ora?.() ?? Date.now();
  const no = (motivo: string): ValutazioneWa => ({ invia: false, motivo });
  if (!leggiImpostazioni(dip.db).whatsappConfermeAutomatiche) return no("interruttore generale spento");
  if (!invioPronto(leggiCollegamento(dip))) return no("WhatsApp non collegato per l'invio");
  if (!lista.length) return no("nessun messaggio");
  if (c.gruppo || lista.some((m) => m.gruppo_id)) return no("chat di gruppo: mai conferme");
  if (lista.some((m) => m.storico || m.direzione !== "in")) return no("messaggio dello storico");
  if (lista.some((m) => m.stato !== "classificato")) return no("messaggio non classificato dall'AI");
  if (lista.some((m) => m.tocca)) return no("parla di pagamenti, importi o impegni");
  if (parlaDiDenaro(...testiDi(lista))) return no("contiene parole di denaro o impegni (anche in didascalie o nomi dei file)");
  if (!c.spazio || c.spazio === PRIVATO) return no(c.spazio ? "contatto privato: mai conferme" : "azienda del contatto non ancora nota");
  const ultimo = lista.reduce((a, b) => (b.quando > a.quando ? b : a));
  const s = statoChat(dip.db, c.id, ora);
  if (s.ultimaRisposta >= ultimo.quando) return no("Luigi ha già risposto");
  if (!s.dentroFinestra || ora - ultimo.quando > FINESTRA_MS - 10 * 60_000) return no("fuori dalla finestra di 24 ore");
  if (ora - ultimo.ricevuto > ETA_MASSIMA_MS) return no("messaggio troppo vecchio");
  const dalle = dip.db.prepare("SELECT COUNT(*) n FROM wa_conferme_auto WHERE contatto_id = ? AND quando > ?").get(c.id, ora - GIORNI_PER_CONTATTO_WA * 864e5) as { n: number };
  if (dalle.n > 0) return no("già confermato a questo contatto negli ultimi 7 giorni");
  const oggi = dip.db.prepare("SELECT COUNT(*) n FROM wa_conferme_auto WHERE quando >= ?").get(inizioGiorno(ora, dip.fuso)) as { n: number };
  if (oggi.n >= MAX_AL_GIORNO_WA) return no("limite di 20 conferme al giorno raggiunto");
  return { invia: true, motivo: "nessun importo, pagamento o impegno" };
}

/** Manda le conferme ai messaggi appena classificati che le meritano (una per contatto). Restituisce quante. */
export async function mandaConfermeWa(dip: DipendenzeWhatsapp): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const candidati = db.prepare(`SELECT * FROM wa_messaggi WHERE conferma_auto = '' AND direzione = 'in' AND storico = 0
      AND stato IN ('classificato','filtrato','errore') ORDER BY ricevuto`).all() as MessaggioWa[];
  if (!candidati.length) return 0;
  const segna = db.prepare("UPDATE wa_messaggi SET conferma_auto = ? WHERE id = ?");
  const perContatto = new Map<string, MessaggioWa[]>();
  for (const m of candidati) perContatto.set(m.contatto_id, [...(perContatto.get(m.contatto_id) ?? []), m]);
  let mandate = 0;
  for (const [id, lista] of perContatto) {
    const c = leggiContatto(db, id);
    const recenti = lista.filter((m) => ora - m.ricevuto <= ETA_MASSIMA_MS);
    const v = c && recenti.length ? valutaConfermaWa(dip, c, recenti) : { invia: false, motivo: "messaggio troppo vecchio" };
    if (!c || !v.invia) { for (const m of lista) segna.run(`saltata: ${v.motivo}`.slice(0, 120), m.id); continue; }
    // Si segna PRIMA di inviare: meglio nessuna conferma che due.
    for (const m of lista) segna.run("in_invio", m.id);
    const coll = leggiCollegamento(dip)!;
    try {
      const wamid = await mandaTesto(coll, { waId: c.wa_id, userId: c.user_id }, TESTO_CONFERMA_WA, { fetchFn: dip.fetchFn, attesa: dip.attesaRiprova });
      salvaMessaggio(db, { wamid, contattoId: c.id, direzione: "out", tipo: "text", quando: ora, testo: TESTO_CONFERMA_WA, automatico: true }, ora);
      db.prepare("INSERT INTO wa_conferme_auto (contatto_id, quando) VALUES (?,?)").run(c.id, ora);
      for (const m of lista) segna.run("inviata", m.id);
      registra(db, "whatsapp.conferma_automatica", "fatto", "jarvis", { contatto: c.id, numero: mascheraTelefono(c.wa_id), motivo: v.motivo });
      mandate++;
    } catch (e) {
      for (const m of lista) segna.run("errore di invio", m.id);
      registra(db, "whatsapp.conferma_automatica", "errore", "jarvis", { contatto: c.id, numero: mascheraTelefono(c.wa_id), motivo: (e as Error).message?.slice(0, 120) || "invio non riuscito" });
    }
  }
  return mandate;
}
