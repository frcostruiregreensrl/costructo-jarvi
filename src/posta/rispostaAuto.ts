// Conferme di ricezione automatiche (autonomia livello 2, decisione di Luigi).
// Partono SOLO se TUTTE queste condizioni sono vere (nel dubbio: niente):
//  - l'interruttore generale «Conferme automatiche» nelle Impostazioni è acceso (spento di serie);
//  - la casella è Gmail o «altro» con le conferme accese: MAI da una PEC (valore legale);
//  - la mail è arrivata dopo il primo controllo, da meno di 2 giorni, ed è stata classificata dall'AI;
//  - l'AI dice che NON parla di pagamenti, importi o impegni E il controllo senza AI non trova parole di denaro;
//  - il mittente non è no-reply, una mailing list, un messaggio automatico (Auto-Submitted, Precedence, List-*),
//    una PEC o una delle caselle di Luigi; Reply-To, se c'è, è dello stesso dominio;
//  - al massimo una conferma per mittente ogni 7 giorni e al massimo 20 al giorno in tutto.
// Il testo è fisso (nessun contenuto scritto dall'AI). Intestazioni: Auto-Submitted: auto-replied, In-Reply-To, References.
// Ogni conferma finisce nel registro con il solo dominio del destinatario, la casella e il motivo.
import { createHash } from "node:crypto";
import { leggiImpostazioni } from "../impostazioni.js";
import { registra } from "../registro.js";
import { inizioGiorno } from "../tempo.js";
import { parlaDiDenaro, indirizzoPec } from "./analisi.js";
import { segniDi } from "./archivio.js";
import { leggiCaselle } from "./caselle.js";
import type { Casella, DipendenzePosta, MailInUscita, MessaggioPosta } from "./tipi.js";

export const MAX_AL_GIORNO = 20;
export const GIORNI_PER_MITTENTE = 7;
const ETA_MASSIMA_MS = 2 * 864e5;

export const OGGETTO_CONFERMA = (oggetto: string) => `Ricevuto: ${oggetto || "il suo messaggio"}`.slice(0, 200);
export const TESTO_CONFERMA = [
  "Buongiorno,",
  "",
  "confermiamo di aver ricevuto il suo messaggio. Le risponderemo appena possibile.",
  "",
  "Questo è un messaggio automatico di sola conferma di ricezione: non contiene accettazioni, impegni o conferme di alcun tipo.",
  "",
  "Cordiali saluti",
].join("\n");

const impronta = (indirizzo: string) => createHash("sha256").update(indirizzo.toLowerCase()).digest("hex").slice(0, 24);
const dominio = (indirizzo: string) => (indirizzo.split("@")[1] ?? "").toLowerCase();

export interface Valutazione { invia: boolean; motivo: string }

/** Decide se a questa mail può partire la conferma automatica. Non scrive niente. */
export function valutaConferma(dip: Pick<DipendenzePosta, "db" | "cifratore" | "fuso" | "ora">, c: Casella, m: MessaggioPosta): Valutazione {
  const ora = dip.ora?.() ?? Date.now();
  const no = (motivo: string): Valutazione => ({ invia: false, motivo });
  if (!leggiImpostazioni(dip.db).confermeAutomaticheAttive) return no("interruttore generale spento");
  if (c.tipo === "pec") return no("casella PEC: mai conferme automatiche");
  if (!c.confermeAutomatiche || !c.smtp) return no("conferme spente per questa casella");
  if (!m.nuova) return no("mail del primo controllo");
  if (ora - m.data > ETA_MASSIMA_MS || ora - m.salvato > ETA_MASSIMA_MS) return no("mail troppo vecchia");
  if (m.stato !== "classificato") return no("mail non classificata dall'AI");
  if (m.tocca) return no("parla di pagamenti, importi o impegni");
  if (parlaDiDenaro(m.oggetto, m.estratto)) return no("contiene parole di denaro o impegni");
  const s = segniDi(m);
  if (s.lista) return no("mailing list o invio di massa");
  if (s.automatico) return no("messaggio automatico");
  if (s.noReply) return no("mittente no-reply");
  if (s.pec) return no("messaggio PEC");
  const da = m.da_indirizzo.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(da)) return no("mittente non valido");
  if (indirizzoPec(da)) return no("mittente PEC");
  if (m.rispondi_a && dominio(m.rispondi_a) !== dominio(da)) return no("rispondi-a di un altro dominio");
  const mie = leggiCaselle(dip).map((x) => x.utente.toLowerCase());
  if (mie.includes(da) || da === c.utente.toLowerCase()) return no("mail di Luigi stesso");
  const dalle = dip.db.prepare("SELECT COUNT(*) n FROM posta_risposte_auto WHERE mittente = ? AND quando > ?").get(impronta(da), ora - GIORNI_PER_MITTENTE * 864e5) as { n: number };
  if (dalle.n > 0) return no("già confermato a questo mittente negli ultimi 7 giorni");
  const oggi = dip.db.prepare("SELECT COUNT(*) n FROM posta_risposte_auto WHERE quando >= ?").get(inizioGiorno(ora, dip.fuso)) as { n: number };
  if (oggi.n >= MAX_AL_GIORNO) return no("limite di 20 conferme al giorno raggiunto");
  return { invia: true, motivo: "nessun importo, pagamento o impegno" };
}

export function componiConferma(m: MessaggioPosta): MailInUscita {
  const riferimenti = [m.riferimenti, m.message_id].filter(Boolean).join(" ").trim();
  return {
    a: m.da_indirizzo,
    oggetto: OGGETTO_CONFERMA(m.oggetto),
    testo: TESTO_CONFERMA,
    ...(m.message_id ? { inReplyTo: m.message_id } : {}),
    ...(riferimenti ? { references: riferimenti } : {}),
  };
}

/** Manda le conferme automatiche alle mail appena classificate che le meritano. Restituisce quante ne ha mandate. */
export async function mandaConferme(dip: DipendenzePosta): Promise<number> {
  const { db } = dip;
  const ora = dip.ora?.() ?? Date.now();
  const caselle = new Map(leggiCaselle(dip).map((c) => [c.id, c]));
  const candidate = db.prepare("SELECT * FROM posta_messaggi WHERE conferma_auto = '' AND nuova = 1 AND stato IN ('classificato','filtrato','errore') AND salvato > ? ORDER BY data")
    .all(ora - ETA_MASSIMA_MS) as MessaggioPosta[];
  const segna = db.prepare("UPDATE posta_messaggi SET conferma_auto = ? WHERE id = ?");
  let mandate = 0;
  for (const m of candidate) {
    const c = caselle.get(m.casella_id);
    if (!c) continue;
    const v = valutaConferma(dip, c, m);
    if (!v.invia) { segna.run(`saltata: ${v.motivo}`.slice(0, 120), m.id); continue; }
    // Si segna PRIMA di inviare: se l'invio si interrompe a metà, non si riprova (meglio nessuna conferma che due).
    segna.run("in_invio", m.id);
    try {
      await dip.uscita.invia(c, componiConferma(m));
      db.prepare("INSERT INTO posta_risposte_auto (casella_id, mittente, dominio, quando) VALUES (?,?,?,?)").run(c.id, impronta(m.da_indirizzo), dominio(m.da_indirizzo), ora);
      segna.run("inviata", m.id);
      registra(db, "posta.conferma_automatica", "fatto", "jarvis", { casella: c.nome, dominio: dominio(m.da_indirizzo), motivo: v.motivo });
      mandate++;
    } catch (e) {
      segna.run("errore di invio", m.id);
      registra(db, "posta.conferma_automatica", "errore", "jarvis", { casella: c.nome, dominio: dominio(m.da_indirizzo), motivo: (e as Error).message?.slice(0, 120) || "invio non riuscito" });
    }
  }
  return mandate;
}
