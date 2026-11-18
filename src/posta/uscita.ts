// Invio SMTP (nodemailer), usato SOLO per le conferme di ricezione automatiche.
// Mai dalle PEC (controllato qui E in rispostaAuto.ts), mai per le bozze (bozze.ts non usa questo file).
// Ci si collega solo all'indirizzo verificato del server, con il nome del server per il certificato TLS.
import { createTransport } from "nodemailer";
import type { RisolviNome } from "../calendario.js";
import { indirizziServer, conPrimoRaggiungibile } from "./rete.js";
import { casellaPec } from "./caselle.js";
import { ErrorePosta, type Casella, type MailInUscita, type PostaInUscita } from "./tipi.js";

function spiegaErroreSmtp(e: unknown, c: Casella): Error {
  if (e instanceof ErrorePosta) return e;
  const x = e as { code?: string; responseCode?: number };
  if (x?.code === "EAUTH" || x?.responseCode === 535) {
    return new ErrorePosta(c.tipo === "gmail"
      ? "Gmail non ha accettato la password per l'invio: serve una «password per le app»."
      : "Il server di posta in uscita non ha accettato nome utente o password.");
  }
  if (/^(ECONNECTION|ETIMEDOUT|ESOCKET|EDNS|ECONNREFUSED|ENOTFOUND)$/.test(String(x?.code))) return new ErrorePosta("Server di posta in uscita non raggiungibile.");
  return new ErrorePosta("Il server di posta in uscita ha risposto con un errore.");
}

/** Le sole operazioni di nodemailer usate qui (sostituibili nei test). */
export interface Trasporto { sendMail(m: Record<string, unknown>): Promise<unknown>; verify(): Promise<unknown>; close(): void }

export function creaPostaInUscita(opz: { risolvi?: RisolviNome; creaTrasporto?: (o: Record<string, unknown>) => Trasporto } = {}): PostaInUscita {
  const crea = opz.creaTrasporto ?? ((o: Record<string, unknown>) => createTransport(o) as unknown as Trasporto);
  /** Un trasporto per indirizzo verificato (prima IPv4): `usa` si prova su ognuno finché uno risponde. */
  const conTrasporto = async <T>(c: Casella, usa: (t: Trasporto) => Promise<T>): Promise<T> => {
    if (casellaPec(c)) throw new ErrorePosta("Dalla PEC Jarvis non invia mai niente.");
    if (!c.smtp) throw new ErrorePosta("Manca il server della posta in uscita.");
    const smtp = c.smtp;
    const indirizzi = await indirizziServer(smtp.host, opz.risolvi);
    const implicito = smtp.porta === 465;
    try {
      return await conPrimoRaggiungibile(indirizzi, async (ip) => {
        const t = crea({
          host: ip, port: smtp.porta, secure: implicito, requireTLS: !implicito,
          auth: { user: c.utente, pass: c.password },
          tls: { servername: smtp.host, minVersion: "TLSv1.2", rejectUnauthorized: true },
          connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000, logger: false, debug: false,
        });
        try { return await usa(t); } finally { t.close(); }
      });
    } catch (e) { throw spiegaErroreSmtp(e, c); }
  };
  return {
    async invia(c: Casella, m: MailInUscita) {
      await conTrasporto(c, (t) => t.sendMail({
        from: c.utente, to: m.a, subject: m.oggetto, text: m.testo,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
        ...(m.references ? { references: m.references } : {}),
        // RFC 3834: risposta automatica. Così gli altri sistemi non rispondono a loro volta in automatico.
        headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
      }));
    },
    async prova(c: Casella) {
      await conTrasporto(c, (t) => t.verify());
    },
  };
}
