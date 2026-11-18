// Ripiego 2D (canvas) della sfera di Jarvis: stessa interfaccia della scena 3D, leggero e senza librerie.
// Usato quando three.js non è disponibile e sul telefono (schermata principale).
export function createScena2D(canvas, labelLayer = null, { compatta = false } = {}) {
  const ctx = canvas.getContext("2d");
  const S = { mode: "boot", awake: 0, awakeT: 0, level: 0, levelT: 0, mic: 0, micT: 0, think: 0, thinkT: 0, flash: 0, synapses: 0, burst: 0 };
  const N = compatta ? 140 : 420;
  const punti = Array.from({ length: N }, (_, i) => {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), phi = i * 2.399963;
    return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r, ph: Math.random() * 6.28 };
  });
  const impulsi = [];
  let w = 0, h = 0, dpr = 1, ultimo = performance.now(), rot = 0;
  const colore = () => getComputedStyle(canvas).getPropertyValue("--sfera").trim() || "#3fc1c9";
  const accento = () => getComputedStyle(canvas).getPropertyValue("--sfera-accento").trim() || "#f2a541";
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    const b = canvas.getBoundingClientRect();
    w = Math.max(1, b.width); h = Math.max(1, b.height);
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener("resize", resize);
  resize();
  const ridotto = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function frame(now) {
    const dt = Math.min(0.05, (now - ultimo) / 1000); ultimo = now;
    const lerp = (a, b, k) => a + (b - a) * Math.min(1, dt * k);
    S.awake = lerp(S.awake, S.awakeT, 3); S.level = lerp(S.level, S.levelT, 12); S.mic = lerp(S.mic, S.micT, 10);
    S.think = lerp(S.think, S.thinkT, 4); S.flash *= Math.pow(0.1, dt); S.burst *= Math.pow(0.2, dt);
    rot += dt * (ridotto ? 0.02 : 0.15 + S.think * 0.6);
    if (!canvas.isConnected) return;
    if (w !== canvas.getBoundingClientRect().width) resize();
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * (compatta ? 0.36 : 0.26) * (1 + S.level * 0.12 + S.mic * 0.06 + S.burst * 0.1);
    const c1 = colore(), c2 = accento();
    // alone
    const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.7);
    g.addColorStop(0, hexA(c1, 0.10 + S.awake * 0.12 + S.flash * 0.2));
    g.addColorStop(1, hexA(c1, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // particelle
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (const p of punti) {
      const x = p.x * cr - p.z * sr, z = p.x * sr + p.z * cr;
      const onda = 1 + Math.sin(now / 600 + p.ph) * 0.03 * (1 + S.level * 4) + S.think * Math.sin(now / 200 + p.ph * 3) * 0.04;
      const px = cx + x * R * onda, py = cy + p.y * R * onda;
      const a = (0.25 + (z + 1) * 0.35) * (0.4 + S.awake * 0.6);
      ctx.fillStyle = hexA(S.think > 0.5 && p.ph > 5 ? c2 : c1, a);
      ctx.fillRect(px, py, z > 0 ? 2 : 1.4, z > 0 ? 2 : 1.4);
    }
    // anelli
    ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = hexA(k === 1 ? c2 : c1, 0.12 + S.awake * 0.18);
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * (1.25 + k * 0.18), R * (0.35 + k * 0.1), rot * (k % 2 ? -1 : 1) + k, 0, Math.PI * 2);
      ctx.stroke();
    }
    // impulsi ("sinapsi")
    for (let i = impulsi.length - 1; i >= 0; i--) {
      const q = impulsi[i]; q.t += dt * 1.6;
      if (q.t >= 1) { impulsi.splice(i, 1); S.synapses++; continue; }
      const rr = R * (0.2 + q.t * 1.3);
      ctx.fillStyle = hexA(c2, 1 - q.t);
      ctx.beginPath(); ctx.arc(cx + Math.cos(q.a) * rr, cy + Math.sin(q.a) * rr * 0.8, 1.8, 0, 6.29); ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function hexA(c, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  return {
    get synapses() { return S.synapses; },
    setMode(mode) {
      S.mode = mode;
      S.awakeT = mode === "sleep" || mode === "boot" ? 0.15 : 1;
      S.thinkT = mode === "think" ? 1 : 0;
      if (mode !== "speak") S.levelT = 0;
    },
    wake() { S.flash = 1; S.burst = 1; this.setMode("listen"); },
    setLevel(v) { S.levelT = Math.min(1, v); },
    setMic(v) { S.micT = Math.min(1, v); },
    setLabels(items) {
      if (!labelLayer) return;
      labelLayer.textContent = "";
      for (const it of items.slice(0, 6)) {
        const el = document.createElement("div");
        el.className = "node-label on piatta";
        const s = document.createElement("small"); s.textContent = it.kind;
        const t = document.createElement("span"); t.textContent = it.text;
        el.append(s, t);
        labelLayer.appendChild(el);
      }
    },
    highlight() { S.flash = Math.max(S.flash, 0.3); this.burstSynapses(10); },
    burstSynapses(n = 30) { for (let i = 0; i < Math.min(n, 80); i++) impulsi.push({ a: Math.random() * 6.29, t: Math.random() * 0.3 }); },
  };
}
