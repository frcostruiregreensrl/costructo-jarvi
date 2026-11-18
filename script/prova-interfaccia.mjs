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

      for (const p of ["posta", "whatsapp", "memoria", "registro", "spesa", "impostazioni"]) {
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
        // Posta: gruppi per azienda e privato, urgente evidenziata, dettaglio e bozza (mai inviata)
        await pagina.evaluate(() => { location.hash = "posta"; });
        await pagina.waitForSelector(".posta-mail");
        const gruppi = await pagina.locator(".gruppo-posta h2").allTextContents();
        controlla("posta divisa per azienda e privato", gruppi.length === 3 && gruppi.some((g) => g.startsWith("Privato")), gruppi.join(" | "));
        controlla("mail urgente evidenziata", (await pagina.locator(".posta-mail.urgente").count()) === 1);
        await pagina.locator(".posta-mail.urgente button", { hasText: "Apri" }).click();
        await pagina.waitForSelector(".estratto");
        await pagina.locator(".posta-mail.urgente button", { hasText: "Prepara bozza di risposta" }).click();
        await pagina.waitForSelector(".testo-bozza");
        controlla("bozza proposta e modificabile", ((await pagina.inputValue(".testo-bozza")) || "").includes("[da completare]"));
        await pagina.locator(".posta-mail.urgente button", { hasText: "Metti nelle Bozze" }).click();
        await pagina.waitForFunction(() => /Non l'ho inviata/.test(document.querySelector(".zona-bozza .esito")?.textContent || ""));
        controlla("bozza nelle Bozze, non inviata", true);
        const sbPosta = await pagina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        controlla("posta aperta senza scorrimento orizzontale", sbPosta <= 0, `${sbPosta}px`);
        await pagina.screenshot({ path: `${cartella}/posta-bozza-${nome}.png`, fullPage: true });
        // WhatsApp (Fase 3): gruppi per azienda, privato e «Da assegnare», urgente evidenziata, domanda con i pulsanti,
        // avviso «parte 2», risposta solo dopo la conferma (qui WhatsApp non è collegato: resta bozza).
        await pagina.evaluate(() => { location.hash = "whatsapp"; });
        await pagina.waitForSelector(".wa-chat");
        controlla("WhatsApp: avviso «collegamento nella parte 2»", await pagina.locator("#waNonCollegato").isVisible());
        const gruppiWa = await pagina.locator("#waGruppi .gruppo-wa h2").allTextContents();
        controlla("WhatsApp: chat divise per azienda, privato e da assegnare", gruppiWa.length === 4 && gruppiWa.some((g) => g.startsWith("Privato")) && gruppiWa.some((g) => g.startsWith("Da assegnare")), gruppiWa.join(" | "));
        controlla("WhatsApp: chat urgente evidenziata", (await pagina.locator(".wa-chat.urgente").count()) === 1);
        controlla("WhatsApp: domanda «Di quale azienda è…?» con i pulsanti", (await pagina.locator(".wa-domanda button").count()) === 3 && /Di quale azienda è Numero nuovo/.test(await pagina.locator(".wa-domanda p").first().textContent()));
        controlla("WhatsApp: proposta di chiedere la fattura", (await pagina.locator(".wa-chat .etichetta", { hasText: "Risposta proposta" }).count()) === 1);
        await pagina.screenshot({ path: `${cartella}/whatsapp-elenco-${nome}.png`, fullPage: true });
        await pagina.locator(".wa-chat.urgente button", { hasText: "Apri" }).click();
        await pagina.waitForSelector(".wa-messaggi .wa-msg");
        await pagina.locator(".wa-chat.urgente button", { hasText: "Prepara risposta" }).click();
        await pagina.waitForSelector(".wa-chat.urgente .zona-bozza .testo-bozza");
        controlla("WhatsApp: risposta proposta e modificabile", ((await pagina.inputValue(".wa-chat.urgente .zona-bozza .testo-bozza")) || "").includes("[da completare]"));
        await pagina.locator(".wa-chat.urgente .zona-bozza button", { hasText: "Invia" }).click();
        controlla("WhatsApp: con [da completare] non si manda", /da completare/.test(await pagina.locator(".wa-chat.urgente .zona-bozza .esito").textContent()) && (await pagina.locator(".wa-conferma").count()) === 0);
        await pagina.fill(".wa-chat.urgente .zona-bozza .testo-bozza", "Arrivo tra mezz'ora\u200b con il tecnico\u202e (prova).");
        await pagina.locator(".wa-chat.urgente .zona-bozza button", { hasText: "Invia" }).click();
        await pagina.waitForSelector(".wa-conferma");
        controlla("WhatsApp: prima di mandare chiede la conferma", /Mando questo messaggio su WhatsApp a Capocantiere Prova/.test(await pagina.locator(".wa-conferma p").first().textContent()));
        controlla("WhatsApp: l'anteprima mostra il testo pulito dal server (quello che partirà)", (await pagina.textContent(".wa-anteprima")) === "Arrivo tra mezz'ora con il tecnico (prova).");
        await pagina.screenshot({ path: `${cartella}/whatsapp-conferma-${nome}.png`, fullPage: true });
        await pagina.locator(".wa-conferma button", { hasText: "Sì, manda" }).click();
        await pagina.waitForFunction(() => /parte 2/.test(document.querySelector(".wa-chat.urgente .zona-bozza .esito")?.textContent || ""));
        controlla("WhatsApp: non collegato → non parte, resta bozza", true);
        const sbWa = await pagina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        controlla("WhatsApp aperta senza scorrimento orizzontale", sbWa <= 0, `${sbWa}px`);
        await pagina.locator(".wa-domanda button", { hasText: "Privato" }).click();
        await pagina.waitForFunction(() => !document.querySelector(".wa-domanda"));
        controlla("WhatsApp: risposta alla domanda ricordata", (await pagina.locator("#waGruppi .gruppo-wa h2", { hasText: "Da assegnare" }).count()) === 0);
        // Impostazioni: caselle, preset e calendario Apple
        await pagina.evaluate(() => { location.hash = "impostazioni"; });
        await pagina.waitForSelector("#listaCaselle li:not(.vuoto)");
        controlla("caselle elencate senza password", (await pagina.locator("#listaCaselle li").count()) === 3 && !(await pagina.content()).includes("password-finta-1234"));
        await pagina.click("[data-preset=pec]");
        controlla("preset PEC: niente conferme automatiche", await pagina.locator("#rigaConfermeCasella").isHidden());
        await pagina.click("[data-preset=altro]");
        controlla("preset Altro: campi dei server", await pagina.locator("#casImapHost").isVisible());
        controlla("conferme automatiche spente di serie", !(await pagina.isChecked("#impConferme")));
        controlla("WhatsApp: impostazioni «Non collegato», conferme automatiche spente", /Non collegato/.test(await pagina.textContent("#waStatoColl")) && !(await pagina.isChecked("#waConferme")) && (await pagina.inputValue("#waToken")) === "");
        controlla("WhatsApp: indirizzo del webhook mostrato", /\/api\/whatsapp\/webhook$/.test(await pagina.textContent("#waUrl")));
        await pagina.selectOption("#waProvider", "bsp");
        controlla("WhatsApp: campi del fornitore", await pagina.locator("#waBase").isVisible() && !(await pagina.locator("#waVersione").isVisible()));
        await pagina.locator("#formWhatsapp").screenshot({ path: `${cartella}/impostazioni-whatsapp-${nome}.png` });
        await pagina.locator("#formCasella").screenshot({ path: `${cartella}/caselle-altro-${nome}.png` });
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
