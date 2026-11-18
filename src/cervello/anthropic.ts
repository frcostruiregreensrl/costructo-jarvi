// Cervello Claude (Anthropic). ATTENZIONE: usa il pacchetto @anthropic-ai/sdk, che NON è ancora
// installato (serve l'autorizzazione di Luigi). Per questo il file è escluso dal controllo dei tipi
// (tsconfig.json) ed è caricato solo con import dinamico da carica.ts.
//
// Scelte (documentazione ufficiale dell'SDK TypeScript):
// - client.messages.stream() + finalMessage(): il testo arriva a pezzi e Jarvis lo legge a voce mentre arriva;
// - modello predefinito claude-haiku-5-5 (claude-sonnet-5-5 solo quando Luigi dice «pensaci bene»);
// - output_config.effort per regolare il ragionamento (Haiku 5.5 ragiona in modo adattivo di serie);
// - strumenti con strict:true e tool_choice "auto" (la scelta forzata non è supportata dai modelli nuovi);
// - eager_input_streaming lasciato SPENTO: gli input degli strumenti sono piccoli e così il server
//   continua a validarli contro lo schema (in più assistente.ts li rivalida con zod);
// - stop_reason "refusal" gestito (il contenuto non viene usato), "max_tokens" segnalato;
// - prompt caching del prompt di sistema (cache_control ephemeral sull'ultimo blocco di sistema);
// - per Sonnet 5.5 il ripiego lato server sui rifiuti (beta "server-side-fallback-2026-07-01",
//   fallbacks: "default"): il server sceglie il modello di riserva in base al tipo di rifiuto.
//   Haiku 5.5 non ha ripiego lato server: il rifiuto resta un rifiuto;
// - risposta interrotta (stop, nuova domanda, rete, tempo): si lancia PassoInterrotto con il consumo
//   noto fino a lì (stream.currentMessage.usage), così assistente.ts lo registra comunque;
// - consumo diviso per modello quando ha lavorato anche il modello di riserva (usage.iterations).
import Anthropic from "@anthropic-ai/sdk";
import type { Cervello, MessaggioCervello, RichiestaPasso, RispostaPasso, MotivoFine, UsoToken } from "./tipi.js";
import { CervelloNonDisponibile, PassoInterrotto } from "./tipi.js";

/** Modelli che accettano il ripiego lato server sui rifiuti. */
const CON_RIPIEGO = new Set(["claude-sonnet-5-5"]);
const BETA_RIPIEGO = "server-side-fallback-2026-07-01";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usoDa(u: any): UsoToken | undefined {
  if (!u || typeof u.input_tokens !== "number") return undefined;
  return { ingresso: u.input_tokens ?? 0, uscita: u.output_tokens ?? 0, cacheLettura: u.cache_read_input_tokens ?? 0, cacheScrittura: u.cache_creation_input_tokens ?? 0 };
}

function converti(messaggi: MessaggioCervello[]): Anthropic.MessageParam[] {
  return messaggi.map((m): Anthropic.MessageParam => {
    if (m.ruolo === "utente") return { role: "user", content: m.testo };
    if (m.ruolo === "jarvis") {
      if (m.grezzo) return { role: "assistant", content: m.grezzo as Anthropic.ContentBlockParam[] };
      const blocchi: Anthropic.ContentBlockParam[] = [];
      if (m.testo) blocchi.push({ type: "text", text: m.testo });
      for (const c of m.chiamate) blocchi.push({ type: "tool_use", id: c.id, name: c.nome, input: c.input as Record<string, unknown> });
      return { role: "assistant", content: blocchi.length ? blocchi : m.testo || "…" };
    }
    return {
      role: "user",
      content: m.risultati.map((r): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: r.id, content: r.contenuto, is_error: r.errore || undefined })),
    };
  });
}

const MOTIVI: Record<string, MotivoFine> = { end_turn: "fine", tool_use: "strumenti", refusal: "rifiuto", max_tokens: "limite", stop_sequence: "fine" };

export function creaCervelloAnthropic(apiKey: string): Cervello {
  if (!apiKey) throw new CervelloNonDisponibile("Manca la chiave ANTHROPIC_API_KEY sul server.");
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return {
    nome: "anthropic",
    async passo(r: RichiestaPasso, suTesto: (pezzo: string) => void): Promise<RispostaPasso> {
      const tools: Anthropic.Tool[] = r.strumenti.map((s) => ({
        name: s.nome,
        description: s.descrizione,
        input_schema: s.schema as Anthropic.Tool.InputSchema,
        strict: true,
      }));
      const ripiego = CON_RIPIEGO.has(r.modello);
      const corpo = {
        model: r.modello,
        max_tokens: r.maxToken,
        system: [{ type: "text" as const, text: r.sistema, cache_control: { type: "ephemeral" as const } }],
        tools,
        tool_choice: { type: "auto" as const },
        output_config: { effort: r.sforzo },
        messages: converti(r.messaggi),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let stream: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let messaggio: any;
      try {
        stream = ripiego
          ? client.beta.messages.stream({ ...corpo, betas: [BETA_RIPIEGO], fallbacks: "default" } as never, { signal: r.segnale })
          : client.messages.stream(corpo, { signal: r.segnale });
        stream.on("text", (pezzo: string) => suTesto(pezzo));
        messaggio = await stream.finalMessage();
      } catch (e) {
        // Consumo noto fino all'interruzione: message_start porta i token in ingresso, message_delta quelli in uscita.
        const parziale = stream?.currentMessage;
        const uso = usoDa(parziale?.usage);
        const testo = (parziale?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
        if (e instanceof Anthropic.APIUserAbortError || r.segnale?.aborted) throw new PassoInterrotto("interrotto", uso, testo);
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new PassoInterrotto("tempo", uso, testo);
        if (e instanceof Anthropic.APIConnectionError) throw new PassoInterrotto("rete", uso, testo);
        if (e instanceof Anthropic.AuthenticationError) throw new CervelloNonDisponibile("La chiave di Claude non è valida.");
        if (e instanceof Anthropic.PermissionDeniedError) throw new CervelloNonDisponibile("La chiave di Claude non ha i permessi necessari.");
        if (e instanceof Anthropic.RateLimitError) throw new CervelloNonDisponibile("Claude è sovraccarico o il limite è stato raggiunto: riprova tra poco.");
        if (e instanceof Anthropic.BadRequestError) throw new CervelloNonDisponibile(`Richiesta non accettata da Claude: ${e.message}`);
        if (e instanceof Anthropic.APIError) {
          // Errore a metà flusso (es. sovraccarico dopo i primi pezzi): i token già prodotti si pagano.
          if (uso) throw new PassoInterrotto("rete", uso, testo);
          throw new CervelloNonDisponibile(`Claude ha risposto con un errore (${e.status ?? "?"}).`);
        }
        throw e; // errore imprevisto: assistente.ts lo distingue da rete e interruzione
      }
      const fine = MOTIVI[messaggio.stop_reason ?? ""] ?? "altro";
      const blocchi = (messaggio.content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      const testo = fine === "rifiuto" ? "" : blocchi.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const chiamate = fine === "rifiuto" ? [] : blocchi
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), nome: String(b.name), input: b.input }));
      const uso = usoDa(messaggio.usage) ?? { ingresso: 0, uscita: 0, cacheLettura: 0, cacheScrittura: 0 };
      // Con il ripiego hanno lavorato più modelli: ogni tentativo si conta al prezzo del suo modello.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const iterazioni = (messaggio.usage?.iterations ?? []) as any[];
      const consumi = iterazioni.length > 1
        ? iterazioni.map((it) => ({ modello: String(it.model ?? messaggio.model ?? r.modello), uso: usoDa(it) })).filter((c): c is { modello: string; uso: UsoToken } => !!c.uso)
        : undefined;
      return {
        testo,
        chiamate,
        fine,
        uso,
        consumi: consumi?.length ? consumi : undefined,
        grezzo: messaggio.content,
      };
    },
  };
}
