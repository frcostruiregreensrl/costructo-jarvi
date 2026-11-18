// Prova Playwright dell'interfaccia (PWA e Classic) a 390 px e 1280 px, tema chiaro e scuro.
// Avvia il server di prova (dati finti), entra con password + TOTP finti e salva gli screenshot.
// Uso: node script/prova-interfaccia.mjs [cartella-screenshot]
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const cartella = resolve(process.argv[2] || "prova-foto");
mkdirSync(cartella, { recursive: true });

function totp(segreto) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bit = 0, val = 0; const out = [];
  for (const c of segreto) { val = (val << 5) | A.indexOf(c); bit += 5; if (bit >= 8) { out.push((val >>> (bit - 8)) & 255); bit -= 8; } }
  const cnt = Buffer.alloc(8); cnt.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", Buffer.from(out)).update(cnt).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}

const proc = spawn(process.execPath, ["--import", "tsx", "script/server-prova.ts"], { stdio: ["ignore", "pipe", "inherit"] });
const info = await new Promise((ok, ko) => {
  proc.stdout.once("data", (d) => ok(JSON.parse(String(d).split("\n")[0])));
  proc.once("exit", (c) => ko(new Error(`server di prova uscito (${c})`)));
});

const esiti = [];
const controlla = (nome, ok, dettaglio = "") => { esiti.push({ nome, ok, dettaglio }); console.log(`${ok ? "OK  " : "NO  "} ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`); };
const browser = await chromium.launch();
let usato = 0;

try {
  for (const tema of ["light", "dark"]) {
    for (const larghezza of [390, 1280]) {
      const nome = `${larghezza}-${tema === "light" ? "chiaro" : "scuro"}`;
      const ctx = await browser.newContext({ viewport: { width: larghezza, height: larghezza === 390 ? 844 : 800 }, colorScheme: tema, locale: "it-IT", timezoneId: "Europe/Rome", deviceScaleFactor: larghezza === 390 ? 2 : 1 });
      const pagina = await ctx.newPage();
      const errori = [];
      pagina.on("pageerror", (e) => errori.push(e.message));
      pagina.on("console", (m) => { if (m.type() === "error") errori.push(m.text()); });
      await pagina.goto(info.indirizzo);
      await pagina.waitForSelector("#formAccesso", { state: "visible" });
      await pagina.screenshot({ path: `${cartella}/accesso-${nome}.png` });

      // Codice TOTP: un codice già usato non vale due volte, quindi si aspetta il passo successivo quando serve.
      let codice = totp(info.segreto);
      if (usato && codice === usato) { await pagina.waitForTimeout(30_500 - (Date.now() % 30_000)); codice = totp(info.segreto); }
      usato = codice;
      await pagina.fill("#password", info.password);
      await pagina.fill("#codice", codice);
      await pagina.click("#formAccesso button[type=submit]");
      await pagina.waitForSelector("#app:not([hidden])", { timeout: 10_000 });
      await pagina.waitForSelector("#adesso li:not(.vuoto)", { timeout: 10_000 });
      controlla(`${nome}: accesso e briefing «Adesso»`, (await pagina.locator("#adesso li").count()) === 3);

      await pagina.fill("#domanda", "Cosa ho oggi?");
      await pagina.press("#domanda", "Enter");
      await pagina.waitForFunction(() => document.querySelectorAll(".battuta.jarvis").length && !document.querySelector(".battuta.jarvis:last-child")?.textContent?.startsWith("…") && document.querySelector(".battuta.jarvis .meta"), null, { timeout: 10_000 });
      await pagina.fill("#domanda", "Vorrei il briefing alle 6:45");
      await pagina.press("#domanda", "Enter");
      await pagina.waitForSelector(".conferma", { timeout: 10_000 });
      controlla(`${nome}: un ricordo non chiesto esplicitamente chiede conferma`, (await pagina.locator(".conferma button").count()) === 2);
      await pagina.fill("#domanda", "quanto fa 12 per 75");
      await pagina.press("#domanda", "Enter");
      await pagina.waitForSelector(".numero-grande", { timeout: 10_000 });
      const sbordo = await pagina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      controlla(`${nome}: nessuno scorrimento orizzontale`, sbordo <= 0, `${sbordo}px`);
      await pagina.screenshot({ path: `${cartella}/home-${nome}.png`, fullPage: larghezza === 390 });

      for (const p of ["memoria", "registro", "spesa", "impostazioni"]) {
        await pagina.evaluate((h) => { location.hash = h; }, p);
        await pagina.waitForTimeout(400);
        const sb = await pagina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        controlla(`${nome}: pagina ${p} senza scorrimento orizzontale`, sb <= 0, `${sb}px`);
        await pagina.screenshot({ path: `${cartella}/${p}-${nome}.png`, fullPage: true });
      }
      if (larghezza === 390 && tema === "light") {
        await pagina.evaluate(() => { location.hash = "memoria"; });
        await pagina.waitForSelector("#listaMemorie li");
        controlla("memorie visibili e divise", (await pagina.locator("#listaMemorie li.lavoro").count()) === 1 && (await pagina.locator("#listaMemorie li.privato").count()) === 2);
        await pagina.evaluate(() => { location.hash = "home"; });
        await pagina.click("#apriMenu");
        await pagina.screenshot({ path: `${cartella}/menu-${nome}.png` });
        await pagina.keyboard.press("Escape");
      }

      // Modalità Classic (senza three.js installato usa il ripiego 2D)
      if (larghezza === 1280) {
        await pagina.goto(`${info.indirizzo}/classic.html?nofs`);
        await pagina.waitForTimeout(800);
        await pagina.screenshot({ path: `${cartella}/classic-cancello-${nome}.png` });
        await pagina.click("#gate");
        await pagina.waitForTimeout(900);
        await pagina.keyboard.press("w");
        await pagina.waitForTimeout(2500);
        await pagina.keyboard.press("d");
        await pagina.waitForTimeout(300);
        const scena = await pagina.textContent("#debugScene");
        controlla(`${nome}: Classic si avvia (grafica ${scena})`, /2D|3D/.test(scena || ""));
        await pagina.screenshot({ path: `${cartella}/classic-${nome}.png` });
      }
      const veri = errori.filter((e) => !/speech|audio|AudioContext|getUserMedia|NotAllowedError|Permission|fullscreen|404/i.test(e));
      controlla(`${nome}: nessun errore JavaScript`, veri.length === 0, veri.join(" | "));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  proc.kill("SIGTERM");
}
const falliti = esiti.filter((e) => !e.ok);
console.log(`\n${esiti.length - falliti.length}/${esiti.length} controlli superati. Screenshot in ${cartella}`);
process.exit(falliti.length ? 1 : 0);
