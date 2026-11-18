// Voce di Jarvis nel browser.
// - Uscita: voci del dispositivo (speechSynthesis). ElevenLabs è previsto ma spento in Fase 1.
// - Entrata: riconoscimento del browser (webkitSpeechRecognition), con ripiego sulla tastiera.
// - Lettura in streaming: la risposta viene divisa in frasi e ogni frase parte appena è completa.
// Adattato da Mouth / Ears di audio.js e dalla divisione in frasi di app.js di J.A.R.V.I.S. (MIT, © 2026 Thomas Colombo).

const PULISCI = (t) => t.replace(/[*_#`>\[\]()]/g, "").replace(/\s+/g, " ").trim();

export class Voce {
  constructor({ onLivello, onFrase, onRiposo } = {}) {
    Object.assign(this, { onLivello, onFrase, onRiposo });
    this.coda = [];
    this.inCorso = null;
    this.generazione = 0;
    this.aperta = false; // true finché una risposta in streaming sta ancora arrivando
    this.nomeVoce = "";
    this.velocita = 1.02;
    this.attiva = "speechSynthesis" in window;
    this.livello = 0;
    this._misura();
  }
  get occupata() { return !!this.inCorso || this.coda.length > 0 || this.aperta; }
  /** iPhone e iPad: la prima frase deve partire da un tocco. Chiamare in un gestore di clic. */
  sblocca() {
    if (!this.attiva || this._sbloccata) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    this._sbloccata = true;
  }
  voci() {
    if (!this.attiva) return [];
    return speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("it"));
  }
  sceltaVoce() {
    const voci = this.voci();
    return voci.find((v) => v.name === this.nomeVoce)
      || voci.find((v) => /premium|enhanced|natural|neural|online/i.test(v.name))
      || voci.find((v) => /google|alice|luca|federica/i.test(v.name))
      || voci[0] || null;
  }
  di(testo, meta = {}) {
    const t = PULISCI(testo);
    if (!t) return;
    this.coda.push({ testo: t, meta });
    this.prossima();
  }
  prossima() {
    if (this.inCorso || !this.coda.length) {
      if (!this.inCorso && !this.coda.length && !this.aperta) this.onRiposo?.();
      return;
    }
    const gen = this.generazione;
    const voce = this.coda.shift();
    this.inCorso = voce;
    const stima = voce.testo.split(/\s+/).length / 2.6;
    this.onFrase?.(voce.testo, stima, voce.meta);
    if (!this.attiva) { setTimeout(() => gen === this.generazione && this._fine(), stima * 1000); return; }
    const u = new SpeechSynthesisUtterance(voce.testo);
    u.lang = "it-IT";
    u.rate = this.velocita;
    u.voice = this.sceltaVoce();
    const fatto = () => { if (gen === this.generazione) this._fine(); };
    u.onend = fatto;
    u.onerror = fatto;
    speechSynthesis.speak(u);
  }
  _fine() { this.inCorso = null; this.prossima(); }
  stop() {
    this.generazione++;
    this.coda.length = 0;
    this.aperta = false;
    this.inCorso = null;
    if (this.attiva) speechSynthesis.cancel();
  }
  /** Livello "finto" della voce (speechSynthesis non dà l'audio): anima la sfera mentre parla. */
  _misura() {
    const giro = () => {
      const obiettivo = this.inCorso ? 0.25 + Math.random() * 0.6 : 0;
      this.livello += (obiettivo - this.livello) * 0.25;
      this.onLivello?.(this.livello);
      requestAnimationFrame(giro);
    };
    requestAnimationFrame(giro);
  }
}

/** Divide il testo che arriva a pezzi in frasi (almeno 20 caratteri) e le passa subito alla voce. */
export function divisoreFrasi(suFrase) {
  let buffer = "";
  const svuota = (forza) => {
    for (;;) {
      const m = buffer.match(/^[\s\S]*?[.!?…;](?=\s|$)/);
      if (!m) break;
      let s = m[0];
      if (s.trim().length < 20) {
        const m2 = buffer.slice(s.length).match(/^[\s\S]*?[.!?…;](?=\s|$)/);
        if (!m2) break;
        s += m2[0];
      }
      buffer = buffer.slice(s.length);
      if (s.trim()) suFrase(s.trim());
    }
    if (forza && buffer.trim()) { suFrase(buffer.trim()); buffer = ""; }
  };
  return { aggiungi(pezzo) { buffer += pezzo; svuota(false); }, chiudi() { svuota(true); } };
}

/** Riconoscimento vocale del browser. continuo=true per la modalità Classic, false per «premi e parla». */
export class Ascolto {
  constructor({ continuo = false, onFinale, onParziale, onStato, onErrore } = {}) {
    Object.assign(this, { continuo, onFinale, onParziale, onStato, onErrore });
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.muto = false;
    this.inPausa = false;
    this.attivo = false;
  }
  get disponibile() { return !!this.SR; }
  avvia() {
    if (!this.SR) { this.onErrore?.("non-disponibile"); return false; }
    if (this.attivo) return true;
    const r = (this.rec = new this.SR());
    r.lang = "it-IT";
    r.continuous = this.continuo;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => { this.attivo = true; this.onStato?.("ascolto"); };
    r.onresult = (e) => {
      let parziale = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], testo = res[0].transcript.trim();
        if (res.isFinal) { if (testo) this.onFinale?.(testo, { eco: this.muto, confidenza: res[0].confidence, motore: "browser" }); }
        else parziale += testo + " ";
      }
      if (parziale.trim()) this.onParziale?.(parziale.trim(), { eco: this.muto });
    };
    r.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") this.onErrore?.(e.error); };
    r.onend = () => {
      this.attivo = false;
      this.onStato?.("fermo");
      if (this.continuo && this.rec === r && !this.inPausa) setTimeout(() => { try { r.start(); } catch {} }, 150);
    };
    try { r.start(); } catch { /* già avviato */ }
    return true;
  }
  ferma() { const r = this.rec; this.rec = null; try { r?.stop(); } catch {} }
  /** Anti-eco: mentre Jarvis parla, il riconoscimento viene azzerato (abort) per scartare la sua voce. */
  silenzia(on) {
    if (this.muto === on) return;
    this.muto = on;
    if (this.rec && this.attivo) { try { this.rec.abort(); } catch {} }
  }
  pausa() { this.inPausa = true; try { this.rec?.abort(); } catch {} }
  riprendi() { this.inPausa = false; if (this.continuo && this.rec) { try { this.rec.start(); } catch {} } else if (this.continuo) this.avvia(); }
}
