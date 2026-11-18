// Ricerca unica (funzione 5): messaggi WhatsApp e mail salvati in Jarvis (indice FTS5, ultimi 30 giorni) + Costructo (/v1/cerca).
// Rispetta le schede: Lavoro = solo le aziende (mai il privato); Privato = solo il privato (niente Costructo);
// Tutto = le aziende, e il privato SOLO se Luigi lo chiede esplicitamente. Ogni risultato dice di quale azienda è.
import type { Db } from "../db.js";
import type { AziendaCollegata } from "../aziende.js";
import { trovaAziende, nomiAziende } from "../aziende.js";
import { nomeContatto, nomeSpazio, leggiContatto } from "../whatsapp/archivio.js";
import { PRIVATO, type AziendaWa } from "../whatsapp/tipi.js";
import { normalizza } from "./date.js";

export interface RisultatoRicerca { fonte: "whatsapp" | "posta" | "costructo"; spazio: string; azienda: string; titolo: string; estratto: string; quando?: number; rif?: string }
export interface EsitoRicerca { risultati: RisultatoRicerca[]; avvisi: string[]; domanda?: string; privatoIncluso: boolean }

/** Testo di Luigi → query FTS5 sicura: parole tra virgolette (niente operatori), cercate anche come inizio di parola. */
export function queryFts(testo: string): string | null {
  const parole = normalizza(testo).split(/[^a-z0-9]+/).filter((p) => p.length >= 2).slice(0, 8);
  return parole.length ? parole.map((p) => `"${p.replace(/"/g, '""')}"*`).join(" ") : null;
}

/** Luigi ha chiesto esplicitamente anche le cose private? (parola nel suo messaggio, non solo un'opzione) */
export const chiedePrivato = (messaggio: string) => /\b(privat\w*|personal\w*|famiglia|anche (le )?mie|vita privata)\b/i.test(messaggio);

export interface OpzioniRicerca {
  db: Db; vista: "privato" | "lavoro" | "tutto"; aziende: AziendaWa[]; collegate: AziendaCollegata[];
  testo: string; azienda?: string; anchePrivato?: boolean; limite?: number;
}

function elencoCostructo(dati: unknown): Array<{ titolo: string; estratto: string }> {
  let arr: unknown = dati;
  if (!Array.isArray(arr) && arr && typeof arr === "object") {
    for (const k of ["risultati", "elementi", "dati", "items"]) { const x = (arr as Record<string, unknown>)[k]; if (Array.isArray(x)) { arr = x; break; } }
  }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 20).map((x) => {
    const o = (x && typeof x === "object" ? x : { titolo: String(x) }) as Record<string, unknown>;
    const titolo = String(o.titolo ?? o.nome ?? o.descrizione ?? o.numero ?? "Risultato").slice(0, 140);
    return { titolo, estratto: [o.tipo, o.cliente, o.stato].filter(Boolean).map(String).join(" · ").slice(0, 200) };
  });
}

export async function cercaOvunque(o: OpzioniRicerca): Promise<EsitoRicerca> {
  const q = queryFts(o.testo);
  const out: EsitoRicerca = { risultati: [], avvisi: [], privatoIncluso: false };
  if (!q) return { ...out, domanda: "Cosa devo cercare?" };
  let aziende = o.aziende;
  if (o.azienda?.trim() && !/^(privat[oa]|personale)$/i.test(o.azienda.trim())) {
    const t = trovaAziende(o.aziende, o.azienda);
    if (t.length !== 1) return { ...out, domanda: `Di quale azienda parli: ${nomiAziende(o.aziende)}?` };
    aziende = t;
  }
  const soloPrivato = /^(privat[oa]|personale)$/i.test(o.azienda?.trim() ?? "");
  const spazi: string[] = [];
  if (o.vista === "privato") spazi.push(PRIVATO);
  else {
    if (!soloPrivato) spazi.push(...aziende.map((a) => a.id));
    if (o.vista === "tutto" && (o.anchePrivato || soloPrivato)) spazi.push(PRIVATO, "");
  }
  out.privatoIncluso = spazi.includes(PRIVATO);
  const limite = Math.max(1, Math.min(50, o.limite ?? 20));
  if (spazi.length) {
    const segnaposto = spazi.map(() => "?").join(",");
    const wa = o.db.prepare(`SELECT f.rif, snippet(cerca_wa, 0, '[', ']', '…', 12) AS s, m.quando, c.spazio, c.id AS cid FROM cerca_wa f
        JOIN wa_messaggi m ON m.id = f.rif JOIN wa_contatti c ON c.id = m.contatto_id
        WHERE cerca_wa MATCH ? AND c.spazio IN (${segnaposto}) ORDER BY rank LIMIT ?`).all(q, ...spazi, limite) as Array<{ rif: string; s: string; quando: number; spazio: string; cid: string }>;
    for (const r of wa) {
      const c = leggiContatto(o.db, r.cid);
      out.risultati.push({ fonte: "whatsapp", spazio: r.spazio, azienda: nomeSpazio(r.spazio, o.aziende), titolo: `WhatsApp · ${c ? nomeContatto(c) : "contatto"}`, estratto: r.s.slice(0, 300), quando: r.quando, rif: r.cid });
    }
    const posta = o.db.prepare(`SELECT f.rif, snippet(cerca_posta, 0, '[', ']', '…', 12) AS s, p.data, p.spazio, p.oggetto, p.da_nome, p.da_indirizzo FROM cerca_posta f
        JOIN posta_messaggi p ON p.id = f.rif WHERE cerca_posta MATCH ? AND p.spazio IN (${segnaposto}) ORDER BY rank LIMIT ?`).all(q, ...spazi, limite) as
      Array<{ rif: string; s: string; data: number; spazio: string; oggetto: string; da_nome: string; da_indirizzo: string }>;
    for (const r of posta) {
      out.risultati.push({ fonte: "posta", spazio: r.spazio, azienda: nomeSpazio(r.spazio, o.aziende), titolo: `Mail · ${r.oggetto || "(senza oggetto)"} (da ${r.da_nome || r.da_indirizzo})`.slice(0, 200), estratto: r.s.slice(0, 300), quando: r.data, rif: r.rif });
    }
  }
  // Costructo: mai nella scheda Privato.
  if (o.vista !== "privato" && !soloPrivato) {
    const scelte = o.collegate.filter((a) => a.client.configurato && aziende.some((x) => x.id === a.id));
    const esiti = await Promise.allSettled(scelte.map((a) => a.client.cerca(o.testo)));
    esiti.forEach((e, i) => {
      if (e.status === "rejected") { out.avvisi.push(`${scelte[i].nome}: ${(e.reason as Error)?.message ?? "Costructo non risponde"}`); return; }
      for (const r of elencoCostructo(e.value.dati)) out.risultati.push({ fonte: "costructo", spazio: scelte[i].id, azienda: scelte[i].nome, titolo: `Costructo · ${r.titolo}`, estratto: r.estratto });
    });
  }
  return out;
}
