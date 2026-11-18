// Proposte per Costructo (Fase 3b). Regola di Luigi: Jarvis NON copia quello che fa già Costructo e NON scrive mai record
// definitivi. Quello che arriva da WhatsApp (o dalla posta, o da Luigi a voce) diventa una PROPOSTA dentro Costructo, che
// Luigi approva là. Mandare una proposta è comunque una scrittura FUORI da Jarvis: serve la conferma di Luigi in Jarvis
// (un tocco, oppure «manda le 3 proposte» con ognuna elencata per intero), salvo gli interruttori «proponi in automatico»
// per tipo, spenti di serie.
// Qui: i tipi, la forma dei «dati» di ogni tipo (contratto con Costructo, controllata con zod prima di ogni invio)
// e i campi che Luigi può correggere nella pagina Proposte.
import { z } from "zod";

/** Tipi che vanno a Costructo (contratto POST /api/assistente/v1/proposte). */
export const TIPI_COSTRUCTO = ["ore", "foto", "rinnovo_documento", "carico_magazzino", "richiesta_lavoro", "agenda", "contatto", "documento_fornitore", "diario", "invio_documenti"] as const;
export type TipoCostructo = (typeof TIPI_COSTRUCTO)[number];
/** Tipi che restano in Jarvis (vita privata: agenda privata con la conferma di Luigi). */
export const TIPI_LOCALI = ["agenda_privata"] as const;
export type TipoProposta = TipoCostructo | (typeof TIPI_LOCALI)[number];
export const PRIVATO = "privato";

export const NOMI_TIPI: Record<TipoProposta, string> = {
  ore: "Ore (rapportino)",
  foto: "Foto di cantiere",
  rinnovo_documento: "Rinnovo documento",
  carico_magazzino: "Carico di magazzino",
  richiesta_lavoro: "Nuova richiesta di lavoro",
  agenda: "Appuntamento in agenda",
  contatto: "Telefono di una controparte",
  documento_fornitore: "Documento di un fornitore",
  diario: "Diario di cantiere",
  invio_documenti: "Invio di documenti",
  agenda_privata: "Promemoria privato (agenda di Jarvis)",
};

/** Allegati: al massimo 5, al massimo 10 MB l'uno, solo questi formati. */
export const MAX_ALLEGATI = 5;
export const MAX_BYTE_ALLEGATO = 10 * 1024 * 1024;
export const MIME_ALLEGATI = ["image/jpeg", "image/png", "image/heic", "image/webp", "application/pdf"] as const;
export const MAX_TITOLO = 140;
export const MAX_CHIAVE = 120;

const id = z.union([z.string().trim().min(1).max(80), z.number().int().nonnegative()]).transform(String);
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data nel formato AAAA-MM-GG");
const ora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "ora nel formato HH:MM");
const breve = (n: number) => z.string().trim().min(1).max(n);
const facoltativo = (n: number) => z.string().trim().max(n).optional();

/** La forma dei «dati» per ogni tipo. `.strict()`: niente campi in più verso Costructo. */
export const SCHEMI_DATI: Record<TipoProposta, z.ZodTypeAny> = {
  ore: z.object({ operaioId: id, cantiereId: id, data, ore: z.number().gt(0).max(24), oreEconomia: z.number().min(0).max(24).optional(), descrizione: facoltativo(500) }).strict(),
  foto: z.object({ cantiereId: id, data: data.optional(), tipo: z.enum(["fatto", "problema"]), descrizione: facoltativo(500) }).strict(),
  rinnovo_documento: z.object({ voceId: id.optional(), ditta: facoltativo(140), tipoDocumento: breve(80), dataScadenza: data }).strict()
    .refine((d) => !!d.voceId || !!d.ditta, "serve la voce del documento o il nome della ditta"),
  carico_magazzino: z.object({
    cantiereId: id.optional(),
    righe: z.array(z.object({ descrizione: breve(200), quantita: z.number().gt(0).max(1_000_000), unita: breve(20), oggettoId: id.optional() }).strict()).min(1).max(100),
  }).strict(),
  richiesta_lavoro: z.object({
    nome: breve(140), telefono: facoltativo(30), email: z.string().trim().email().max(200).optional(), indirizzo: facoltativo(300), descrizione: breve(2000),
    sopralluogo: z.object({ data, ora }).strict().optional(),
  }).strict(),
  agenda: z.object({ data, ora: ora.optional(), titolo: breve(MAX_TITOLO), descrizione: facoltativo(1000), cantiereId: id.optional() }).strict(),
  contatto: z.object({ controparteId: id, telefono: z.string().regex(/^\+?\d{8,15}$/, "numero di telefono") }).strict(),
  documento_fornitore: z.object({
    fornitore: breve(140), piva: z.string().regex(/^\d{11}$/).optional(), numero: facoltativo(40), data: data.optional(), importo: z.number().finite().optional(),
    tipo: z.enum(["preventivo", "fattura"]),
  }).strict(),
  diario: z.object({ cantiereId: id, data, testo: breve(4000) }).strict(),
  invio_documenti: z.object({ voceIds: z.array(id).min(1).max(10), destinatario: breve(200) }).strict(),
  agenda_privata: z.object({ titolo: breve(MAX_TITOLO), data, ora: ora.optional() }).strict(),
};

/** Tipi che hanno bisogno di allegati (e di quali). */
export const ALLEGATI_RICHIESTI: Partial<Record<TipoProposta, "immagini" | "pdf">> = { foto: "immagini", rinnovo_documento: "pdf", documento_fornitore: "pdf" };

export type TipoCampo = "testo" | "testo_lungo" | "numero" | "data" | "ora" | "cantiere" | "operaio" | "scelta" | "righe" | "sola_lettura";
export interface Campo { chiave: string; etichetta: string; tipo: TipoCampo; obbligatorio?: boolean; opzioni?: string[] }

/** I campi che Luigi vede (e può correggere) prima di confermare. */
export const CAMPI: Record<TipoProposta, Campo[]> = {
  ore: [
    { chiave: "operaioId", etichetta: "Operaio", tipo: "operaio", obbligatorio: true },
    { chiave: "cantiereId", etichetta: "Cantiere", tipo: "cantiere", obbligatorio: true },
    { chiave: "data", etichetta: "Giorno", tipo: "data", obbligatorio: true },
    { chiave: "ore", etichetta: "Ore", tipo: "numero", obbligatorio: true },
    { chiave: "oreEconomia", etichetta: "Di cui in economia", tipo: "numero" },
    { chiave: "descrizione", etichetta: "Descrizione", tipo: "testo" },
  ],
  foto: [
    { chiave: "cantiereId", etichetta: "Cantiere", tipo: "cantiere", obbligatorio: true },
    { chiave: "data", etichetta: "Giorno", tipo: "data" },
    { chiave: "tipo", etichetta: "Che cosa mostra", tipo: "scelta", obbligatorio: true, opzioni: ["fatto", "problema"] },
    { chiave: "descrizione", etichetta: "Descrizione", tipo: "testo" },
  ],
  rinnovo_documento: [
    { chiave: "voceId", etichetta: "Voce in Costructo", tipo: "sola_lettura" },
    { chiave: "ditta", etichetta: "Ditta", tipo: "testo" },
    { chiave: "tipoDocumento", etichetta: "Documento", tipo: "testo", obbligatorio: true },
    { chiave: "dataScadenza", etichetta: "Nuova scadenza", tipo: "data", obbligatorio: true },
  ],
  carico_magazzino: [
    { chiave: "cantiereId", etichetta: "Cantiere", tipo: "cantiere" },
    { chiave: "righe", etichetta: "Righe (una per riga: quantità unità descrizione)", tipo: "righe", obbligatorio: true },
  ],
  richiesta_lavoro: [
    { chiave: "nome", etichetta: "Nome", tipo: "testo", obbligatorio: true },
    { chiave: "telefono", etichetta: "Telefono", tipo: "testo" },
    { chiave: "email", etichetta: "Email", tipo: "testo" },
    { chiave: "indirizzo", etichetta: "Indirizzo", tipo: "testo" },
    { chiave: "descrizione", etichetta: "Che lavoro chiede", tipo: "testo_lungo", obbligatorio: true },
  ],
  agenda: [
    { chiave: "data", etichetta: "Giorno", tipo: "data", obbligatorio: true },
    { chiave: "ora", etichetta: "Ora", tipo: "ora" },
    { chiave: "titolo", etichetta: "Titolo", tipo: "testo", obbligatorio: true },
    { chiave: "descrizione", etichetta: "Descrizione", tipo: "testo" },
    { chiave: "cantiereId", etichetta: "Cantiere", tipo: "cantiere" },
  ],
  contatto: [
    { chiave: "controparteId", etichetta: "Controparte", tipo: "sola_lettura", obbligatorio: true },
    { chiave: "telefono", etichetta: "Telefono da aggiungere", tipo: "sola_lettura", obbligatorio: true },
  ],
  documento_fornitore: [
    { chiave: "fornitore", etichetta: "Fornitore", tipo: "testo", obbligatorio: true },
    { chiave: "tipo", etichetta: "Tipo", tipo: "scelta", obbligatorio: true, opzioni: ["preventivo", "fattura"] },
    { chiave: "numero", etichetta: "Numero", tipo: "testo" },
    { chiave: "data", etichetta: "Data", tipo: "data" },
    { chiave: "piva", etichetta: "Partita IVA", tipo: "testo" },
    { chiave: "importo", etichetta: "Importo (solo se scritto nel messaggio)", tipo: "numero" },
  ],
  diario: [
    { chiave: "cantiereId", etichetta: "Cantiere", tipo: "cantiere", obbligatorio: true },
    { chiave: "data", etichetta: "Giorno", tipo: "data", obbligatorio: true },
    { chiave: "testo", etichetta: "Testo del diario", tipo: "testo_lungo", obbligatorio: true },
  ],
  invio_documenti: [
    { chiave: "voceIds", etichetta: "Documenti", tipo: "sola_lettura", obbligatorio: true },
    { chiave: "destinatario", etichetta: "Destinatario", tipo: "sola_lettura", obbligatorio: true },
  ],
  agenda_privata: [
    { chiave: "titolo", etichetta: "Promemoria", tipo: "testo", obbligatorio: true },
    { chiave: "data", etichetta: "Giorno", tipo: "data", obbligatorio: true },
    { chiave: "ora", etichetta: "Ora (vuota = tutto il giorno)", tipo: "ora" },
  ],
};

export type StatoProposta = "da_confermare" | "in_invio" | "inviata" | "gia_presente" | "attesa_costructo" | "errore" | "scartata";

export interface RiferimentoAllegato { allegatoId: string; nome: string; mime: string; dimensione: number; sha256: string }

export interface RigaProposta {
  id: string;
  tipo: TipoProposta;
  azienda_id: string;
  chiave_doppione: string;
  origine: "whatsapp" | "email" | "jarvis";
  rif_esterno: string;
  titolo: string;
  dati: string;
  allegati: string;
  avvisi: string;
  contatto_id: string;
  messaggio_id: string;
  stato: StatoProposta;
  esito: string;
  id_costructo: string;
  stato_costructo: string;
  motivo_costructo: string;
  deciso_il: string;
  automatica: number;
  creata: number;
  aggiornata: number;
  inviata: number;
}

export class ErroreProposte extends Error {
  constructor(messaggio: string, readonly stato = 400) { super(messaggio); }
}

export const IN_ATTESA_COSTRUCTO = "In attesa della pagina Proposte in Costructo: la proposta resta qui in Jarvis e la puoi rimandare dopo.";
export const GIA_PRESENTE = "già presente in Costructo";

export const tipoValido = (t: string): t is TipoProposta => t in SCHEMI_DATI;
export const vaACostructo = (t: string): t is TipoCostructo => (TIPI_COSTRUCTO as readonly string[]).includes(t);
