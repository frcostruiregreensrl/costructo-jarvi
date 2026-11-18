// Posta FINTA, solo per i test: server IMAP finto (dietro l'interfaccia ConnessioneImap), invio SMTP finto,
// e un costruttore di mail grezze. Nessuna casella vera, nessuna rete.
import { spiegaErroreImap } from "../src/posta/imap.js";
import type { ApriImap, Casella, ConnessioneImap, MailInUscita, PostaInUscita, MessaggioGrezzo } from "../src/posta/tipi.js";

export interface MailFinta {
  da?: string; daNome?: string; a?: string; oggetto?: string; testo?: string; html?: string;
  messageId?: string; data?: Date; intestazioni?: Record<string, string>; rispondiA?: string;
  /** Righe messe IN CIMA (come quelle aggiunte dal fornitore di posta all'arrivo). */
  righeIniziali?: string[];
  /** Nome di un piccolo allegato (la mail diventa multipart). */
  allegato?: string;
}

/** Una mail grezza (RFC 5322) semplice, in testo o HTML. */
export function mailGrezza(m: MailFinta): Buffer {
  const confine = "----confine-finto";
  const corpo = m.html ?? m.testo ?? "Buongiorno, le scrivo per un saluto.";
  const righe = [
    ...(m.righeIniziali ?? []),
    `From: ${m.daNome ? `"${m.daNome}" ` : ""}<${m.da ?? "mario.rossi@esempio.it"}>`,
    `To: ${m.a ?? "luigi@lavoro.example"}`,
    `Subject: ${m.oggetto ?? "Ciao"}`,
    `Date: ${(m.data ?? new Date()).toUTCString()}`,
    `Message-ID: ${m.messageId ?? `<${Math.random().toString(36).slice(2)}@esempio.it>`}`,
    ...(m.rispondiA ? [`Reply-To: ${m.rispondiA}`] : []),
    ...Object.entries(m.intestazioni ?? {}).map(([k, v]) => `${k}: ${v}`),
    "MIME-Version: 1.0",
    ...(m.allegato
      ? [
        `Content-Type: multipart/mixed; boundary="${confine}"`, "", `--${confine}`,
        `Content-Type: ${m.html ? "text/html" : "text/plain"}; charset=utf-8`, "Content-Transfer-Encoding: 8bit", "", corpo,
        `--${confine}`, `Content-Type: application/pdf; name="${m.allegato}"`, `Content-Disposition: attachment; filename="${m.allegato}"`,
        "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 finto").toString("base64"), `--${confine}--`,
      ]
      : [`Content-Type: ${m.html ? "text/html" : "text/plain"}; charset=utf-8`, "Content-Transfer-Encoding: 8bit", "", corpo]),
  ];
  return Buffer.from(righe.join("\r\n"));
}

interface CasellaFinta {
  password: string;
  uidValidity: string;
  messaggi: Array<{ uid: number; sorgente: Buffer; data: Date }>;
  cartelle: Array<{ path: string; specialUse?: string }>;
  bozze: Array<{ cartella: string; sorgente: Buffer; segni: string[] }>;
  irraggiungibile?: boolean;
  /** Server che non dice UIDNEXT. */
  senzaUidNext?: boolean;
}

/** Server IMAP finto: registra ogni chiamata; non ha operazioni che cambiano i segni, spostano o cancellano. */
export class ImapFinto {
  caselle = new Map<string, CasellaFinta>();
  chiamate: string[] = [];
  aperture = 0;

  casella(utente: string, password = "giusta", cartelle: CasellaFinta["cartelle"] = [{ path: "[Gmail]/Bozze", specialUse: "\\Drafts" }]): CasellaFinta {
    const c: CasellaFinta = { password, uidValidity: "1", messaggi: [], cartelle, bozze: [] };
    this.caselle.set(utente.toLowerCase(), c);
    return c;
  }
  arriva(utente: string, m: MailFinta & { uid?: number }): number {
    const c = this.caselle.get(utente.toLowerCase())!;
    const uid = m.uid ?? (c.messaggi.at(-1)?.uid ?? 0) + 1;
    c.messaggi.push({ uid, sorgente: mailGrezza(m), data: m.data ?? new Date() });
    return uid;
  }

  apri: ApriImap = async (cas: Casella): Promise<ConnessioneImap> => {
    this.aperture++;
    const c = this.caselle.get(cas.utente.toLowerCase());
    if (c?.irraggiungibile) throw spiegaErroreImap({ code: "ECONNREFUSED" }, cas);
    if (!c || c.password !== cas.password) throw spiegaErroreImap({ authenticationFailed: true }, cas);
    const traccia = (nome: string) => this.chiamate.push(`${cas.utente}:${nome}`);
    let aperta = false;
    return {
      apriInbox: async () => { traccia("apriInbox(sola lettura)"); aperta = true; return { uidValidity: c.uidValidity, uidNext: c.senzaUidNext ? 0 : (c.messaggi.at(-1)?.uid ?? 0) + 1 }; },
      ultimoUid: async () => { traccia("ultimoUid"); return Math.max(0, ...c.messaggi.map((m) => m.uid)); },
      cercaDal: async (data) => { traccia("cercaDal"); if (!aperta) throw new Error("inbox non aperta"); return c.messaggi.filter((m) => m.data >= data).map((m) => m.uid); },
      uidDopo: async (uid) => {
        traccia("uidDopo");
        const dopo = c.messaggi.filter((m) => m.uid > uid).map((m) => m.uid);
        // come un server vero: «uid+1:*» restituisce almeno l'ultimo messaggio anche se è vecchio
        return dopo.length ? dopo : c.messaggi.slice(-1).map((m) => m.uid);
      },
      scarica: async (uids, maxByte): Promise<MessaggioGrezzo[]> => {
        traccia("scarica(BODY.PEEK)");
        return c.messaggi.filter((m) => uids.includes(m.uid)).map((m) => ({ uid: m.uid, sorgente: m.sorgente.subarray(0, maxByte), data: m.data }));
      },
      cartellaBozze: async () => { traccia("cartellaBozze"); return c.cartelle.find((x) => x.specialUse === "\\Drafts")?.path ?? c.cartelle.find((x) => /bozze|drafts/i.test(x.path))?.path ?? null; },
      aggiungiBozza: async (cartella, sorgente) => { traccia("aggiungiBozza(\\Draft)"); c.bozze.push({ cartella, sorgente, segni: ["\\Draft"] }); },
      chiudi: async () => { traccia("chiudi"); },
    };
  };
}

/** Invio SMTP finto: conserva le mail «inviate» (solo conferme automatiche) e le prove. */
export function uscitaFinta(): PostaInUscita & { inviate: Array<{ casella: Casella; mail: MailInUscita }>; prove: string[] } {
  const inviate: Array<{ casella: Casella; mail: MailInUscita }> = [];
  const prove: string[] = [];
  return {
    inviate, prove,
    async invia(casella, mail) { inviate.push({ casella, mail }); },
    async prova(casella) { prove.push(casella.utente); },
  };
}
