// Forma dei webhook della WhatsApp Business Platform (Cloud API), letta con zod in modo TOLLERANTE:
// i campi sconosciuti si ignorano, un elemento non valido si scarta senza buttare gli altri.
// Campi seguiti dalla documentazione ufficiale di Meta (letta il 18/11/2026): messages (con statuses),
// smb_message_echoes, history, smb_app_state_sync, account_update. Utenti identificati da numero (wa_id)
// e/o da id utente (user_id, «BSUID»): il numero può mancare.
import { z } from "zod";

const testo = z.union([z.string(), z.number()]).transform(String);
const facoltativo = <T extends z.ZodTypeAny>(s: T) => s.optional().catch(undefined);

/** Un array in cui gli elementi non validi vengono scartati (gli altri restano). */
export function listaTollerante<T extends z.ZodTypeAny>(schema: T, massimo = 5000) {
  return z.unknown().transform((v): Array<z.infer<T>> => {
    if (!Array.isArray(v)) return [];
    return v.slice(0, massimo).map((x) => schema.safeParse(x)).filter((r) => r.success).map((r) => r.data as z.infer<T>);
  });
}

export const SchemaMedia = z.object({
  id: facoltativo(testo),
  mime_type: facoltativo(z.string().max(200)),
  filename: facoltativo(z.string().max(500)),
  caption: facoltativo(z.string().max(10_000)),
  sha256: facoltativo(z.string().max(200)),
  voice: facoltativo(z.boolean()),
}).passthrough();

const SchemaContattoProfilo = z.object({
  wa_id: facoltativo(testo),
  user_id: facoltativo(z.string().max(200)),
  profile: facoltativo(z.object({ name: facoltativo(z.string().max(500)), username: facoltativo(z.string().max(200)) }).passthrough()),
}).passthrough();

export const SchemaMessaggio = z.object({
  id: z.string().min(1).max(300),
  from: facoltativo(testo),
  from_user_id: facoltativo(z.string().max(200)),
  to: facoltativo(testo),
  to_user_id: facoltativo(z.string().max(200)),
  group_id: facoltativo(z.string().max(300)),
  timestamp: facoltativo(testo),
  type: z.string().max(40).catch("sconosciuto"),
  text: facoltativo(z.object({ body: facoltativo(z.string()) }).passthrough()),
  image: facoltativo(SchemaMedia),
  document: facoltativo(SchemaMedia),
  audio: facoltativo(SchemaMedia),
  video: facoltativo(SchemaMedia),
  sticker: facoltativo(SchemaMedia),
  location: facoltativo(z.object({
    latitude: facoltativo(z.number()), longitude: facoltativo(z.number()), name: facoltativo(z.string().max(500)), address: facoltativo(z.string().max(1000)),
  }).passthrough()),
  contacts: facoltativo(z.array(z.object({
    name: facoltativo(z.object({ formatted_name: facoltativo(z.string().max(300)) }).passthrough()),
    phones: facoltativo(z.array(z.object({ phone: facoltativo(z.string().max(60)), wa_id: facoltativo(testo) }).passthrough()).max(20)),
  }).passthrough()).max(20)),
  reaction: facoltativo(z.object({ message_id: facoltativo(z.string().max(300)), emoji: facoltativo(z.string().max(40)) }).passthrough()),
  interactive: facoltativo(z.object({
    type: facoltativo(z.string().max(40)),
    button_reply: facoltativo(z.object({ id: facoltativo(z.string().max(300)), title: facoltativo(z.string().max(300)) }).passthrough()),
    list_reply: facoltativo(z.object({ id: facoltativo(z.string().max(300)), title: facoltativo(z.string().max(300)), description: facoltativo(z.string().max(1000)) }).passthrough()),
  }).passthrough()),
  button: facoltativo(z.object({ text: facoltativo(z.string().max(300)), payload: facoltativo(z.string().max(300)) }).passthrough()),
  edit: facoltativo(z.object({ original_message_id: facoltativo(z.string().max(300)), message: facoltativo(z.record(z.unknown())) }).passthrough()),
  revoke: facoltativo(z.object({ original_message_id: facoltativo(z.string().max(300)) }).passthrough()),
  history_context: facoltativo(z.object({ status: facoltativo(z.string().max(40)) }).passthrough()),
}).passthrough();
export type MessaggioWebhook = z.infer<typeof SchemaMessaggio>;

export const SchemaStato = z.object({
  id: z.string().min(1).max(300),
  status: z.string().max(40),
  timestamp: facoltativo(testo),
  recipient_id: facoltativo(testo),
  errors: facoltativo(z.array(z.object({
    code: facoltativo(z.number()), title: facoltativo(z.string().max(500)), message: facoltativo(z.string().max(500)),
    error_data: facoltativo(z.object({ details: facoltativo(z.string().max(1000)) }).passthrough()),
  }).passthrough()).max(10)),
}).passthrough();
export type StatoWebhook = z.infer<typeof SchemaStato>;

const SchemaMetadati = z.object({
  display_phone_number: facoltativo(testo),
  phone_number_id: facoltativo(testo),
}).passthrough();

export const SchemaValore = z.object({
  metadata: facoltativo(SchemaMetadati),
  contacts: listaTollerante(SchemaContattoProfilo, 1000),
  messages: listaTollerante(SchemaMessaggio),
  statuses: listaTollerante(SchemaStato),
  message_echoes: listaTollerante(SchemaMessaggio),
  history: listaTollerante(z.object({
    metadata: facoltativo(z.object({ phase: facoltativo(z.number()), chunk_order: facoltativo(z.number()), progress: facoltativo(z.number()) }).passthrough()),
    threads: listaTollerante(z.object({
      id: facoltativo(testo),
      context: facoltativo(z.object({ wa_id: facoltativo(testo), user_id: facoltativo(z.string().max(200)), username: facoltativo(z.string().max(200)) }).passthrough()),
      messages: listaTollerante(SchemaMessaggio, 20_000),
    }).passthrough(), 5000),
    errors: facoltativo(z.array(z.object({ code: facoltativo(z.number()), message: facoltativo(z.string().max(500)) }).passthrough()).max(10)),
  }).passthrough(), 100),
  state_sync: listaTollerante(z.object({
    type: facoltativo(z.string().max(40)),
    action: facoltativo(z.string().max(40)),
    contact: facoltativo(z.object({
      full_name: facoltativo(z.string().max(500)), first_name: facoltativo(z.string().max(500)),
      phone_number: facoltativo(testo), user_id: facoltativo(z.string().max(200)),
    }).passthrough()),
  }).passthrough(), 20_000),
}).passthrough();
export type ValoreWebhook = z.infer<typeof SchemaValore>;

/** Il corpo del webhook: object + entry[].changes[] {field, value}. */
export const SchemaWebhook = z.object({
  object: z.string().max(100),
  entry: listaTollerante(z.object({
    id: facoltativo(testo),
    changes: listaTollerante(z.object({ field: z.string().max(100), value: z.unknown() }).passthrough(), 1000),
  }).passthrough(), 1000),
}).passthrough();
