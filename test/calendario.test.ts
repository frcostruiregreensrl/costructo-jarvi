import { test } from "node:test";
import assert from "node:assert/strict";
import { analizzaIcs, occorrenze, controllaIndirizzo, scaricaCalendario, ipPrivato, creaLookupSicuro } from "../src/calendario.js";

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
SUMMARY:Riunione cantiere\\, Verdi
DTSTART;TZID=Europe/Rome:20261103T090000
DTEND;TZID=Europe/Rome:20261103T100000
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10
EXDATE;TZID=Europe/Rome:20261110T090000
END:VEVENT
BEGIN:VEVENT
UID:b
SUMMARY:Consiglio
DTSTART;TZID="W. Europe Standard Time":20261110T180000
DTEND;TZID="W. Europe Standard Time":20261110T190000
RRULE:FREQ=MONTHLY;BYDAY=2TU
END:VEVENT
BEGIN:VEVENT
UID:c
SUMMARY:Annullato
DTSTART:20261117T080000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:d
SUMMARY:Ferie
DTSTART;VALUE=DATE:20261120
DTEND;VALUE=DATE:20261121
END:VEVENT
END:VCALENDAR`;

test("iCal: ricorrenze settimanali con eccezione, «2° martedì», fusi Windows, eventi annullati", () => {
  const ev = analizzaIcs(ICS);
  assert.equal(ev.length, 3);
  const da = Date.UTC(2026, 10, 1), a = Date.UTC(2027, 0, 31);
  const occ = occorrenze(ev, da, a, "Europe/Rome");
  const riunioni = occ.filter((o) => o.titolo === "Riunione cantiere, Verdi").map((o) => new Date(o.inizio).toISOString().slice(0, 10));
  assert.equal(riunioni[0], "2026-11-03");
  assert.ok(!riunioni.includes("2026-11-10"), "EXDATE rispettata");
  assert.equal(new Date(occ[0].inizio).toISOString(), "2026-11-03T08:00:00.000Z");
  const consiglio = occ.filter((o) => o.titolo === "Consiglio").map((o) => new Date(o.inizio).toISOString().slice(0, 10));
  assert.deepEqual(consiglio, ["2026-11-10", "2026-12-08", "2027-01-12"], "secondo martedì di ogni mese");
  const ferie = occ.find((o) => o.titolo === "Ferie")!;
  assert.ok(ferie.tuttoIlGiorno);
});

test("iCal: solo https, niente indirizzi interni (SSRF), limite di dimensione", async () => {
  const pubblico = async () => ["93.184.216.34"];
  assert.equal((await controllaIndirizzo("webcal://p01-caldav.icloud.com/x.ics", pubblico)).protocol, "https:");
  await assert.rejects(controllaIndirizzo("http://esempio.it/a.ics", pubblico), /https/);
  await assert.rejects(controllaIndirizzo("https://interno.lan/a.ics", async () => ["192.168.1.10"]), /non ammesso/);
  await assert.rejects(controllaIndirizzo("https://127.0.0.1/a.ics"), /non ammesso/);
  await assert.rejects(controllaIndirizzo("https://[::1]/a.ics"), /non ammesso/);
  await assert.rejects(controllaIndirizzo("https://u:p@esempio.it/a.ics", pubblico), /nome utente/);
  assert.ok(ipPrivato("169.254.169.254") && ipPrivato("::ffff:10.0.0.1") && !ipPrivato("8.8.8.8"));
  // redirect verso la rete interna bloccato
  const fetchFinto = (async () => new Response("", { status: 302, headers: { location: "https://interno.lan/x" } })) as unknown as typeof fetch;
  const risolvi = async (h: string) => (h === "interno.lan" ? ["10.0.0.5"] : ["93.184.216.34"]);
  await assert.rejects(scaricaCalendario("https://pubblico.example/c.ics", { fetchFn: fetchFinto, risolvi, maxEtaMs: 0 }), /non ammesso/);
  const enorme = (async () => new Response("BEGIN:VCALENDAR\n" + "x".repeat(3 * 1024 * 1024))) as unknown as typeof fetch;
  await assert.rejects(scaricaCalendario("https://pubblico.example/grande.ics", { fetchFn: enorme, risolvi, maxEtaMs: 0 }), /troppo grande/);
  const buono = (async () => new Response(ICS)) as unknown as typeof fetch;
  assert.equal((await scaricaCalendario("https://pubblico.example/buono.ics", { fetchFn: buono, risolvi, maxEtaMs: 0 })).length, 3);
});

test("iCal (SSRF): IPv6 che nascondono indirizzi interni, nomi con più indirizzi, metadati", async () => {
  const pubblico = async () => ["93.184.216.34"];
  for (const u of [
    "https://[::ffff:127.0.0.1]/a.ics", "https://[::ffff:169.254.169.254]/", "https://[::127.0.0.1]/", "https://[64:ff9b::a9fe:a9fe]/",
    "https://[2002:7f00:1::]/", "https://0x7f.1/", "https://2130706433/", "https://127.1/", "https://[fd00:ec2::254]/", "https://[fe80::1]/",
    "https://[ff02::1]/", "https://100.100.100.200/", "https://[::]/", "https://0.0.0.0/", "https://[2001:0::1]/",
  ]) await assert.rejects(controllaIndirizzo(u, pubblico), /non ammesso/, u);
  for (const ip of ["8.8.8.8", "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::"]) assert.ok(!ipPrivato(ip), ip);
  assert.ok(ipPrivato("non-un-indirizzo"), "ciò che non si legge è bloccato");
  // basta UN indirizzo interno tra quelli del nome per bloccare
  await assert.rejects(controllaIndirizzo("https://misto.example/a.ics", async () => ["93.184.216.34", "10.0.0.1"]), /non ammesso/);
});

test("iCal (SSRF): ricontrollo al momento della connessione (DNS rebinding) e al massimo 3 reindirizzamenti", async () => {
  // il lookup dell'agente https restituisce solo indirizzi verificati
  const pubblico = creaLookupSicuro(async () => ["93.184.216.34", "2606:4700::1111"]);
  const tutti = await new Promise<unknown>((ok, ko) => pubblico("x.example", { all: true }, (e, a) => (e ? ko(e) : ok(a))));
  assert.deepEqual(tutti, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
  const interno = creaLookupSicuro(async () => ["127.0.0.1"]);
  await assert.rejects(new Promise((ok, ko) => interno("x.example", {}, (e, a) => (e ? ko(e) : ok(a)))), /non ammesso/);

  // il nome è pubblico al controllo ma diventa interno alla connessione: lo scaricamento si ferma
  let volte = 0;
  const cambia = async () => (volte++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
  await assert.rejects(scaricaCalendario("https://rebinding.example/c.ics", { risolvi: cambia, maxEtaMs: 0 }), /non ammesso/);
  assert.equal(volte, 2, "il nome è stato risolto di nuovo al momento della connessione");

  let salti = 0;
  const giro = (async () => new Response("", { status: 302, headers: { location: `https://pubblico.example/${++salti}` } })) as unknown as typeof fetch;
  await assert.rejects(scaricaCalendario("https://pubblico.example/c.ics", { fetchFn: giro, risolvi: async () => ["93.184.216.34"], maxEtaMs: 0 }), /troppi reindirizzamenti/);
  assert.equal(salti, 4, "la richiesta iniziale e 3 reindirizzamenti, poi stop");
});
