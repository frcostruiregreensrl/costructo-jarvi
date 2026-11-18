// Caselle email di Luigi (al massimo 10): PEC Aruba, Gmail o altro server.
// Sono salvate tutte insieme nel segreto cifrato «posta_caselle» (AES-256-GCM, come i token di Costructo).
// Le password non tornano mai al browser e non finiscono mai nel registro.
// Ogni casella appartiene a UN'azienda (id dall'elenco delle aziende) oppure al «privato».
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Cifratore } from "../sicurezza/cifra.js";
import { leggiSegreto, salvaSegreto, maschera } from "../impostazioni.js";
import { controllaNomeServer } from "./rete.js";
import { ErrorePosta, type AziendaPosta, type Casella, type DipendenzePosta, type Server, type TipoCasella } from "./tipi.js";

export const MAX_CASELLE = 10;
export const PRIVATO = "privato";

/** Server già pronti: per Gmail e PEC Aruba Luigi non deve scrivere niente. */
export const PRESET: Record<Exclude<TipoCasella, "altro">, { imap: Server; smtp: Server }> = {
  gmail: { imap: { host: "imap.gmail.com", porta: 993 }, smtp: { host: "smtp.gmail.com", porta: 465 } },
  pec: { imap: { host: "imaps.pec.aruba.it", porta: 993 }, smtp: { host: "smtps.pec.aruba.it", porta: 465 } },
};

const SchemaServer = z.object({ host: z.string().min(1).max(253), porta: z.number().int().min(1).max(65535) });
const SchemaCasella = z.object({
  id: z.string().min(1).max(40),
  nome: z.string().min(1).max(60),
  tipo: z.enum(["pec", "gmail", "altro"]),
  spazio: z.string().min(1).max(40),
  imap: SchemaServer,
  smtp: SchemaServer.optional(),
  utente: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  confermeAutomatiche: z.boolean(),
});

/** Dati che arrivano dalle Impostazioni (aggiunta). */
export const SchemaNuovaCasella = z.object({
  nome: z.string().trim().min(1).max(60),
  tipo: z.enum(["pec", "gmail", "altro"]),
  spazio: z.string().trim().min(1).max(40),
  utente: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(500),
  imap: z.object({ host: z.string().max(253), porta: z.number().int().min(1).max(65535) }).optional(),
  smtp: z.object({ host: z.string().max(253), porta: z.number().int().min(1).max(65535) }).optional(),
  confermeAutomatiche: z.boolean().optional(),
}).strict();
/** Modifica: tutto facoltativo; la password vuota o assente non cambia. */
export const SchemaModificaCasella = SchemaNuovaCasella.partial().extend({ password: z.string().max(500).optional() }).strict();
export type NuovaCasella = z.infer<typeof SchemaNuovaCasella>;

export interface Fonte { db: Db; cifratore: Cifratore }

/** Nome pulito: niente caratteri di controllo né < >, al massimo 60 caratteri. */
const pulisciNome = (n: string) => n.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

// ---------------------------------------------------------------- lettura e scrittura del segreto
export function leggiCaselle(f: Fonte): Casella[] {
  const grezzo = leggiSegreto(f.db, f.cifratore, "posta_caselle");
  if (!grezzo) return [];
  let voci: unknown;
  try { voci = JSON.parse(grezzo); } catch { return []; }
  if (!Array.isArray(voci)) return [];
  const buone: Casella[] = [];
  for (const v of voci) {
    const ok = SchemaCasella.safeParse(v);
    if (ok.success && buone.length < MAX_CASELLE && !buone.some((b) => b.id === ok.data.id)) buone.push(ok.data);
  }
  return buone;
}
function salvaCaselle(f: Fonte, caselle: Casella[]): void {
  salvaSegreto(f.db, f.cifratore, "posta_caselle", caselle.length ? JSON.stringify(caselle) : "");
}
export function trovaCasella(f: Fonte, id: string): Casella | undefined {
  return leggiCaselle(f).find((c) => c.id === id);
}

// ---------------------------------------------------------------- per l'interfaccia (mai la password)
export interface StatoCasella { ultimoControllo: number; esito: string; messaggio: string }
export interface CasellaVisibile {
  id: string; nome: string; tipo: TipoCasella; spazio: string; nomeSpazio: string;
  imap: Server; smtp?: Server; utente: string; password: string; confermeAutomatiche: boolean; stato: StatoCasella;
}

export function nomeSpazio(spazio: string, aziende: AziendaPosta[]): string {
  if (spazio === PRIVATO) return "Privato";
  return aziende.find((a) => a.id === spazio)?.nome ?? "Azienda non più collegata";
}

export function statoCasella(db: Db, id: string): StatoCasella {
  const r = db.prepare("SELECT ultimo_controllo, esito, messaggio FROM posta_stato WHERE casella_id = ?").get(id) as { ultimo_controllo: number; esito: string; messaggio: string } | undefined;
  return { ultimoControllo: r?.ultimo_controllo ?? 0, esito: r?.esito ?? "", messaggio: r?.messaggio ?? "" };
}

export function caselleVisibili(f: Fonte, aziende: AziendaPosta[]): CasellaVisibile[] {
  return leggiCaselle(f).map((c) => ({
    id: c.id, nome: c.nome, tipo: c.tipo, spazio: c.spazio, nomeSpazio: nomeSpazio(c.spazio, aziende),
    imap: c.imap, ...(c.smtp ? { smtp: c.smtp } : {}), utente: c.utente, password: maschera(c.password),
    confermeAutomatiche: c.confermeAutomatiche, stato: statoCasella(f.db, c.id),
  }));
}

// ---------------------------------------------------------------- regole
/** Applica i server già pronti e le regole fisse (PEC: mai conferme automatiche). */
export function componiCasella(d: Omit<NuovaCasella, "password"> & { password: string }, id: string, aziende: AziendaPosta[]): Casella {
  const nome = pulisciNome(d.nome);
  if (!nome) throw new ErrorePosta("Scrivi un nome per la casella.");
  if (d.spazio !== PRIVATO && !aziende.some((a) => a.id === d.spazio)) {
    throw new ErrorePosta("Scegli a quale azienda appartiene la casella, oppure «Privato».");
  }
  const utente = d.utente.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(utente) && d.tipo !== "altro") throw new ErrorePosta("Scrivi l'indirizzo email completo della casella.");
  // Le password per le app di Google si copiano spesso con gli spazi («abcd efgh ijkl mnop»).
  const password = d.tipo === "gmail" ? d.password.replace(/\s+/g, "") : d.password;
  if (!password) throw new ErrorePosta("Scrivi la password.");
  let imap: Server, smtp: Server | undefined;
  if (d.tipo === "altro") {
    if (!d.imap?.host) throw new ErrorePosta("Scrivi il server della posta in arrivo (IMAP).");
    imap = { host: controllaNomeServer(d.imap.host), porta: d.imap.porta || 993 };
    smtp = d.smtp?.host ? { host: controllaNomeServer(d.smtp.host), porta: d.smtp.porta || 465 } : undefined;
  } else {
    ({ imap, smtp } = PRESET[d.tipo]);
  }
  // Mai conferme automatiche dalla PEC (valore legale); servono il server di uscita e una casella non PEC.
  const confermeAutomatiche = d.tipo !== "pec" && !!d.confermeAutomatiche;
  if (confermeAutomatiche && !smtp) throw new ErrorePosta("Per le conferme automatiche serve il server della posta in uscita (SMTP).");
  if (confermeAutomatiche && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(utente)) throw new ErrorePosta("Per le conferme automatiche il nome utente deve essere l'indirizzo email.");
  return { id, nome, tipo: d.tipo, spazio: d.spazio, imap: { ...imap }, ...(smtp ? { smtp: { ...smtp } } : {}), utente, password, confermeAutomatiche };
}

/**
 * Prova l'accesso: apre la Posta in arrivo in sola lettura e chiude. Gli errori sono già in italiano
 * (password sbagliata, Gmail vuole la password per le app, server non raggiungibile).
 */
export async function provaAccesso(dip: Pick<DipendenzePosta, "apriImap">, c: Casella): Promise<void> {
  const conn = await dip.apriImap(c);
  try { await conn.apriInbox(); } finally { await conn.chiudi().catch(() => {}); }
}

// ---------------------------------------------------------------- modifiche (da Impostazioni)
export async function aggiungiCasella(dip: DipendenzePosta, dati: NuovaCasella): Promise<Casella> {
  const f = { db: dip.db, cifratore: dip.cifratore };
  const prima = leggiCaselle(f);
  if (prima.length >= MAX_CASELLE) throw new ErrorePosta(`Puoi collegare al massimo ${MAX_CASELLE} caselle.`);
  const nuova = componiCasella(dati, `c${randomBytes(4).toString("hex")}`, dip.aziende());
  if (nuova.confermeAutomatiche) await dip.uscita.prova(nuova);
  await provaAccesso(dip, nuova);
  // Da qui niente attese: si rilegge l'elenco e si scrive (un'altra aggiunta in parallelo non va persa).
  const elenco = leggiCaselle(f);
  if (elenco.length >= MAX_CASELLE) throw new ErrorePosta(`Puoi collegare al massimo ${MAX_CASELLE} caselle.`);
  if (elenco.some((c) => c.utente.toLowerCase() === nuova.utente.toLowerCase() && c.imap.host === nuova.imap.host)) throw new ErrorePosta("Questa casella è già collegata.");
  if (elenco.some((c) => c.nome.toLowerCase() === nuova.nome.toLowerCase())) throw new ErrorePosta(`C'è già una casella che si chiama «${nuova.nome}».`);
  salvaCaselle(f, [...elenco, nuova]);
  return nuova;
}

export async function modificaCasella(dip: DipendenzePosta, id: string, modifiche: z.infer<typeof SchemaModificaCasella>): Promise<Casella> {
  const f = { db: dip.db, cifratore: dip.cifratore };
  const vecchia = trovaCasella(f, id);
  if (!vecchia) throw new ErrorePosta("Casella non trovata.", 404);
  const nuova = componiCasella({
    nome: modifiche.nome ?? vecchia.nome,
    tipo: modifiche.tipo ?? vecchia.tipo,
    spazio: modifiche.spazio ?? vecchia.spazio,
    utente: modifiche.utente ?? vecchia.utente,
    password: modifiche.password ? modifiche.password : vecchia.password,
    imap: modifiche.imap ?? vecchia.imap,
    smtp: modifiche.smtp ?? vecchia.smtp,
    confermeAutomatiche: modifiche.confermeAutomatiche ?? vecchia.confermeAutomatiche,
  }, id, dip.aziende());
  const accessoCambiato = nuova.utente !== vecchia.utente || nuova.password !== vecchia.password || nuova.tipo !== vecchia.tipo
    || nuova.imap.host !== vecchia.imap.host || nuova.imap.porta !== vecchia.imap.porta;
  if (accessoCambiato) await provaAccesso(dip, nuova);
  if (nuova.confermeAutomatiche && (!vecchia.confermeAutomatiche || accessoCambiato || nuova.smtp?.host !== vecchia.smtp?.host)) await dip.uscita.prova(nuova);
  const elenco = leggiCaselle(f);
  if (!elenco.some((c) => c.id === id)) throw new ErrorePosta("Casella non trovata.", 404);
  if (elenco.some((c) => c.id !== id && c.nome.toLowerCase() === nuova.nome.toLowerCase())) throw new ErrorePosta(`C'è già una casella che si chiama «${nuova.nome}».`);
  salvaCaselle(f, elenco.map((c) => (c.id === id ? nuova : c)));
  // Se cambia la casella (indirizzo o server), si ricomincia a leggere da capo; se cambia l'azienda, le mail già salvate la seguono.
  if (nuova.utente !== vecchia.utente || nuova.imap.host !== vecchia.imap.host) dip.db.prepare("DELETE FROM posta_stato WHERE casella_id = ?").run(id);
  if (nuova.spazio !== vecchia.spazio) dip.db.prepare("UPDATE posta_messaggi SET spazio = ? WHERE casella_id = ?").run(nuova.spazio, id);
  return nuova;
}

/** Scollega la casella da Jarvis: cancella la password e le mail che Jarvis aveva salvato (sul server non cambia niente). */
export function rimuoviCasella(f: Fonte, id: string): Casella {
  const elenco = leggiCaselle(f);
  const tolta = elenco.find((c) => c.id === id);
  if (!tolta) throw new ErrorePosta("Casella non trovata.", 404);
  salvaCaselle(f, elenco.filter((c) => c.id !== id));
  f.db.transaction(() => {
    f.db.prepare("DELETE FROM posta_messaggi WHERE casella_id = ?").run(id);
    f.db.prepare("DELETE FROM posta_bozze WHERE casella_id = ?").run(id);
    f.db.prepare("DELETE FROM posta_stato WHERE casella_id = ?").run(id);
  })();
  return tolta;
}
