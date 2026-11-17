// Cervello finto per i test: risponde con un copione, non chiama nessun servizio, non costa niente.
import type { Cervello, RichiestaPasso, RispostaPasso, ChiamataStrumento } from "./tipi.js";

export type Copione = (r: RichiestaPasso, passo: number) => Partial<RispostaPasso> & { testo?: string; chiamate?: ChiamataStrumento[] };

export function creaCervelloFinto(copione: Copione): Cervello & { richieste: RichiestaPasso[] } {
  const richieste: RichiestaPasso[] = [];
  return {
    nome: "finto",
    richieste,
    async passo(r, suTesto) {
      richieste.push(structuredClone({ ...r, segnale: undefined }));
      const out = copione(r, richieste.length - 1);
      const testo = out.testo ?? "";
      for (const pezzo of testo.match(/.{1,12}/gs) ?? []) suTesto(pezzo);
      const chiamate = out.chiamate ?? [];
      return {
        testo,
        chiamate,
        fine: out.fine ?? (chiamate.length ? "strumenti" : "fine"),
        uso: out.uso ?? { ingresso: 1000, uscita: 100, cacheLettura: 0, cacheScrittura: 0 },
      };
    },
  };
}
