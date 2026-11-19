// Lettura del corpo di una risposta con un limite di byte: si legge a pezzi e ci si ferma appena si supera
// il limite (il resto non si scarica nemmeno). Serve per le risposte di Meta e di 360dialog e per gli allegati.

export interface CorpoLetto { dati: Buffer; troppo: boolean }

export async function leggiCorpo(r: Response, max: number): Promise<CorpoLetto> {
  if (!r.body) return { dati: Buffer.alloc(0), troppo: false };
  const lettore = r.body.getReader();
  const pezzi: Buffer[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await lettore.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        for (const p of pezzi) p.fill(0);
        await lettore.cancel().catch(() => {});
        return { dati: Buffer.alloc(0), troppo: true };
      }
      pezzi.push(Buffer.from(value));
    }
  } catch {
    for (const p of pezzi) p.fill(0);
    throw new Error("lettura interrotta");
  }
  return { dati: Buffer.concat(pezzi), troppo: false };
}

/** Testo (UTF-8) di una risposta, al massimo `max` byte; oltre il limite si restituisce "" (non si legge il resto). */
export async function leggiTesto(r: Response, max: number): Promise<string> {
  try {
    const c = await leggiCorpo(r, max);
    return c.troppo ? "" : c.dati.toString("utf8");
  } catch { return ""; }
}
