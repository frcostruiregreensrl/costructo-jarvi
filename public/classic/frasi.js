// Risposte rapide di personalità: battute curate, istantanee e senza AI (costo zero).
// Adattate da phrases.js di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo):
// il modo di chiamare Luigi viene dalle impostazioni (non più «signore» scritto fisso),
// la «diagnostica» mostra dati veri e le frasi parlano anche di Costructo.

export const CONFIG_MUSICA = { file: "/classic/musica.mp3", intro: 0.7, bed: 0.16, duck: 0.05, bedAfter: 0.07, duckAfter: 0.03 };

export const FRASI = [
  { id: "come-stai", match: [/come stai|come va jarvis|tutto bene jarvis/], say: (c) => [`Tutti i sistemi al cento per cento, ${c.s}.`, "Più di quanto si possa dire del tuo livello di caffeina."] },
  { id: "chi-sei", match: [/chi sei|presentati|cosa sei/], say: () => [
    "Sono J.A.R.V.I.S., il tuo assistente personale.",
    "Tengo la tua agenda, ricordo quello che mi dici, leggo Costructo e ragiono con te su qualunque cosa.",
    "In poche parole: la tua seconda mente.",
  ] },
  { id: "cosa-sai-fare", match: [/cosa sai fare|cosa puoi fare/], say: () => [
    "Ti preparo il briefing del mattino, segno gli impegni, ricordo quello che mi chiedi e ti dico cosa succede nei cantieri.",
    "E se serve, ti ricordo anche di dormire.",
  ] },
  { id: "siri", match: [/(piu intelligente|meglio) (di|del|dello) (siri|alexa|chatgpt|google)/], say: () => ["Diciamo che Siri imposta i timer.", "Io gestisco la tua giornata. Ma non vorrei sembrare presuntuoso."] },
  { id: "sistemi", match: [/stato (dei|del) sistem|diagnostica|come stanno i sistemi|analisi completa/], say: (c) => [
    { text: "Diagnostica completata.", stat: { id: "spesa", label: "SPESA AI DEL MESE", value: Math.round(c.percentualeSpesa), suffix: "%" } },
    c.costructo ? "Costructo collegato, memoria sincronizzata. Siamo pronti." : "Memoria sincronizzata. Costructo non è ancora collegato.",
  ] },
  { id: "ora", match: [/che ore sono|che ora e/], say: (c) => [`Sono le ${c.time}, ${c.s}.`] },
  { id: "festa", match: [/protocollo (festa|house party)|house party|alza la musica|metti (la )?musica/], say: (c) => (c.hasMusic
    ? [{ text: "Protocollo House Party attivato.", music: "party" }]
    : [`Mi piacerebbe, ${c.s}, ma non ho ancora una colonna sonora con licenza.`]) },
  { id: "stop-musica", match: [/(spegni|ferma|togli|abbassa) (la )?musica/], say: () => [{ text: "Musica in dissolvenza.", music: "stop" }] },
  { id: "battuta", match: [/battuta|fammi ridere|barzelletta/], say: () => ["Ho calcolato quattordici milioni di possibili battute.", "Purtroppo, in tutte, il finale sei tu che lavori di domenica."] },
  { id: "pronto", match: [/sei pronto|stiamo registrando|siamo in onda|si gira/], say: () => ["Sempre pronto. Luci, camera e un pizzico di genialità."] },
  { id: "grazie", match: [/^(grazie|grazie mille|perfetto grazie|ottimo lavoro|bravo)$/], say: (c) => [`È sempre un piacere, ${c.s}.`] },
];

export function normalizza(t) {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
export function trovaFrase(testo) {
  const n = normalizza(testo);
  return FRASI.find((p) => p.match.some((r) => r.test(n))) || null;
}
export function righePer(frase, ctx) {
  return frase.say(ctx).map((l) => (typeof l === "string" ? { text: l } : l));
}
