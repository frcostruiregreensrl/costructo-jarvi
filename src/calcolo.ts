// Calcolatrice istantanea: se la domanda è solo un conto ("quanto fa 12 per 75"),
// Jarvis risponde subito da solo, senza chiedere niente all'AI (costo zero).
// Nessun eval: un piccolo parser che conosce solo numeri e operazioni.
// Portato da calcolo.mjs di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo), con i tipi TypeScript.

const PAROLE: Array<[RegExp, string]> = [
  [/\b(jarvis|costructo|ehi|hey|ok|allora|dimmi|scusa|signore|per favore|per piacere|grazie)\b/g, " "],
  [/quant'è|\s(è|é)\s/g, " "],
  [/\b(quanto|calcola|calcolami|mi calcoli|puoi calcolare|fammi|fa|fanno|viene|il|risultato di|il risultato|uguale a|uguale)\b/g, " "],
  [/(\d)x(\d)/g, "$1*$2"],
  [/(\d)\s*%\s*di\s*/g, "$1/100*"],
  [/(\d)\s*per\s*cento\s*di\s*/g, "$1/100*"],
  [/\bradice\s+(quadrata\s+)?di\s*/g, "√"],
  [/\bal\s+quadrato\b|\balla\s+seconda\b/g, "^2"],
  [/\bal\s+cubo\b|\balla\s+terza\b/g, "^3"],
  [/\belevato\s+(alla?|a)\s*/g, "^"],
  [/\bdiviso\s+(per\s+)?|\bfratto\b|÷/g, "/"],
  [/\bmoltiplicato\s+per\b|\bper\b|\bx\b|×|·/g, "*"],
  [/più|\bpiu\b/g, "+"],
  [/\bmeno\b/g, "-"],
  [/\baperta\s+parentesi\b/g, "("],
  [/\bchiusa\s+parentesi\b/g, ")"],
];

function normalizza(testo: string): string {
  let s = ` ${String(testo).toLowerCase()} `.replace(/[?!¿¡=]/g, " ");
  for (const [re, con] of PAROLE) s = s.replace(re, con);
  s = s.replace(/(\d)\.(\d{3})(?!\d)/g, "$1$2"); // 1.000 -> 1000
  s = s.replace(/(\d),(\d)/g, "$1.$2"); // 3,5 -> 3.5
  s = s.replace(/[,;:]/g, " "); // virgole rimaste ("Jarvis, quanto fa…")
  return s.replace(/\s+/g, "").replace(/\.$/, "");
}

class ErroreConto extends Error {}

function analizza(src: string): number {
  let i = 0;
  const guarda = () => src[i];
  const numero = (): number => {
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) throw new ErroreConto();
    i += m[0].length;
    return Number(m[0]);
  };
  const atomo = (): number => {
    if (guarda() === "(") { i++; const v = espressione(); if (guarda() !== ")") throw new ErroreConto(); i++; return v; }
    if (guarda() === "√") { i++; return Math.sqrt(unario()); }
    return numero();
  };
  const unario = (): number => (guarda() === "-" ? (i++, -unario()) : guarda() === "+" ? (i++, unario()) : atomo());
  const potenza = (): number => { const b = unario(); if (guarda() === "^") { i++; return b ** potenza(); } return b; };
  const termine = (): number => {
    let v = potenza();
    while (guarda() === "*" || guarda() === "/") { const op = src[i++]; const r = potenza(); v = op === "*" ? v * r : v / r; }
    return v;
  };
  const espressione = (): number => {
    let v = termine();
    while (guarda() === "+" || guarda() === "-") { const op = src[i++]; const r = termine(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const v = espressione();
  if (i !== src.length) throw new ErroreConto();
  return v;
}

/** Restituisce il risultato se il messaggio è solo un conto, altrimenti null. */
export function provaConto(messaggio: string): number | null {
  const s = normalizza(messaggio);
  if (!s || s.length > 120 || !/^[\d.+\-*/^()√]+$/.test(s) || !/\d[+\-*/^]|√/.test(s)) return null;
  try {
    const v = analizza(s);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function diciNumero(v: number): string {
  return v.toLocaleString("it-IT", { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 4 });
}
