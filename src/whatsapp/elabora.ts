// Elaborazione di un webhook già controllato (firma valida): salva contatti e messaggi, aggiorna gli stati
// dei messaggi mandati da Jarvis, importa lo storico, aggiorna i nomi della rubrica.
// Qui non si chiama l'AI e non si manda niente: classificazione, domande, conferme e notifiche le fa il giro (servizio.ts).
import type { Db } from "../db.js";
import { CONSERVAZIONE_MS } from "../conversazioni.js";
import { registra } from "../registro.js";
import { SchemaValore, type MessaggioWebhook, type StatoWebhook, type ValoreWebhook } from "./schema.js";
import { salvaContatto, salvaMessaggio } from "./archivio.js";
import { normalizzaTelefono, pulisciNome, testoBreve, mascheraTelefono } from "./telefono.js";
import type { MediaWa } from "./tipi.js";
import { POSIZIONE_OPERAIO } from "../funzioni/operai.js";

export interface EsitoElaborazione { nuovi: number; doppi: number; storico: number; eco: number; stati: number; contatti: number; ignorati: number }

const TIPI_MEDIA = ["image", "document", "audio", "video", "sticker"] as const;
const NOMI_TIPO: Record<string, string> = { image: "foto", document: "documento", audio: "audio", video: "video", sticker: "adesivo" };

/** Orario del messaggio (secondi Unix di WhatsApp); se manca o è assurdo, l'ora di arrivo. */
function orario(ts: string | undefined, ora: number): number {
  const s = Number(ts);
  if (!Number.isFinite(s) || s <= 0) return ora;
  const ms = s * 1000;
  return ms > ora + 3600_000 ? ora : ms;
}

/** Testo leggibile e dati dell'allegato di un messaggio (mai il contenuto del file: niente scaricamenti). */
export function contenuto(m: MessaggioWebhook): { tipo: string; testo: string; media?: MediaWa } {
  const tipo = m.type;
  for (const t of TIPI_MEDIA) {
    const x = m[t];
    if (tipo === t || (x && tipo === "sconosciuto")) {
      const media: MediaWa = { tipo: t, ...(x?.mime_type ? { mime: x.mime_type.slice(0, 100) } : {}), ...(x?.filename ? { nomeFile: pulisciNome(x.filename).slice(0, 200) } : {}),
        ...(x?.caption ? { didascalia: testoBreve(x.caption, 1024) } : {}), ...(x?.id ? { idMedia: String(x.id).slice(0, 100) } : {}) };
      return { tipo: t, testo: testoBreve(x?.caption ?? ""), media };
    }
  }
  switch (tipo) {
    case "text": return { tipo, testo: testoBreve(m.text?.body ?? "") };
    case "location": {
      const l = m.location ?? {};
      const dove = [l.name, l.address].filter(Boolean).join(", ");
      // Fase 3b: le coordinate servono a trovare il cantiere più vicino (mai per gli operai: vedi salvaUno).
      const coordinate = typeof l.latitude === "number" && typeof l.longitude === "number" && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180
        ? { lat: l.latitude, lon: l.longitude } : null;
      return { tipo, testo: testoBreve(`Posizione: ${dove || `${l.latitude ?? "?"}, ${l.longitude ?? "?"}`}`), ...(coordinate ? { media: { ...coordinate, ...(dove ? { didascalia: testoBreve(dove, 300) } : {}) } } : {}) };
    }
    case "contacts": {
      // Dei contatti condivisi si tiene solo il nome (i numeri di altre persone non servono a Jarvis).
      const nomi = (m.contacts ?? []).map((c) => pulisciNome(c.name?.formatted_name)).filter(Boolean);
      return { tipo, testo: testoBreve(`Contatto condiviso: ${nomi.join(", ") || "senza nome"}`) };
    }
    case "reaction": return { tipo, testo: testoBreve(m.reaction?.emoji ? `Reazione ${m.reaction.emoji}` : "Reazione tolta") };
    case "interactive": {
      const i = m.interactive ?? {};
      const scelta = i.button_reply?.title || i.list_reply?.title || "";
      return { tipo, testo: testoBreve(`Risposta: ${scelta}${i.list_reply?.description ? ` (${i.list_reply.description})` : ""}`) };
    }
    case "button": return { tipo, testo: testoBreve(`Risposta: ${m.button?.text ?? ""}`) };
    case "media_placeholder": return { tipo, testo: "Allegato (contenuto non ancora arrivato)" };
    case "unsupported": return { tipo, testo: "Messaggio che WhatsApp non passa a Jarvis: guardalo sul telefono." };
    default: return { tipo: tipo.slice(0, 30), testo: m.text?.body ? testoBreve(m.text.body) : `Messaggio di tipo «${tipo.slice(0, 30)}»` };
  }
}

/**
 * Chi ha scritto un messaggio dello storico: si guarda il MITTENTE, non se c'è il numero del contatto
 * (nelle chat con un nome utente WhatsApp il numero può mancare).
 *  - c'è l'id utente del mittente (from_user_id) → l'ha scritto il contatto;
 *  - il mittente è il numero dell'azienda, oppure c'è un destinatario (to / to_user_id) → l'ha scritto Luigi;
 *  - il mittente è il numero del contatto della chat → il contatto; un altro numero (azienda non nota) → Luigi.
 */
export function direzioneStorico(m: MessaggioWebhook, numeroAzienda: string, waIdChat?: string): "in" | "eco" {
  if (m.from_user_id) return "in";
  const da = normalizzaTelefono(m.from);
  if (numeroAzienda && da === numeroAzienda) return "eco";
  if (m.to || m.to_user_id) return "eco";
  const contatto = normalizzaTelefono(waIdChat);
  if (da && contatto) return da === contatto ? "in" : "eco";
  if (da && numeroAzienda) return "in";
  return "in";
}

interface Contesto { db: Db; ora: number; numeroAzienda: string; nomi: Map<string, string>; esito: EsitoElaborazione }

/** Applica una modifica o una cancellazione (edit, revoke) al messaggio originale, se c'è. */
function modificaORevoca(c: Contesto, m: MessaggioWebhook): boolean {
  if (m.type === "revoke" && m.revoke?.original_message_id) {
    c.db.prepare("UPDATE wa_messaggi SET revocato = 1, testo = 'Messaggio cancellato', media = '{}' WHERE wamid = ?").run(m.revoke.original_message_id);
    return true;
  }
  if (m.type === "edit" && m.edit?.original_message_id) {
    const interno = m.edit.message ?? {};
    const tipo = typeof interno.type === "string" ? interno.type : "text";
    const nuovo = contenuto({ ...(interno as object), id: m.edit.original_message_id, type: tipo } as MessaggioWebhook);
    c.db.prepare("UPDATE wa_messaggi SET testo = ? WHERE wamid = ?").run(testoBreve(`${nuovo.testo} (modificato)`), m.edit.original_message_id);
    return true;
  }
  return false;
}

function salvaUno(c: Contesto, m: MessaggioWebhook, opz: { direzione: "in" | "eco"; storico: boolean; waId?: string; userId?: string }) {
  if (modificaORevoca(c, m)) return;
  const quando = orario(m.timestamp, c.ora);
  // Storico più vecchio di 30 giorni: non si salva nemmeno (si cancellerebbe subito).
  if (opz.storico && quando < c.ora - CONSERVAZIONE_MS) { c.esito.ignorati++; return; }
  const gruppoId = m.group_id ? String(m.group_id).slice(0, 200) : undefined;
  const waId = normalizzaTelefono(opz.waId) ?? undefined;
  const userId = opz.userId ? String(opz.userId).slice(0, 200) : undefined;
  const nomeProfilo = waId ? c.nomi.get(waId) : userId ? c.nomi.get(`u:${userId}`) : undefined;
  const contatto = salvaContatto(c.db, gruppoId ? { gruppoId } : { waId, userId, nomeProfilo }, c.ora);
  if (!contatto) { c.esito.ignorati++; return; }
  let x = contenuto(m);
  // GDPR (Fase 3b): la posizione di un operaio non si salva mai (né le coordinate né l'indirizzo).
  if (x.tipo === "location" && !gruppoId && (c.db.prepare("SELECT 1 FROM wa_operai WHERE contatto_id = ? AND operaio_id <> ''").get(contatto.id))) {
    x = { tipo: "location", testo: POSIZIONE_OPERAIO };
  }
  // Nei gruppi si tiene il nome di chi scrive davanti al testo (il «contatto» è il gruppo).
  const testo = gruppoId && opz.direzione === "in" ? testoBreve(`${nomeProfilo || (waId ? `Numero ${mascheraTelefono(waId)}` : "Qualcuno")}: ${x.testo}`) : x.testo;
  // Classificazione solo per i messaggi ricevuti dal vivo, fuori dai gruppi, con un contenuto (non reazioni).
  const daClassificare = opz.direzione === "in" && !opz.storico && x.tipo !== "reaction";
  const id = salvaMessaggio(c.db, {
    wamid: m.id, contattoId: contatto.id, gruppoId, direzione: opz.direzione, tipo: x.tipo, quando, testo, media: x.media,
    storico: opz.storico, stato: daClassificare ? "da_classificare" : "nessuno",
  }, c.ora);
  if (!id) {
    // Già visto: se era un segnaposto dello storico, ora arriva il contenuto dell'allegato.
    if (opz.storico && x.media) c.db.prepare("UPDATE wa_messaggi SET tipo = ?, testo = ?, media = ? WHERE wamid = ? AND tipo = 'media_placeholder'").run(x.tipo, x.testo, JSON.stringify(x.media), m.id);
    c.esito.doppi++;
    return;
  }
  if (opz.storico) c.esito.storico++;
  else if (opz.direzione === "eco") c.esito.eco++;
  else c.esito.nuovi++;
}

/** Stati dei messaggi mandati da Jarvis (sent, delivered, read, failed). Gli altri si ignorano. */
function aggiornaStato(c: Contesto, s: StatoWebhook) {
  const stato = s.status.toLowerCase();
  if (!["sent", "delivered", "read", "failed"].includes(stato)) return;
  const errore = stato === "failed" ? spiegaErroreMeta(s.errors?.[0]?.code, s.errors?.[0]?.title || s.errors?.[0]?.message) : "";
  // L'ordine degli stati non è garantito: «read» non torna indietro a «delivered».
  const ordine = "CASE stato_invio WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END";
  const peso = { sent: 1, delivered: 2, read: 3, failed: 4 }[stato as "sent"]!;
  const r = c.db.prepare(`UPDATE wa_messaggi SET stato_invio = ?, errore_invio = ? WHERE wamid = ? AND direzione = 'out' AND (${ordine} < ? OR ? = 4)`).run(stato, errore, s.id, peso, peso);
  c.db.prepare("UPDATE wa_risposte SET esito = ?, stato = CASE WHEN ? = 'failed' THEN 'errore' ELSE stato END WHERE wamid = ?").run(stato === "failed" ? errore : stato, stato, s.id);
  if (r.changes) c.esito.stati++;
}

/** Errori di WhatsApp spiegati in italiano semplice. */
export function spiegaErroreMeta(codice: number | undefined, testo?: string): string {
  const noti: Record<number, string> = {
    131047: "sono passate più di 24 ore dall'ultimo messaggio del contatto: serve un modello approvato da Meta",
    131026: "il messaggio non si può consegnare a questo numero (forse non usa WhatsApp)",
    131051: "tipo di messaggio non supportato",
    131056: "troppi messaggi allo stesso contatto in poco tempo: riprova più tardi",
    130429: "troppi messaggi in poco tempo: riprova più tardi",
    131048: "limite di invio raggiunto per la qualità del numero",
    131030: "numero non ammesso (account di prova di Meta)",
    190: "il token di accesso non è valido o è scaduto",
    10: "permesso mancante per questo numero",
    100: "dati del messaggio non validi",
    131000: "errore di WhatsApp: riprova più tardi",
  };
  if (codice !== undefined && noti[codice]) return `WhatsApp: ${noti[codice]}.`;
  return `WhatsApp non ha consegnato il messaggio${codice !== undefined ? ` (codice ${codice})` : ""}${testo ? `: ${String(testo).slice(0, 120)}` : ""}.`;
}

/**
 * Elabora un webhook (corpo già validato da SchemaWebhook). `numeroAzienda` = phone_number_id configurato:
 * i cambiamenti di un altro numero si ignorano.
 */
export function elaboraWebhook(db: Db, corpo: { object: string; entry: Array<{ changes: Array<{ field: string; value?: unknown }> }> }, phoneNumberId: string, ora = Date.now()): EsitoElaborazione {
  const esito: EsitoElaborazione = { nuovi: 0, doppi: 0, storico: 0, eco: 0, stati: 0, contatti: 0, ignorati: 0 };
  if (corpo.object !== "whatsapp_business_account") { esito.ignorati++; return esito; }
  db.transaction(() => {
    for (const e of corpo.entry) for (const ch of e.changes) {
      const v = SchemaValore.safeParse(ch.value ?? {});
      if (!v.success) { esito.ignorati++; continue; }
      const val: ValoreWebhook = v.data;
      const pid = val.metadata?.phone_number_id ? String(val.metadata.phone_number_id) : "";
      if (phoneNumberId && pid && pid !== phoneNumberId) { esito.ignorati++; continue; }
      const numeroAzienda = normalizzaTelefono(val.metadata?.display_phone_number) ?? "";
      const nomi = new Map<string, string>();
      for (const k of val.contacts) {
        const nome = pulisciNome(k.profile?.name);
        if (!nome) continue;
        const w = normalizzaTelefono(k.wa_id);
        if (w) nomi.set(w, nome);
        if (k.user_id) nomi.set(`u:${k.user_id}`, nome);
      }
      const c: Contesto = { db, ora, numeroAzienda, nomi, esito };
      switch (ch.field) {
        case "messages":
          for (const m of val.messages) salvaUno(c, m, { direzione: "in", storico: false, waId: m.from, userId: m.from_user_id });
          for (const s of val.statuses) aggiornaStato(c, s);
          break;
        case "smb_message_echoes":
          // Luigi ha scritto dal telefono (app WhatsApp Business): la chat risulta «risposta».
          for (const m of val.message_echoes) salvaUno(c, m, { direzione: "eco", storico: false, waId: m.to, userId: m.to_user_id });
          break;
        case "history":
          for (const h of val.history) {
            if (h.errors?.length) registra(db, "whatsapp.storico", "errore", "sistema", { motivo: "lo storico delle chat non è stato condiviso dall'app WhatsApp Business", codice: h.errors[0].code });
            for (const t of h.threads) {
              const waId = t.context?.wa_id ?? t.id;
              for (const m of t.messages) {
                // Scritto dall'azienda (da Luigi): il mittente è il numero dell'azienda, oppure non è il contatto della chat.
                salvaUno(c, m, { direzione: direzioneStorico(m, numeroAzienda, waId), storico: true, waId, userId: t.context?.user_id });
              }
            }
          }
          // Contenuto degli allegati dello storico: arriva come «messages» dentro il campo history.
          for (const m of val.messages) {
            const daAzienda = direzioneStorico(m, numeroAzienda) === "eco";
            salvaUno(c, m, { direzione: daAzienda ? "eco" : "in", storico: true, waId: daAzienda ? m.to : m.from, userId: daAzienda ? m.to_user_id : m.from_user_id });
          }
          for (const m of val.message_echoes) salvaUno(c, m, { direzione: "eco", storico: true, waId: m.to, userId: m.to_user_id });
          break;
        case "smb_app_state_sync":
          for (const s of val.state_sync) {
            if (s.type && s.type !== "contact") continue;
            const k = s.contact ?? {};
            const waId = normalizzaTelefono(k.phone_number) ?? undefined;
            if (!waId && !k.user_id) continue;
            const rimuovi = s.action === "remove";
            const nome = pulisciNome(k.full_name || k.first_name);
            // Si aggiornano i nomi solo dei contatti con cui c'è (o ci sarà) una chat: niente copia della rubrica.
            const esiste = db.prepare("SELECT id FROM wa_contatti WHERE chiave = ? OR (user_id <> '' AND user_id = ?)").get(waId ?? "", k.user_id ?? "") as { id: string } | undefined;
            if (!esiste) continue;
            salvaContatto(db, { waId, userId: k.user_id, nomeRubrica: rimuovi ? null : nome }, ora);
            esito.contatti++;
          }
          break;
        case "account_update":
          registra(db, "whatsapp.account", "fatto", "sistema", { evento: String((ch.value as { event?: unknown })?.event ?? "").slice(0, 60) });
          break;
        default:
          esito.ignorati++;
      }
      // Nomi dal profilo per i contatti già noti (anche senza messaggi nuovi).
      for (const [chiave, nome] of nomi) {
        db.prepare("UPDATE wa_contatti SET nome_profilo = ? WHERE (chiave = ? OR ('u:' || user_id) = ?) AND nome_profilo <> ?").run(nome, chiave, chiave, nome);
      }
    }
  })();
  return esito;
}
