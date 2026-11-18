// Collegamento IMAP vero (imapflow) dietro l'interfaccia ConnessioneImap.
// - La Posta in arrivo si apre in SOLA LETTURA (EXAMINE): il server non può cambiare i segni.
// - I messaggi si scaricano con BODY.PEEK (imapflow lo usa per «source»): niente diventa «letto».
// - Nessuna chiamata che cambia segni, sposta, copia o cancella: qui non esistono.
// - L'unica scrittura è APPEND di una bozza con il segno \Draft.
// - Ci si collega solo all'indirizzo verificato (niente rete interna), con il nome del server per il certificato TLS.
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { RisolviNome } from "../calendario.js";
import { indirizzoServer } from "./rete.js";
import { ErrorePosta, type ApriImap, type Casella, type ConnessioneImap, type MessaggioGrezzo } from "./tipi.js";

/** Le sole operazioni di imapflow che Jarvis usa (serve anche ai test con un client finto). */
export interface ClientImap {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(evento: "error", f: (e: Error) => void): unknown;
  getMailboxLock(percorso: string, opzioni: { readOnly: true }): Promise<{ release(): void }>;
  mailbox: false | { uidValidity: bigint | number | string; uidNext: number } | unknown;
  search(q: Record<string, unknown>, o: { uid: true }): Promise<number[] | false | undefined>;
  fetch(range: string, q: Record<string, unknown>, o: { uid: true }): AsyncIterable<{
    uid: number; source?: Buffer; size?: number; internalDate?: Date | string; bodyStructure?: Struttura;
  }>;
  list(): Promise<Array<{ path: string; name: string; specialUse?: string; flags?: Set<string> }>>;
  append(percorso: string, contenuto: Buffer, segni: string[]): Promise<unknown>;
}
interface Struttura { type?: string; size?: number; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: Struttura[] }

/** Nomi e dimensioni degli allegati dalla struttura del messaggio (senza scaricarli). */
export function allegatiDaStruttura(s: Struttura | undefined): Array<{ nome: string; dimensione: number }> {
  const out: Array<{ nome: string; dimensione: number }> = [];
  const visita = (n: Struttura | undefined) => {
    if (!n || out.length >= 30) return;
    for (const f of n.childNodes ?? []) visita(f);
    const nome = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (nome && (n.disposition === "attachment" || n.disposition === "inline" || !n.type?.startsWith("text/"))) {
      out.push({ nome: String(nome).slice(0, 200), dimensione: Number(n.size) || 0 });
    }
  };
  visita(s);
  return out;
}

/** Errori del server in parole semplici (mai con la password dentro). */
export function spiegaErroreImap(e: unknown, c: Pick<Casella, "tipo">): Error {
  if (e instanceof ErrorePosta) return e;
  const x = e as { authenticationFailed?: boolean; code?: string; tlsFailed?: boolean; responseText?: string; serverResponseCode?: string };
  if (x?.authenticationFailed || x?.serverResponseCode === "AUTHENTICATIONFAILED") {
    if (c.tipo === "gmail") return new ErrorePosta("Gmail non ha accettato la password. Serve una «password per le app» (non la password normale di Google): creala su myaccount.google.com → Sicurezza, con la verifica in due passaggi attiva.");
    if (c.tipo === "pec") return new ErrorePosta("La PEC non ha accettato nome utente o password: controlla l'indirizzo PEC completo e la password della PEC.");
    return new ErrorePosta("Il server non ha accettato nome utente o password.");
  }
  if (x?.tlsFailed) return new ErrorePosta("Collegamento sicuro (TLS) non riuscito con il server di posta.");
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT|GREETING_TIMEOUT|ETIMEOUT|NoConnection|EConnectionClosed)$/.test(String(x?.code))) {
    return new ErrorePosta("Server di posta non raggiungibile: controlla il nome del server e la porta, oppure riprova tra poco.");
  }
  return new ErrorePosta("Il server di posta ha risposto con un errore. Riprova tra poco.");
}

export interface OpzioniImap {
  risolvi?: RisolviNome;
  /** Solo per i test: sostituisce imapflow con un client finto. */
  creaClient?: (o: ImapFlowOptions) => ClientImap;
}

export function creaApriImap(opz: OpzioniImap = {}): ApriImap {
  const creaClient = opz.creaClient ?? ((o: ImapFlowOptions) => new ImapFlow(o) as unknown as ClientImap);
  return async (c: Casella): Promise<ConnessioneImap> => {
    const ip = await indirizzoServer(c.imap.host, opz.risolvi);
    const client = creaClient({
      host: ip, servername: c.imap.host, port: c.imap.porta, secure: true,
      auth: { user: c.utente, pass: c.password },
      tls: { servername: c.imap.host, minVersion: "TLSv1.2", rejectUnauthorized: true },
      logger: false, disableAutoIdle: true, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 90_000,
      clientInfo: { name: "Jarvis" },
    });
    client.on("error", () => { /* gli errori arrivano anche dalle chiamate: qui si evita solo che il processo cada */ });
    try { await client.connect(); } catch (e) { try { client.close(); } catch { /* già chiuso */ } throw spiegaErroreImap(e, c); }
    let blocco: { release(): void } | null = null;
    const prova = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw spiegaErroreImap(e, c); } };
    return {
      apriInbox: () => prova(async () => {
        blocco = await client.getMailboxLock("INBOX", { readOnly: true });
        const box = client.mailbox as { uidValidity: bigint | number | string; uidNext: number };
        return { uidValidity: String(box.uidValidity), uidNext: Number(box.uidNext) || 0 };
      }),
      cercaDal: (data) => prova(async () => (await client.search({ since: data }, { uid: true })) || []),
      uidDopo: (uid) => prova(async () => (await client.search({ uid: `${uid + 1}:*` }, { uid: true })) || []),
      scarica: (uids, maxByte) => prova(async () => {
        if (!uids.length) return [];
        const out: MessaggioGrezzo[] = [];
        // «source» con maxLength = BODY.PEEK[]<0.maxByte>: non segna come letto e non scarica gli allegati grandi.
        for await (const m of client.fetch(uids.join(","), { uid: true, source: { maxLength: maxByte }, size: true, internalDate: true, bodyStructure: true }, { uid: true })) {
          if (!m.source) continue;
          out.push({
            uid: m.uid, sorgente: m.source, dimensione: m.size,
            data: m.internalDate ? new Date(m.internalDate) : undefined,
            allegati: allegatiDaStruttura(m.bodyStructure),
          });
        }
        return out;
      }),
      cartellaBozze: () => prova(async () => {
        const cartelle = await client.list();
        const speciale = cartelle.find((x) => x.specialUse === "\\Drafts" || x.flags?.has("\\Drafts"));
        if (speciale) return speciale.path;
        const perNome = cartelle.find((x) => /^(bozze|drafts|\[gmail\]\/(bozze|drafts)|inbox[./](bozze|drafts))$/i.test(x.path) || /^(bozze|drafts)$/i.test(x.name));
        return perNome?.path ?? null;
      }),
      aggiungiBozza: (cartella, sorgente) => prova(async () => { await client.append(cartella, sorgente, ["\\Draft"]); }),
      chiudi: async () => {
        try { (blocco as { release(): void } | null)?.release(); } catch { /* niente */ }
        try { await client.logout(); } catch { try { client.close(); } catch { /* già chiuso */ } }
      },
    };
  };
}
