// Modalità Classic (Mac, schermo intero): l'esperienza originale di J.A.R.V.I.S.
// Risveglio a voce con «Jarvis» o «Costructo», anti-eco, «stop», standby dopo 45 s, tasti F/T/W/R/J/D,
// briefing al primo risveglio, risposte lette mentre arrivano, grafica 3D (o ripiego 2D).
// Adattato da app.js di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo). Le chiavi restano sul server:
// questa pagina parla solo con le API di Jarvis, dopo l'accesso.
import { creaScena } from "./scena.js";
import { sfx, audioCtx, Musica } from "./suoni.js";
import { CONFIG_MUSICA, trovaFrase, righePer, normalizza } from "./frasi.js";
import { Voce, Ascolto, divisoreFrasi } from "../voce.js";
import { api, chiedi, NonAutenticato } from "../api.js";

const $ = (s) => document.querySelector(s);
const body = document.body;
const fmt = new Intl.NumberFormat("it-IT");

let impostazioni = { comeChiamarmi: "signore", paroleRisveglio: ["jarvis", "costructo"] };
let briefing = { righe: [], oggi: [] };
let avvio = null;
let mode = "boot", greeted = false, conversazione = null, streamAbort = null, lastActivity = 0;
let lastHandled = { text: "", at: 0 }, lastSpoken = "", sleepAfterSpeech = false, thinkStart = 0, thinkSyn = 0;
let partyMode = false, briefingDone = false, musicOn = false, recMode = false, pendingQuestion = null, confermaAperta = null;
const musica = new Musica(CONFIG_MUSICA);

// Varianti della parola di risveglio sentite dal riconoscimento vocale.
const VARIANTI = {
  jarvis: ["jarvis", "giarvis", "jarvi", "iarvis", "jervis", "gervis", "darvis", "charvis", "javis", "jar vis", "giarvi"],
  costructo: ["costructo", "costrutto", "construct", "costruct", "constructo", "costructor", "kostructo"],
};
let WAKE = /\bjarvis\b/i;
function aggiornaParole() {
  const tutte = impostazioni.paroleRisveglio.flatMap((p) => VARIANTI[p] || [p]);
  const esc = tutte.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  WAKE = new RegExp(`\\b(${esc.join("|")})\\b`, "i");
  $("#hintWord").textContent = impostazioni.paroleRisveglio.map((p) => `«${p.toUpperCase()}»`).join(" O ");
}
const STOP = /\b(stop|basta|fermati|zitto|silenzio|aspetta)\b/i;
const STANDBY = /\b(grazie jarvis|a dopo|vai in standby|standby|riposati|spegniti|buonanotte|disattivati)\b/i;
const SHORT_OK = /^(si|no|stop|grazie|ok|okay|conferma|confermo|annulla|procedi|esatto|certo|perfetto|basta|continua|il primo|il secondo|il terzo)$/i;
const S = () => impostazioni.comeChiamarmi;

// ---------------------------------------------------------------- scena + voce
const scene = await creaScena($("#gl"), $("#labels"));
if (scene.tipo === "2D") $("#labels").classList.add("piatte");
$("#debugScene").textContent = scene.tipo === "3D" ? "3D (three.js)" : "2D (ripiego)";
scene.setMode("boot");

const voce = new Voce({
  onLivello: (v) => scene.setLevel(v),
  onFrase: (text, dur, meta) => {
    lastSpoken = text;
    showCaption(text, dur);
    if (meta.stat) revealStat(meta.stat, dur);
    if (meta.stat?.id === "agenda") revealAgenda();
    if (meta.music === "party") { partyMode = true; musicOn = true; musica.play(1); scene.burstSynapses(80); }
    if (meta.music === "stop") { partyMode = false; musicOn = false; setTimeout(() => musica.stop(3), 900); }
    if (meta.stat && !/^(agenda)$/.test(meta.stat.id)) body.classList.add("show-stats");
  },
  onRiposo: () => {
    if (mode !== "speak" && mode !== "wake") return;
    if (sleepAfterSpeech) { sleepAfterSpeech = false; return setTimeout(goSleep, 400); }
    setTimeout(() => {
      if (voce.occupata || (mode !== "speak" && mode !== "wake")) return;
      setMode("listen");
      sfx.listen();
    }, 250);
  },
});
$("#debugVoice").textContent = voce.attiva ? "VOCE DEL DISPOSITIVO" : "NESSUNA (solo testo)";

const ears = new Ascolto({
  continuo: true,
  onFinale: (t, info) => handleFinal(t, info),
  onParziale: (text, { eco }) => {
    if (eco || mode !== "listen") return;
    $("#you").textContent = text;
    $("#you").classList.add("live");
  },
  onStato: (s) => debug("debugRec", s.toUpperCase()),
  onErrore: (e) => debug("debugError", `ascolto: ${e}`),
});

// ---------------------------------------------------------------- stato
const STATUS = {
  boot: "INIZIALIZZAZIONE", sleep: "IN ATTESA", wake: "CONNESSIONE NEURALE", listen: "IN ASCOLTO",
  listenRec: "IN ASCOLTO · SOLO CON LA PAROLA DI RISVEGLIO", think: "ELABORAZIONE", speak: "RISPOSTA", paused: "MICROFONO IN PAUSA",
};
function setMode(m) {
  mode = m;
  body.dataset.mode = m;
  scene.setMode(m === "wake" ? "speak" : m === "paused" ? "sleep" : m);
  ears.silenzia(m === "speak" || m === "wake");
  $("#statusText").textContent = (m === "listen" && recMode ? STATUS.listenRec : m === "sleep" ? `IN ATTESA · DÌ ${$("#hintWord").textContent}` : STATUS[m]) || m.toUpperCase();
  debug("debugState", m.toUpperCase());
  if (m === "listen") lastActivity = performance.now();
  const C = CONFIG_MUSICA, bed = briefingDone ? C.bedAfter : C.bed, duck = briefingDone ? C.duckAfter : C.duck;
  if (m === "wake") { musicOn = true; musica.play(musica.playing ? bed : C.intro).then((ok) => ok && setTimeout(() => mode === "wake" && musica.fade(duck, 0.5), 700)); }
  else if (m === "speak" && musica.playing) musica.fade(partyMode ? 0.4 : duck, 0.4);
  else if (m === "listen" && musica.playing) { briefingDone = true; musica.fade(partyMode ? 1 : C.bedAfter, 2.5); }
  else if (m === "sleep" && musica.playing) { partyMode = false; musica.fade(C.bedAfter, 2); }
  else if (m === "paused") { partyMode = false; musica.stop(1.2); }
  if (m === "think") { $("#says").textContent = ""; thinkStart = performance.now(); thinkSyn = scene.synapses; }
}
function debug(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }

// ---------------------------------------------------------------- HUD
function showCaption(text, dur) {
  const el = $("#says");
  el.textContent = "";
  const words = text.split(/\s+/);
  const step = Math.min(0.42, (dur * 0.9) / words.length);
  words.forEach((w, i) => {
    const s = document.createElement("span");
    s.textContent = w + " ";
    s.style.animationDelay = `${i * step}s`;
    el.appendChild(s);
  });
}
function countUp(el, target, duration, suffix = "") {
  const t0 = performance.now();
  let lastTick = 0;
  const frame = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    el.textContent = fmt.format(Math.round(target * eased)) + suffix;
    if (p < 1 && now - lastTick > 75) { sfx.tick(); lastTick = now; }
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
function revealStat(stat, dur) {
  let card = document.querySelector(`.stat[data-id="${CSS.escape(stat.id)}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "stat";
    card.dataset.id = stat.id;
    const n = $("#stats").children.length + 1;
    const head = document.createElement("div"); head.className = "stat-head";
    const num = document.createElement("span"); num.textContent = String(n).padStart(2, "0");
    head.append(num, document.createElement("em"));
    const bar = document.createElement("div"); bar.className = "bar"; bar.append(document.createElement("i"));
    const lab = document.createElement("small"); lab.textContent = stat.label;
    card.append(head, document.createElement("b"), lab, bar);
    $("#stats").appendChild(card);
  }
  requestAnimationFrame(() => card.classList.add("on"));
  const duration = Math.max(1200, Math.min(2600, dur * 850));
  countUp(card.querySelector("b"), stat.value, duration, stat.suffix || "");
  card.querySelector(".bar i").style.transitionDuration = `${duration}ms`;
  requestAnimationFrame(() => (card.querySelector(".bar i").style.transform = `scaleX(${stat.suffix === "%" ? Math.min(1, stat.value / 100) : 1})`));
  scene.burstSynapses(18);
}
function renderAgenda() {
  const today = briefing.oggi || [];
  const now = new Date(), hm = now.getHours() * 60 + now.getMinutes();
  let nextMarked = false;
  $("#agenda").textContent = "";
  (today.length ? today : [{ titolo: "Nessun impegno", ora: "—" }]).slice(0, 7).forEach((t, i) => {
    const li = document.createElement("li");
    const [h, m] = (t.ora || "").split(":").map(Number);
    const mins = Number.isFinite(h) ? h * 60 + (m || 0) : NaN;
    if (!nextMarked && Number.isFinite(mins) && mins >= hm) { li.classList.add("next"); nextMarked = true; }
    li.style.transitionDelay = `${i * 0.12}s`;
    const time = document.createElement("time"); time.textContent = t.ora || "GIORNO";
    const span = document.createElement("span"); span.textContent = t.spazio === "lavoro" ? `${t.titolo} · LAVORO` : t.titolo;
    li.append(time, span);
    $("#agenda").appendChild(li);
  });
}
function revealAgenda() { renderAgenda(); body.classList.add("show-agenda"); }
async function setLabels() {
  let memorie = [];
  try { memorie = await api("/api/memorie?vista=tutto"); } catch { /* facoltative */ }
  const items = [
    ...(briefing.oggi || []).slice(0, 4).map((t) => ({ kind: `AGENDA · ${t.ora || "GIORNO"}`, text: t.titolo.slice(0, 34) })),
    ...memorie.slice(0, 3).map((m) => ({ kind: m.spazio === "lavoro" ? "MEMORIA · LAVORO" : "MEMORIA", text: m.testo.slice(0, 34) })),
    { kind: "SISTEMA", text: avvio?.costructo ? "Costructo collegato" : "Agenda locale attiva" },
    { kind: "SISTEMA", text: "Rete neurale operativa" },
  ];
  scene.setLabels(items);
}
setInterval(() => {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString("it-IT");
  $("#date").textContent = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  if (mode === "think") {
    $("#synapses").textContent = fmt.format((scene.synapses - thinkSyn) * 37);
    $("#thinkTime").textContent = `${((performance.now() - thinkStart) / 1000).toFixed(1)}s`;
  }
  if (!recMode && mode === "listen" && performance.now() - lastActivity > 45000 && !voce.occupata) goSleep();
}, 100);

// ---------------------------------------------------------------- voce
function speak(text, meta = {}) {
  if (mode !== "speak" && mode !== "wake") setMode("speak");
  voce.di(text, meta);
}
function interrupt() {
  streamAbort?.abort();
  streamAbort = null;
  voce.stop();
  $("#says").textContent = "";
  setMode("listen");
  sfx.listen();
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------- risveglio / standby
async function wake(rest = "") {
  lastActivity = performance.now();
  const question = rest.replace(/^[\s,.!?]*(ciao|ehi|hey|ok|buongiorno|salve)?[\s,.!?]*/i, "").trim();
  body.classList.add("awake");
  if (greeted) {
    sfx.listen();
    scene.wake();
    if ($("#stats").children.length) body.classList.add("show-stats", "show-agenda");
    if (question.split(/\s+/).length >= 3) return processa(question);
    setMode("speak");
    return speak(pick([`Sono qui, ${S()}.`, `Dimmi pure, ${S()}.`, `Ti ascolto, ${S()}.`]));
  }
  greeted = true;
  setMode("wake");
  sfx.wake();
  scene.wake();
  $("#says").textContent = "";
  $("#you").textContent = "";
  try { briefing = await api("/api/briefing"); } catch (e) { if (e instanceof NonAutenticato) return vaiAllAccesso(); }
  setLabels();
  setTimeout(() => body.classList.add("show-stats"), 900);
  const righe = briefing.righe.map((r) => ({ text: r.testo, stat: r.numero ? { id: r.numero.id, label: r.numero.etichetta, value: r.numero.valore, suffix: r.numero.suffisso } : undefined }));
  setTimeout(() => righe.forEach((r) => voce.di(r.text, r)), 1100);
  if (question.split(/\s+/).length >= 3) pendingQuestion = question;
}
function goSleep() {
  streamAbort?.abort();
  voce.stop();
  setMode("sleep");
  body.classList.remove("awake", "show-stats", "show-agenda");
  $("#says").textContent = "";
  $("#you").textContent = "";
  sfx.sleep();
}

// ---------------------------------------------------------------- input vocale (anti-eco, stop, filtri)
function looksLikeEcho(text) {
  const heard = new Set(normalizza(text).split(" ").filter((w) => w.length > 2));
  const spoken = new Set(normalizza(lastSpoken).split(" "));
  if (!heard.size) return true;
  let common = 0;
  heard.forEach((w) => spoken.has(w) && common++);
  return common / heard.size > 0.5;
}
function handleFinal(raw, info = {}) {
  const text = raw.trim();
  if (!text) return;
  debug("debugText", `${info.motore || "?"}${info.eco ? " (eco)" : ""}: ${text}`);
  if (mode === "sleep") {
    const m = text.match(WAKE);
    if (m) wake(text.slice(m.index + m[0].length));
    return;
  }
  if (mode === "paused" || mode === "boot") return;
  if (info.motore === "tastiera" && mode !== "listen") { interrupt(); return processa(text); }
  if (info.eco || mode === "think" || mode === "speak" || mode === "wake") {
    // interruzione: solo comandi espliciti (o la parola di risveglio) che non siano l'eco della voce di Jarvis
    if ((STOP.test(text) || WAKE.test(text)) && !looksLikeEcho(text)) interrupt();
    return;
  }
  if (recMode && !WAKE.test(text)) return debug("debugError", `modalità registrazione, ignorato: "${text}"`);
  const key = normalizza(text);
  if (key === lastHandled.text && Date.now() - lastHandled.at < 4000) return;
  const words = key.split(" ").filter(Boolean);
  if (text.length < 3 || (words.length < 2 && !SHORT_OK.test(key) && !WAKE.test(text))) return debug("debugError", `ignorato: "${text}"`);
  if (info.confidenza > 0 && info.confidenza < 0.35 && words.length < 4) return debug("debugError", `bassa confidenza: "${text}"`);
  lastHandled = { text: key, at: Date.now() };
  $("#you").textContent = text;
  $("#you").classList.remove("live");
  const senzaParola = text.replace(new RegExp(`^(ciao |ehi |hey )?${WAKE.source}[,.]?\\s*`, "i"), "");
  processa(senzaParola || text);
}

async function processa(text) {
  try {
    lastActivity = performance.now();
    if (STANDBY.test(text)) { sleepAfterSpeech = true; return speak(`A presto, ${S()}. Resto in ascolto.`); }
    const frase = trovaFrase(text);
    if (frase) return runPhrase(frase, text);
    return askMind(text);
  } catch (e) {
    debug("debugError", e.message);
    return speak(`Si è verificato un problema tecnico, ${S()}. Puoi ripetere?`);
  }
}
async function runPhrase(frase, _text) {
  const d = new Date();
  const spesa = avvio?.spesa;
  const righe = righePer(frase, {
    s: S(), time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, hasMusic: !!musica.buffer,
    costructo: !!avvio?.costructo, percentualeSpesa: spesa && spesa.tettoUsd ? (spesa.spesaUsd / spesa.tettoUsd) * 100 : 0,
  });
  setMode("think");
  sfx.think();
  scene.burstSynapses(45);
  $("#thinkLabel").textContent = "ELABORAZIONE";
  await new Promise((r) => setTimeout(r, 650));
  if (mode !== "think") return;
  righe.forEach((l, i) => { if (i === 0) setMode("speak"); voce.di(l.text, l); });
}

async function askMind(text) {
  setMode("think");
  sfx.think();
  scene.burstSynapses(40);
  const labels = ["ANALISI SEMANTICA", "ATTRAVERSAMENTO MEMORIA", "SINTESI RISPOSTA"];
  let li = 0;
  $("#thinkLabel").textContent = labels[0];
  const labelTimer = setInterval(() => ($("#thinkLabel").textContent = labels[++li % labels.length]), 900);
  const ctrl = new AbortController();
  streamAbort = ctrl;
  let spoke = false;
  const frasi = divisoreFrasi((s) => {
    if (ctrl.signal.aborted) return;
    spoke = true;
    clearInterval(labelTimer);
    voce.aperta = true;
    speak(s);
  });
  try {
    await chiedi({ messaggio: text, vista: "tutto", conversazione: conversazione || undefined }, (ev) => {
      if (ev.tipo === "delta") frasi.aggiungi(ev.testo);
      else if (ev.tipo === "modello") showBrain(ev.modello);
      else if (ev.tipo === "strumento") { $("#thinkLabel").textContent = ev.nome.startsWith("costructo") ? "CONSULTAZIONE COSTRUCTO" : ev.nome.startsWith("agenda") ? "AGGIORNAMENTO AGENDA" : ev.nome.startsWith("ricord") ? "CODIFICA NUOVA MEMORIA" : "ELABORAZIONE DATI"; scene.burstSynapses(40); }
      else if (ev.tipo === "agenda") { api("/api/briefing").then((b) => { briefing = b; revealAgenda(); setLabels(); }).catch(() => {}); scene.highlight(); }
      else if (ev.tipo === "memoria") { setLabels(); scene.highlight(0); }
      else if (ev.tipo === "numero") { body.classList.add("show-stats"); revealStat({ id: `n${Date.now()}`, label: ev.etichetta, value: ev.valore, suffix: ev.suffisso }, 2); }
      else if (ev.tipo === "conferma") mostraConferma(ev);
      else if (ev.tipo === "avviso") debug("debugError", ev.testo);
      else if (ev.tipo === "fine") conversazione = ev.conversazione;
    }, ctrl.signal);
    frasi.chiudi();
  } catch (e) {
    if (e instanceof NonAutenticato) return vaiAllAccesso();
    if (!ctrl.signal.aborted) { spoke = true; speak("La connessione con la mia mente si è interrotta. Riprova tra un istante."); }
  } finally {
    clearInterval(labelTimer);
    if (streamAbort === ctrl) streamAbort = null;
    voce.aperta = false;
    if (!spoke && mode === "think") setMode("listen");
    else voce.prossima();
  }
}
function showBrain(modello) {
  const chip = $("#brainChip");
  chip.hidden = false;
  $("#brainName").textContent = { calcolatrice: "CALCOLATRICE", "claude-haiku-5-5": "CLAUDE HAIKU", "claude-sonnet-5-5": "CLAUDE SONNET" }[modello] || modello.toUpperCase();
  debug("debugMind", modello);
  chip.classList.remove("flash"); void chip.offsetWidth; chip.classList.add("flash");
}

// ---------------------------------------------------------------- conferme (pulsanti, oppure «sì» / «il secondo» a voce)
function mostraConferma(ev) {
  confermaAperta = ev.id;
  $("#confermaTesto").textContent = ev.domanda;
  const azioni = $("#confermaAzioni");
  azioni.textContent = "";
  const scelte = ev.opzioni?.length ? ev.opzioni.map((o) => [o.testo, o.indice]) : [["CONFERMA", "conferma"]];
  for (const [testo, scelta] of [...scelte, ["ANNULLA", "annulla"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = testo;
    if (scelta === "conferma") b.className = "si";
    b.addEventListener("click", async () => {
      const r = await api(`/api/conferme/${encodeURIComponent(ev.id)}`, { metodo: "POST", corpo: { scelta } }).catch((e) => ({ messaggio: e.message }));
      chiudiConferma();
      speak(r.messaggio);
    });
    azioni.append(b);
  }
  $("#conferma").classList.add("show");
  body.classList.add("show-controls");
}
function chiudiConferma() { confermaAperta = null; $("#conferma").classList.remove("show"); }
setInterval(() => { if (confermaAperta && mode === "sleep") chiudiConferma(); }, 1000);

// ---------------------------------------------------------------- avvio
function vaiAllAccesso() { location.href = "/"; }
async function boot() {
  try {
    avvio = await api("/api/avvio");
    impostazioni = avvio.impostazioni;
    voce.nomeVoce = impostazioni.vocePreferita;
    voce.velocita = impostazioni.velocitaVoce;
  } catch (e) {
    if (e instanceof NonAutenticato) return vaiAllAccesso();
    debug("debugError", "server non raggiungibile");
  }
  aggiornaParole();
  try { briefing = await api("/api/briefing"); } catch { /* lo riprova al risveglio */ }
  renderAgenda();
}
async function start() {
  $("#gate").classList.add("hide");
  voce.sblocca();
  await audioCtx.resume();
  if (!document.fullscreenElement && !new URLSearchParams(location.search).has("nofs")) document.documentElement.requestFullscreen?.().catch(() => {});
  if (ears.disponibile) {
    ears.avvia();
    debug("debugEngine", "BROWSER (CONTINUO)");
  } else {
    debug("debugError", "riconoscimento vocale non disponibile: premi T per scrivere");
    $("#hint span").textContent = "PREMI T PER SCRIVERE ·";
  }
  try {
    const s = await navigator.mediaDevices?.getUserMedia?.({ audio: { echoCancellation: true, noiseSuppression: true } });
    debug("debugMic", s?.getAudioTracks()[0]?.label || "microfono");
    s?.getTracks().forEach((t) => t.stop()); // il riconoscimento del browser apre il microfono da solo
  } catch (e) { debug("debugError", `microfono: ${e.message}`); }
  setTimeout(() => setMode("sleep"), 600);
}
$("#gate").addEventListener("click", start);

// ---------------------------------------------------------------- controlli
let hideTimer;
addEventListener("pointermove", () => {
  body.classList.add("show-controls");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => body.classList.remove("show-controls"), 2200);
});
$("#pauseBtn").addEventListener("click", () => {
  if (mode === "paused") { ears.riprendi(); setMode(greeted && body.classList.contains("awake") ? "listen" : "sleep"); if (musicOn) musica.play(briefingDone ? CONFIG_MUSICA.bedAfter : CONFIG_MUSICA.bed); $("#pauseBtn span").textContent = "PAUSA"; }
  else { interrupt(); ears.pausa(); setMode("paused"); $("#pauseBtn span").textContent = "RIPRENDI"; }
});
$("#fsBtn").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "d") $("#debug").classList.toggle("show");
  if (k === "j") { recMode = !recMode; sfx.tick(); setMode(mode); debug("debugError", recMode ? "MODALITÀ REGISTRAZIONE ON" : "MODALITÀ REGISTRAZIONE OFF"); }
  if (k === "f") $("#fsBtn").click();
  if (k === "w" && mode === "sleep") wake("");
  if (k === "r") { greeted = false; briefingDone = false; musicOn = false; musica.stop(1); conversazione = null; $("#stats").textContent = ""; chiudiConferma(); goSleep(); }
  if (k === "t") { e.preventDefault(); $("#typeBox").classList.toggle("show"); $("#typeBox input").focus(); }
  if (k === "escape") { $("#typeBox").classList.remove("show"); chiudiConferma(); }
});
$("#typeBox").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#typeBox input").value.trim();
  $("#typeBox input").value = "";
  $("#typeBox").classList.remove("show");
  if (!v) return;
  if (mode === "boot") return;
  if (mode === "sleep") return wake(v.replace(WAKE, "")); // scrivere sveglia Jarvis; 3+ parole diventano la domanda
  handleFinal(v, { motore: "tastiera" });
});

// domanda detta insieme alla parola di risveglio: risposta dopo il briefing
setInterval(() => {
  if (pendingQuestion && mode === "listen") { const q = pendingQuestion; pendingQuestion = null; processa(q); }
}, 300);

boot();
