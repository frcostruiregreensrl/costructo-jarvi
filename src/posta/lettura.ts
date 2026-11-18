// Lettura delle mail nuove di una casella (Posta in arrivo), dall'ultimo UID visto.
// Primo controllo (o casella «ricreata» sul server, UIDVALIDITY diverso): gli ultimi 7 giorni, al massimo 200 mail.
// Con UIDVALIDITY diverso le mail già salvate si riconoscono dal Message-ID: niente doppioni, niente nuove notifiche
// e niente conferme automatiche (le mail di un primo controllo non sono mai «nuove»).
// La casella si apre in SOLA LETTURA e i messaggi si scaricano con BODY.PEEK: niente diventa «letto».
import { registra } from "../registro.js";
import { leggiMail, MAX_SORGENTE_BYTE } from "./analisi.js";
import { salvaMessaggio, leggiStatoLettura, scriviStatoLettura, riallineaMessaggio } from "./archivio.js";
import type { Casella, DipendenzePosta } from "./tipi.js";

export const GIORNI_PRIMO_CONTROLLO = 7;
export const MAX_PRIMO_CONTROLLO = 200;
/** Al massimo tante mail per giro (le altre arrivano al giro dopo). */
export const MAX_PER_GIRO = 200;

export interface EsitoLettura { casella: string; nuove: string[]; errore?: string }

export async function leggiNuove(dip: DipendenzePosta, c: Casella): Promise<EsitoLettura> {
  const ora = dip.ora?.() ?? Date.now();
  const stato = leggiStatoLettura(dip.db, c.id);
  let conn;
  try {
    conn = await dip.apriImap(c);
  } catch (e) {
    const messaggio = (e as Error).message || "Casella non raggiungibile.";
    scriviStatoLettura(dip.db, c.id, { esito: "errore", messaggio }, ora);
    registra(dip.db, "posta.leggi", "errore", "sistema", { casella: c.nome, motivo: messaggio });
    return { casella: c.id, nuove: [], errore: messaggio };
  }
  try {
    const box = await conn.apriInbox();
    const primo = !stato || !stato.uidValidity || stato.uidValidity !== box.uidValidity;
    let uids = primo
      ? (await conn.cercaDal(new Date(ora - GIORNI_PRIMO_CONTROLLO * 864e5))).sort((a, b) => a - b).slice(-MAX_PRIMO_CONTROLLO)
      : (await conn.uidDopo(stato!.ultimoUid)).filter((u) => u > stato!.ultimoUid).sort((a, b) => a - b);
    uids = uids.slice(0, MAX_PER_GIRO);
    const nuove: string[] = [];
    let ultimo = primo ? 0 : stato!.ultimoUid;
    // A pezzi di 25: una mail rovinata non ferma le altre.
    for (let i = 0; i < uids.length; i += 25) {
      const grezzi = await conn.scarica(uids.slice(i, i + 25), MAX_SORGENTE_BYTE);
      for (const g of grezzi) {
        ultimo = Math.max(ultimo, g.uid);
        try {
          const mail = await leggiMail(g);
          if (riallineaMessaggio(dip.db, c.id, mail.messageId, g.uid, box.uidValidity)) continue;
          const id = salvaMessaggio(dip.db, { casellaId: c.id, uid: g.uid, uidValidity: box.uidValidity, spazio: c.spazio, nuova: !primo, mail }, ora);
          if (id) nuove.push(id);
        } catch {
          registra(dip.db, "posta.leggi", "errore", "sistema", { casella: c.nome, motivo: "una mail non si legge, saltata", uid: g.uid });
        }
      }
    }
    // Casella vuota negli ultimi 7 giorni: si parte dall'ultimo UID (da UIDNEXT, o chiedendolo se il server non lo dice).
    if (primo && !uids.length) ultimo = box.uidNext > 0 ? box.uidNext - 1 : await conn.ultimoUid();
    scriviStatoLettura(dip.db, c.id, { uidValidity: box.uidValidity, ultimoUid: ultimo, esito: "ok", messaggio: nuove.length ? `${nuove.length} ${nuove.length === 1 ? "nuova" : "nuove"}` : "nessuna novità" }, ora);
    if (nuove.length) registra(dip.db, "posta.leggi", "fatto", "sistema", { casella: c.nome, nuove: nuove.length, primoControllo: primo });
    return { casella: c.id, nuove };
  } catch (e) {
    const messaggio = (e as Error).message || "Lettura non riuscita.";
    scriviStatoLettura(dip.db, c.id, { esito: "errore", messaggio }, ora);
    registra(dip.db, "posta.leggi", "errore", "sistema", { casella: c.nome, motivo: messaggio });
    return { casella: c.id, nuove: [], errore: messaggio };
  } finally {
    await conn.chiudi().catch(() => {});
  }
}
