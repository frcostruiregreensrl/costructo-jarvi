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
// - prompt caching del prompt di sistema (cache_control ephemeral sull'ultimo blocco di sistema).
import Anthropic from "@anthropic-ai/sdk";
import type { Cervello, MessaggioCervello, RichiestaPasso, RispostaPasso, MotivoFine } from "./tipi.js";
import { CervelloNonDisponibile } from "./tipi.js";

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
      let messaggio: Anthropic.Message;
      try {
        const stream = client.messages.stream(
          {
            model: r.modello,
            max_tokens: r.maxToken,
            system: [{ type: "text", text: r.sistema, cache_control: { type: "ephemeral" } }],
            tools,
            tool_choice: { type: "auto" },
            output_config: { effort: r.sforzo },
            messages: converti(r.messaggi),
          },
          { signal: r.segnale },
        );
        stream.on("text", (pezzo) => suTesto(pezzo));
        messaggio = await stream.finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new CervelloNonDisponibile("La chiave di Claude non è valida.");
        if (e instanceof Anthropic.PermissionDeniedError) throw new CervelloNonDisponibile("La chiave di Claude non ha i permessi necessari.");
        if (e instanceof Anthropic.RateLimitError) throw new CervelloNonDisponibile("Claude è sovraccarico o il limite è stato raggiunto: riprova tra poco.");
        if (e instanceof Anthropic.BadRequestError) throw new CervelloNonDisponibile(`Richiesta non accettata da Claude: ${e.message}`);
        if (e instanceof Anthropic.APIError) throw new CervelloNonDisponibile(`Claude ha risposto con un errore (${e.status ?? "?"}).`);
        throw e; // interruzione (stop) o errore di rete: lo gestisce assistente.ts
      }
      const fine = MOTIVI[messaggio.stop_reason ?? ""] ?? "altro";
      const testo = fine === "rifiuto" ? "" : messaggio.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const chiamate = fine === "rifiuto" ? [] : messaggio.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, nome: b.name, input: b.input }));
      const u = messaggio.usage;
      return {
        testo,
        chiamate,
        fine,
        uso: { ingresso: u.input_tokens, uscita: u.output_tokens, cacheLettura: u.cache_read_input_tokens ?? 0, cacheScrittura: u.cache_creation_input_tokens ?? 0 },
        grezzo: messaggio.content,
      };
    },
  };
}
