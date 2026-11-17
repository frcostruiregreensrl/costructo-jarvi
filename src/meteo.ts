// Meteo dei cantieri con Open-Meteo (gratis, senza chiave). Facoltativo: spento di serie.
import { z } from "zod";

const Risposta = z.object({
  daily: z.object({
    precipitation_probability_max: z.array(z.number().nullable()).optional(),
    temperature_2m_max: z.array(z.number().nullable()).optional(),
    temperature_2m_min: z.array(z.number().nullable()).optional(),
  }).partial().optional(),
}).passthrough();

export interface MeteoCantiere { cantiere: string; pioggia: number | null; max: number | null; min: number | null }

export async function meteoCantieri(cantieri: Array<{ nome?: string; lat?: number; lon?: number }>, fuso: string, fetchFn: typeof fetch = fetch): Promise<MeteoCantiere[]> {
  const conCoordinate = cantieri.filter((c) => typeof c.lat === "number" && typeof c.lon === "number" && Math.abs(c.lat!) <= 90 && Math.abs(c.lon!) <= 180).slice(0, 5);
  const out: MeteoCantiere[] = [];
  for (const c of conCoordinate) {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", c.lat!.toFixed(4));
    u.searchParams.set("longitude", c.lon!.toFixed(4));
    u.searchParams.set("daily", "precipitation_probability_max,temperature_2m_max,temperature_2m_min");
    u.searchParams.set("timezone", fuso);
    u.searchParams.set("forecast_days", "1");
    try {
      const r = await fetchFn(u, { signal: AbortSignal.timeout(6000), redirect: "error" });
      if (!r.ok) continue;
      const d = Risposta.parse(await r.json()).daily ?? {};
      out.push({ cantiere: c.nome || "Cantiere", pioggia: d.precipitation_probability_max?.[0] ?? null, max: d.temperature_2m_max?.[0] ?? null, min: d.temperature_2m_min?.[0] ?? null });
    } catch { /* il meteo è un di più: se non risponde si salta */ }
  }
  return out;
}
