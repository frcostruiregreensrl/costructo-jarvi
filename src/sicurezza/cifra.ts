// Cifratura dei segreti salvati nel database (AES-256-GCM). La chiave sta solo nell'ambiente del server.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export interface Cifratore {
  cifra(testo: string): string;
  decifra(cifrato: string): string;
}

function leggiChiave(chiave: string): Buffer {
  if (!chiave) throw new Error("Manca JARVIS_CHIAVE_CIFRATURA (32 byte in base64 o hex).");
  const hex = /^[0-9a-f]{64}$/i.test(chiave) ? Buffer.from(chiave, "hex") : null;
  const b64 = hex ? null : Buffer.from(chiave, "base64");
  const k = hex || b64!;
  if (k.length !== 32) throw new Error("JARVIS_CHIAVE_CIFRATURA deve essere di 32 byte.");
  return k;
}

export function creaCifratore(chiave: string): Cifratore {
  const k = leggiChiave(chiave);
  return {
    cifra(testo) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k, iv);
      const dati = Buffer.concat([c.update(testo, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), dati.toString("base64")].join(".");
    },
    decifra(cifrato) {
      const [v, iv, tag, dati] = cifrato.split(".");
      if (v !== "v1") throw new Error("Formato cifrato sconosciuto");
      const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(dati, "base64")), d.final()]).toString("utf8");
    },
  };
}

/** Solo per i test e per l'avvio in locale senza chiave: deriva una chiave da una frase. */
export const chiaveDaFrase = (frase: string) => createHash("sha256").update(frase).digest("hex");
