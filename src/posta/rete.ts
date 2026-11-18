// Controllo dei server di posta (contro le richieste verso la rete interna, SSRF).
// Per le caselle «altro» Luigi scrive il nome del server: deve essere un nome pubblico, mai un indirizzo
// numerico, mai la rete interna. Il nome si risolve qui, si controllano TUTTI gli indirizzi (stessa regola
// del calendario iCal) e ci si collega solo all'indirizzo verificato (con il nome per il certificato TLS).
import { isIP } from "node:net";
import { ipPrivato, risolviPredefinito, type RisolviNome } from "../calendario.js";
import { ErrorePosta } from "./tipi.js";

const NOME_SERVER = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NOMI_INTERNI = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|invalid|test|example)$/;

/** Controlla solo la forma del nome (senza rete). Lancia un errore leggibile. */
export function controllaNomeServer(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) throw new ErrorePosta("Scrivi il nome del server di posta.");
  if (isIP(h.replace(/^\[|\]$/g, ""))) throw new ErrorePosta("Scrivi il nome del server (per esempio imap.esempio.it), non un indirizzo numerico.");
  if (!NOME_SERVER.test(h)) throw new ErrorePosta("Il nome del server di posta non è valido.");
  if (NOMI_INTERNI.test(h)) throw new ErrorePosta("Il server di posta deve essere un indirizzo pubblico su internet.");
  return h;
}

/**
 * Risolve il nome e restituisce TUTTI gli indirizzi verificati, prima gli IPv4 (più spesso raggiungibili dai server).
 * Basta un solo indirizzo interno (loopback, reti private, metadati dei cloud…) per bloccare tutto.
 */
export async function indirizziServer(host: string, risolvi: RisolviNome = risolviPredefinito): Promise<string[]> {
  const h = controllaNomeServer(host);
  let indirizzi: string[];
  try { indirizzi = await risolvi(h); } catch { throw new ErrorePosta("Server di posta non raggiungibile: controlla il nome del server."); }
  if (!indirizzi.length || indirizzi.some(ipPrivato)) throw new ErrorePosta("Il server di posta punta a un indirizzo non ammesso.");
  return [...new Set(indirizzi)].sort((a, b) => isIP(a) - isIP(b));
}

/** Il primo indirizzo verificato (IPv4 se c'è). */
export async function indirizzoServer(host: string, risolvi: RisolviNome = risolviPredefinito): Promise<string> {
  return (await indirizziServer(host, risolvi))[0];
}

/** Errori di rete per cui ha senso provare l'indirizzo successivo (non password sbagliata, non TLS). */
export function erroreDiRete(e: unknown): boolean {
  const x = e as { code?: string; authenticationFailed?: boolean; tlsFailed?: boolean; responseCode?: number };
  if (x?.authenticationFailed || x?.tlsFailed || x?.responseCode) return false;
  return /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|CONNECT_TIMEOUT|GREETING_TIMEOUT|ETIMEOUT|ECONNECTION|ESOCKET|NoConnection|EConnectionClosed)$/.test(String(x?.code));
}

/** Prova gli indirizzi in ordine: se uno non risponde passa al successivo; ogni altro errore si ferma subito. */
export async function conPrimoRaggiungibile<T>(indirizzi: string[], prova: (ip: string) => Promise<T>): Promise<T> {
  let ultimo: unknown = new ErrorePosta("Server di posta non raggiungibile.");
  for (const ip of indirizzi) {
    try { return await prova(ip); } catch (e) {
      ultimo = e;
      if (!erroreDiRete(e)) throw e;
    }
  }
  throw ultimo;
}
