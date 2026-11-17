import { test } from "node:test";
import assert from "node:assert/strict";
import { analizzaIcs, occorrenze, controllaIndirizzo, scaricaCalendario, ipPrivato } from "../src/calendario.js";

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
