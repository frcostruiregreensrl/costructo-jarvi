// Effetti sonori generati al momento con WebAudio (nessun file).
// Copiati da audio.js di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo).
export const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const master = audioCtx.createGain();
master.gain.value = 0.9;
master.connect(audioCtx.destination);
export { master };
function noiseBuffer(seconds) {
  const b = audioCtx.createBuffer(1, audioCtx.sampleRate * seconds, audioCtx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
export const sfx = {
  wake() {
    const t = audioCtx.currentTime;
    // sub boom
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(32, t + 1.4);
    env(g, t, 0.02, 0.9, 1.6); o.connect(g).connect(master); o.start(t); o.stop(t + 1.8);
    // soffio che sale
    const n = audioCtx.createBufferSource(), f = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    n.buffer = noiseBuffer(2.5); f.type = "bandpass"; f.Q.value = 1.4;
    f.frequency.setValueAtTime(180, t); f.frequency.exponentialRampToValueAtTime(5200, t + 0.9); f.frequency.exponentialRampToValueAtTime(900, t + 2.2);
    ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.22, t + 0.5); ng.gain.exponentialRampToValueAtTime(0.0001, t + 2.3);
    n.connect(f).connect(ng).connect(master); n.start(t); n.stop(t + 2.5);
    // shimmer armonico
    [523.25, 783.99, 1046.5, 1567.98].forEach((fr, i) => {
      const s = audioCtx.createOscillator(), sg = audioCtx.createGain();
      s.type = "sine"; s.frequency.value = fr; s.detune.value = (i - 1.5) * 6;
      env(sg, t + 0.45 + i * 0.07, 0.25, 0.05 / (i + 1), 1.8);
      s.connect(sg).connect(master); s.start(t + 0.4); s.stop(t + 3);
    });
  },
  listen() {
    const t = audioCtx.currentTime;
    [1318.5, 1975.5].forEach((fr, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = fr;
      env(g, t + i * 0.07, 0.008, 0.05, 0.18);
      o.connect(g).connect(master); o.start(t + i * 0.07); o.stop(t + 0.4);
    });
  },
  think() {
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(440, t + 0.25);
    env(g, t, 0.02, 0.03, 0.3); o.connect(g).connect(master); o.start(t); o.stop(t + 0.4);
  },
  sleep() {
    const t = audioCtx.currentTime;
    [987.77, 659.25, 440].forEach((fr, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = fr;
      env(g, t + i * 0.11, 0.01, 0.045, 0.35);
      o.connect(g).connect(master); o.start(t + i * 0.11); o.stop(t + 0.9);
    });
  },
  tick() {
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square"; o.frequency.value = 2400;
    env(g, t, 0.002, 0.012, 0.03); o.connect(g).connect(master); o.start(t); o.stop(t + 0.05);
  },
};

// ======================= MUSICA (facoltativa) =======================
// La musica dell'originale NON è inclusa (licenza sconosciuta). Se esiste /classic/musica.mp3 con licenza, si usa.
export class Musica {
  constructor(cfg) {
    this.cfg = cfg;
    this.gain = audioCtx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(master);
    this.src = null;
    this.buffer = null;
    this.pronta = fetch(cfg.file)
      .then((r) => (r.ok && /audio/.test(r.headers.get("content-type") || "") ? r.arrayBuffer() : Promise.reject(new Error("nessuna musica"))))
      .then((b) => audioCtx.decodeAudioData(b))
      .then((buf) => (this.buffer = buf))
      .catch(() => null);
  }
  get playing() { return !!this.src; }
  fade(volume, secondi = 0.8) {
    const t = audioCtx.currentTime, g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(volume, t + secondi);
  }
  async play(volume = this.cfg.intro) {
    await this.pronta;
    if (!this.buffer) return false;
    if (!this.src) {
      const src = audioCtx.createBufferSource();
      src.buffer = this.buffer;
      src.loop = true;
      src.onended = () => { if (this.src === src) this.src = null; };
      src.connect(this.gain);
      src.start(0);
      this.src = src;
    }
    this.fade(volume, 0.35);
    return true;
  }
  stop(secondi = 2.5) {
    if (!this.src) return;
    const src = this.src;
    this.src = null;
    this.fade(0, secondi);
    setTimeout(() => { try { src.stop(); } catch {} }, secondi * 1000 + 100);
  }
}
