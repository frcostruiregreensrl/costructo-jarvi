// Fase 2 — calendario Apple (iCloud CalDAV, sola lettura) e briefing con posta e calendari.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dbProvvisorio, cifratore, avviaAmbiente } from "./aiuto.js";
import { avviaCaldavFinto, APPLE_ID, APP_PASSWORD, icsUtc } from "./caldavFinto.js";
import { avviaCostructoFinto, TOKEN, TOKEN_2 } from "./costructoFinto.js";
import { scopriCalendari, eventiCalendario, collegaApple, scegliCalendari, eventiApple, urlIcloud, leggiApple } from "../src/calendarioApple.js";
import { creaBriefing, notificheDelMattino } from "../src/briefing.js";
import { creaClientCostructo } from "../src/costructo.js";
import { salvaSegreto } from "../src/impostazioni.js";
import { salvaMessaggio } from "../src/posta/archivio.js";
import type { AziendaCollegata } from "../src/aziende.js";
import type { EventoApple } from "../src/calendarioApple.js";
import { inizioGiorno } from "../src/tempo.js";

const cred = { appleId: APPLE_ID, password: APP_PASSWORD };

test("CalDAV: scoperta (principal → calendar-home-set → calendari) e solo calendari con eventi", async () => {
  const f = await avviaCaldavFinto();
  try {
    const cal = await scopriCalendari(cred, f.fetch);
    assert.deepEqual(cal.map((c) => c.nome), ["Casa & famiglia", "Lavoro EG"], "i promemoria (VTODO) non servono; &amp; decodificato");
    assert.equal(cal[0].colore, "#FF2968");
    assert.equal(cal[0].url, "https://p99-caldav.icloud.com/123456/calendars/casa/");
    assert.deepEqual(f.richieste.map((r) => [r.metodo, r.host, r.percorso, r.depth]), [
      ["PROPFIND", "caldav.icloud.com", "/", "0"],
      ["PROPFIND", "caldav.icloud.com", "/123456/principal/", "0"],
      ["PROPFIND", "p99-caldav.icloud.com", "/123456/calendars/", "1"],
    ]);
    assert.match(f.richieste[0].corpo, /current-user-principal/);
    assert.match(f.richieste[1].corpo, /calendar-home-set/);
    assert.ok(f.richieste.every((r) => r.auth));
    // password sbagliata: messaggio chiaro sulla password specifica per le app
    await assert.rejects(scopriCalendari({ appleId: APPLE_ID, password: "sbagliata" }, f.fetch), /password specifica per le app/);
  } finally { await f.chiudi(); }
});

test("CalDAV: REPORT con l'intervallo di date, ricorrenze espanse con il parser iCal esistente", async () => {
  const f = await avviaCaldavFinto();
  try {
    const da = Date.UTC(2026, 10, 16), a = Date.UTC(2026, 10, 23);
    f.eventi.casa = [
      "BEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:Palestra\r\nDTSTART;TZID=Europe/Rome:20261102T183000\r\nDTEND;TZID=Europe/Rome:20261102T193000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:x2\r\nSUMMARY:Cena <Anna> & amici\r\nDTSTART:20261120T190000Z\r\nDTEND:20261120T220000Z\r\nEND:VEVENT",
    ];
    const ev = await eventiCalendario(cred, "https://p99-caldav.icloud.com/123456/calendars/casa/", da, a, "Europe/Rome", f.fetch);
    const r = f.richieste.at(-1)!;
    assert.equal(r.metodo, "REPORT");
    assert.equal(r.depth, "1");
    assert.match(r.corpo, /<c:time-range start="20261116T000000Z" end="20261123T000000Z"\/>/);
    assert.match(r.corpo, /comp-filter name="VEVENT"/);
    assert.deepEqual(ev.map((e) => e.titolo), ["Palestra", "Palestra", "Cena <Anna> & amici"]);
    assert.equal(new Date(ev[0].inizio).toISOString(), "2026-11-16T17:30:00.000Z");
  } finally { await f.chiudi(); }
});

test("CalDAV: solo https verso *.icloud.com (anche nei reindirizzamenti); la password non va altrove", async () => {
  for (const u of ["http://caldav.icloud.com/", "https://icloud.com.cattivo.example/", "https://caldav.icloud.com:8443/", "https://u:p@caldav.icloud.com/", "https://127.0.0.1/", "https://evil.example/icloud.com"]) {
    assert.throws(() => urlIcloud(u), /non ammesso/, u);
  }
  assert.equal(urlIcloud("https://p12-caldav.icloud.com:443/x/").hostname, "p12-caldav.icloud.com");
  const f = await avviaCaldavFinto();
  try {
    f.reindirizza = "https://cattivo.example/rubare";
    await assert.rejects(scopriCalendari(cred, f.fetch), /non ammesso/);
    assert.ok(f.host.every((h) => h.endsWith(".icloud.com")), "nessuna richiesta fuori da iCloud");
    f.richieste.length = 0;
    f.reindirizza = "https://p01-caldav.icloud.com/";
    const cal = await scopriCalendari(cred, f.fetch);
    assert.equal(cal.length, 2, "un reindirizzamento dentro iCloud si segue");
  } finally { await f.chiudi(); }
});

test("Calendario Apple via API: Apple ID e password cifrati e mai restituiti, scelta dei calendari, briefing «oggi»", async () => {
  const f = await avviaCaldavFinto();
  const a = await avviaAmbiente({ fetchApple: f.fetch });
  try {
    await a.accedi();
    salvaSegreto(a.db, cifratore, "costructo_aziende", JSON.stringify([{ id: "a1", nome: "Edilgreen", token: TOKEN }]));
    const male = await a.chiama("/api/calendario-apple", { method: "PUT", json: { appleId: APPLE_ID, password: "sbagliata" } });
    assert.equal(male.status, 401);
    assert.equal(leggiApple({ db: a.db, cifratore }), null, "non salvato se Apple non accetta");
    const ok = await a.chiama("/api/calendario-apple", { method: "PUT", json: { appleId: APPLE_ID, password: APP_PASSWORD } });
    const stato = await ok.json();
    assert.equal(stato.collegato, true);
    assert.equal(stato.calendari.length, 2);
    assert.ok(!JSON.stringify(stato).includes(APP_PASSWORD), "la password non torna al browser");
    assert.ok(!JSON.stringify(stato).includes("mnop") && stato.password === "••••" && stato.passwordImpostata, "nemmeno le ultime cifre");
    const grezzo = a.db.prepare("SELECT valore FROM segreti WHERE nome = 'calendario_apple'").get() as { valore: string };
    assert.ok(!grezzo.valore.includes(APP_PASSWORD) && !grezzo.valore.includes(APPLE_ID), "cifrato nel database");
    assert.ok(!JSON.stringify(a.db.prepare("SELECT * FROM registro").all()).includes(APP_PASSWORD));
    // Lavoro EG → azienda Edilgreen; azienda inesistente rifiutata
    const lavoroUrl = stato.calendari.find((c: { nome: string }) => c.nome === "Lavoro EG").url;
    assert.equal((await a.chiama("/api/calendario-apple/calendari", { method: "PUT", json: { calendari: [{ url: lavoroUrl, incluso: true, spazio: "zzz" }] } })).status, 400);
    const scelto = await (await a.chiama("/api/calendario-apple/calendari", { method: "PUT", json: { calendari: [{ url: lavoroUrl, incluso: true, spazio: "a1" }] } })).json();
    assert.equal(scelto.calendari.find((c: { url: string }) => c.url === lavoroUrl).spazio, "a1");
    // eventi di oggi nel briefing
    const oggi = inizioGiorno(Date.now(), "Europe/Rome");
    f.eventi.casa = [`BEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Dentista\r\nDTSTART:${icsUtc(oggi + 20 * 3600_000)}\r\nDTEND:${icsUtc(oggi + 21 * 3600_000)}\r\nEND:VEVENT`];
    f.eventi.lavoro = [`BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:Riunione cantiere\r\nDTSTART:${icsUtc(oggi + 9 * 3600_000)}\r\nDTEND:${icsUtc(oggi + 10 * 3600_000)}\r\nEND:VEVENT`];
    const b = await (await a.chiama("/api/briefing")).json();
    const titoli = b.oggi.map((x: { titolo: string; spazio: string }) => `${x.spazio}:${x.titolo}`);
    assert.ok(titoli.includes("privato:Dentista"), titoli.join(","));
    assert.ok(titoli.includes("lavoro:Riunione cantiere"), titoli.join(","));
    assert.equal(b.oggi.find((x: { titolo: string }) => x.titolo === "Riunione cantiere").azienda, undefined, "senza Costructo non c'è la sezione, ma l'evento resta di lavoro");
    // prova e scollega
    assert.equal((await (await a.chiama("/api/calendario-apple/prova", { method: "POST", json: {} })).json()).ok, true);
    assert.equal((await (await a.chiama("/api/calendario-apple", { method: "DELETE" })).json()).collegato, false);
  } finally { await a.chiudi(); await f.chiudi(); }
});

test("Calendario Apple: cache di 5 minuti e un calendario che non risponde non ferma gli altri", async () => {
  const f = await avviaCaldavFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const fonte = { db, cifratore, fetchFn: f.fetch };
    await collegaApple(fonte, APPLE_ID, APP_PASSWORD);
    const imp = leggiApple(fonte)!;
    scegliCalendari(fonte, [{ url: imp.calendari[1].url, incluso: true, spazio: "privato" }], []);
    const da = Date.now(), a = da + 864e5;
    f.eventi.casa = [`BEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Uno\r\nDTSTART:${icsUtc(da + 3600_000)}\r\nEND:VEVENT`];
    const prima = await eventiApple(fonte, da, a, "Europe/Rome");
    assert.equal(prima.eventi.length, 1);
    const n = f.richieste.length;
    await eventiApple(fonte, da, a, "Europe/Rome");
    assert.equal(f.richieste.length, n, "dalla cache: nessuna richiesta");
    // un calendario non risponde: gli altri restano, l'errore diventa un avviso
    f.guasti.add("lavoro");
    const dopo = await eventiApple(fonte, da, a + 1, "Europe/Rome");
    assert.equal(dopo.eventi.length, 1);
    assert.equal(dopo.eventi[0].calendario, "Casa & famiglia");
    assert.match(dopo.avvisi[0], /Lavoro EG.*500/);
  } finally { chiudi(); await f.chiudi(); }
});

test("briefing: mail urgenti per azienda (con il nome) e private, eventi Apple in «oggi», notifiche del mattino", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    f.risposte["/briefing"] = { corpo: { cantieri: [{ nome: "Villa" }] } };
    f.risposte2["/briefing"] = { corpo: {} };
    const aziende: AziendaCollegata[] = [
      { id: "a1", nome: "Edilgreen", client: creaClientCostructo({ url: f.url, token: TOKEN }) },
      { id: "a2", nome: "Rossi Costruzioni", client: creaClientCostructo({ url: f.url, token: TOKEN_2 }) },
    ];
    const ora = Date.now();
    const mail = (spazio: string, oggetto: string, urgente: boolean, uid: number) => {
      const id = salvaMessaggio(db, { casellaId: "c", uid, uidValidity: "1", spazio, nuova: true, mail: {
        messageId: "", riferimenti: "", daNome: "Mario", daIndirizzo: "m@x.it", rispondiA: "", a: "", oggetto, data: ora - 3600_000 * uid, estratto: "", allegati: [], segni: {},
      } })!;
      db.prepare("UPDATE posta_messaggi SET urgente = ?, stato = 'classificato' WHERE id = ?").run(urgente ? 1 : 0, id);
    };
    mail("a1", "Gru ferma", true, 1);
    mail("a1", "Ponteggio", true, 2);
    mail("a1", "Newsletter", false, 3);
    mail("privato", "Banca: verifica", true, 4);
    mail("a2", "Vecchia", true, 30); // più di 24 ore fa: non conta
    const oggi = inizioGiorno(ora, "Europe/Rome");
    const apple = async (): Promise<{ eventi: EventoApple[]; avvisi: string[] }> => ({
      eventi: [
        { titolo: "Palestra", luogo: "", inizio: oggi + 19 * 3600_000, fine: oggi + 20 * 3600_000, tuttoIlGiorno: false, fonte: "calendario", calendario: "Casa", spazio: "privato" },
        { titolo: "Sopralluogo", luogo: "", inizio: oggi + 8 * 3600_000, fine: oggi + 9 * 3600_000, tuttoIlGiorno: false, fonte: "calendario", calendario: "Lavoro", spazio: "a2" },
      ],
      avvisi: [],
    });
    const b = await creaBriefing({ db, fuso: "Europe/Rome", aziende, linkCalendario: "", calendarioApple: apple });
    const testo = b.righe.map((r) => r.testo).join(" ");
    assert.match(testo, /Edilgreen: 1 cantiere aperto; 2 mail urgenti, la prima: «Ponteggio \(da Mario\)»\./);
    assert.equal(b.aziende[1].posta, undefined, "la mail di 30 ore fa non conta");
    assert.ok(!b.aziende[1].righe.some((r) => /mail urgent/.test(r.testo)));
    assert.match(testo, /Posta privata: 1 mail urgente, «Banca: verifica/);
    assert.equal(b.aziende[0].posta?.urgenti, 2);
    assert.equal(b.postaPrivata?.urgenti, 1);
    assert.ok(b.oggi.some((x) => x.titolo === "Palestra" && x.spazio === "privato"));
    assert.ok(b.oggi.some((x) => x.titolo === "Rossi Costruzioni: Sopralluogo" && x.spazio === "lavoro" && x.azienda === "Rossi Costruzioni"));
    assert.ok(b.adesso.some((c) => /Mail urgente/.test(c.testo)));
    const notifiche = notificheDelMattino(b);
    assert.match(notifiche.find((n) => n.titolo.startsWith("Edilgreen"))!.testo, /2 mail urgenti/);
    assert.match(notifiche.at(-1)!.testo, /Posta privata: 1 mail urgente/);
  } finally { chiudi(); await f.chiudi(); }
});
