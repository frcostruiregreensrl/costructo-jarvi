import { test } from "node:test";
import assert from "node:assert/strict";
import { avviaAmbiente, dbProvvisorio, cifratore, leggiEventi } from "./aiuto.js";
import { avviaCostructoFinto, TOKEN, TOKEN_2 } from "./costructoFinto.js";
import { creaClientCostructo } from "../src/costructo.js";
import { leggiAziende, aziendeCollegate, aggiungiAzienda, rimuoviAzienda, provaAziende, trovaAziende, ID_PRINCIPALE, type FonteAziende, type AziendaCollegata } from "../src/aziende.js";
import { salvaSegreto, leggiSegreto, salvaImpostazioni } from "../src/impostazioni.js";
import { eseguiStrumento, type ContestoStrumenti } from "../src/strumenti.js";
import { creaBriefing, notificheDelMattino, testoNotifica } from "../src/briefing.js";
import { controllaOraBriefing, salvaIscrizione, type Invia } from "../src/push.js";
import { promptDiSistema } from "../src/prompt.js";
import { contestoDelTurno } from "../src/assistente.js";
import { aggiungiImpegno } from "../src/agenda.js";
import { creaCervelloFinto } from "../src/cervello/finto.js";
import { dataIso, daOraLocale } from "../src/tempo.js";

const due = (url: string): AziendaCollegata[] => [
  { id: "a1", nome: "Edilgreen", client: creaClientCostructo({ url, token: TOKEN }) },
  { id: "a2", nome: "Rossi Costruzioni", client: creaClientCostructo({ url, token: TOKEN_2 }) },
];
const contesto = (db: ContestoStrumenti["db"], aziende: AziendaCollegata[]): ContestoStrumenti => ({
  db, fuso: "Europe/Rome", vista: "lavoro", messaggioLuigi: "cantieri?", conversazione: "c", aziende, linkCalendario: () => "", emetti: () => {},
});
/** Il JSON dentro il primo blocco <dati_non_attendibili> del testo. */
const leggiJson = (contenuto: string) => {
  const righe = contenuto.split("\n");
  const i = righe.findIndex((r) => r.startsWith("<dati_non_attendibili"));
  return JSON.parse(righe[i + 1].replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"));
};

// ------------------------------------------------------------------ elenco, migrazione, aggiunte e rimozioni

test("aziende: il vecchio token unico diventa la prima azienda senza perderlo (salvato o da COSTRUCTO_TOKEN)", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const fonte: FonteAziende = { db, cifratore, urlAmbiente: f.url, tokenAmbiente: "" };
    assert.deepEqual(leggiAziende(fonte), []);
    salvaSegreto(db, cifratore, "costructo_token", TOKEN);
    assert.deepEqual(leggiAziende(fonte).map((a) => [a.id, a.token]), [[ID_PRINCIPALE, TOKEN]]);
    assert.equal(aziendeCollegate(fonte).length, 1);
    // aggiungendo la seconda, la prima entra nell'elenco con il nome letto da Costructo
    const nuova = await aggiungiAzienda(fonte, { token: TOKEN_2 });
    assert.equal(nuova.nome, "Rossi Costruzioni");
    assert.deepEqual(leggiAziende(fonte).map((a) => a.nome), ["Edilgreen", "Rossi Costruzioni"]);
    assert.equal(leggiSegreto(db, cifratore, "costructo_token"), "", "il vecchio segreto non serve più");
    const grezzo = db.prepare("SELECT valore FROM segreti WHERE nome = 'costructo_aziende'").get() as { valore: string };
    assert.ok(!grezzo.valore.includes(TOKEN) && !grezzo.valore.includes("csa_"), "l'elenco è cifrato nel database");

    // dalle variabili del server: vale finché non viene tolto
    const { db: db2, chiudi: chiudi2 } = dbProvvisorio();
    try {
      const amb: FonteAziende = { db: db2, cifratore, urlAmbiente: f.url, tokenAmbiente: TOKEN };
      assert.deepEqual(leggiAziende(amb).map((a) => a.token), [TOKEN]);
      await rimuoviAzienda(amb, ID_PRINCIPALE);
      assert.deepEqual(leggiAziende(amb), [], "tolto: il token del server non ricompare");
    } finally { chiudi2(); }
  } finally { chiudi(); await f.chiudi(); }
});

test("aziende: con segreto vecchio ≠ COSTRUCTO_TOKEN, togliendo le aziende il token del server non ricompare", async () => {
  const f = await avviaCostructoFinto();
  try {
    // 1) si toglie la sola azienda «principale» dopo «Prova il collegamento»
    {
      const { db, chiudi } = dbProvvisorio();
      try {
        const fonte: FonteAziende = { db, cifratore, urlAmbiente: f.url, tokenAmbiente: "csa_ambiente_vecchio_999" };
        salvaSegreto(db, cifratore, "costructo_token", TOKEN);
        await provaAziende(fonte);
        assert.deepEqual(leggiAziende(fonte).map((a) => [a.nome, a.token]), [["Edilgreen", TOKEN]]);
        await rimuoviAzienda(fonte, ID_PRINCIPALE);
        assert.deepEqual(leggiAziende(fonte), []);
      } finally { chiudi(); }
    }
    // 2) si aggiunge la seconda e poi si tolgono tutte e due
    {
      const { db, chiudi } = dbProvvisorio();
      try {
        const fonte: FonteAziende = { db, cifratore, urlAmbiente: f.url, tokenAmbiente: "csa_ambiente_vecchio_999" };
        salvaSegreto(db, cifratore, "costructo_token", TOKEN);
        await aggiungiAzienda(fonte, { token: TOKEN_2 });
        for (const a of leggiAziende(fonte)) await rimuoviAzienda(fonte, a.id);
        assert.deepEqual(leggiAziende(fonte), []);
      } finally { chiudi(); }
    }
  } finally { await f.chiudi(); }
});

test("aziende: una voce rovinata non fa sparire le altre; l'id di Costructo troppo lungo viene accorciato", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const fetchFn = (async () => Response.json({ azienda: { id: "x".repeat(500), nome: "Id lunghissimo" } })) as unknown as typeof fetch;
    const fonte: FonteAziende = { db, cifratore, urlAmbiente: "http://costructo.invalid", tokenAmbiente: "", fetchFn };
    const a = await aggiungiAzienda(fonte, { token: "csa_token_id_lungo_1" });
    assert.equal(a.aziendaId?.length, 80);
    assert.deepEqual(leggiAziende(fonte).map((x) => x.nome), ["Id lunghissimo"], "l'elenco salvato resta valido");
    // voce rovinata scritta a mano: si scarta solo quella, e il registro lo dice (senza token)
    const elenco = [...leggiAziende(fonte), { id: "rotta", nome: "", token: "csa_rotto_xxxxxxxx", aziendaId: "y".repeat(300) }];
    salvaSegreto(db, cifratore, "costructo_aziende", JSON.stringify(elenco));
    assert.deepEqual(leggiAziende(fonte).map((x) => x.nome), ["Id lunghissimo"]);
    leggiAziende(fonte);
    const reg = db.prepare("SELECT dettagli FROM registro WHERE azione = 'collegamenti.lettura'").all() as Array<{ dettagli: string }>;
    assert.equal(reg.length, 1, "segnalato una volta sola");
    assert.match(reg[0].dettagli, /"scartate":1/);
    assert.ok(!reg[0].dettagli.includes("csa_"));
  } finally { chiudi(); }
});

test("aziende: due aggiunte in parallelo non si perdono", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    const fetchFn = (async (_u: URL | string, init?: RequestInit) => {
      const t = String(new Headers(init?.headers).get("authorization")).slice(-1);
      await new Promise((r) => setTimeout(r, t === "1" ? 60 : 10));
      return Response.json({ azienda: { id: `z${t}`, nome: `Impresa ${t}` } });
    }) as unknown as typeof fetch;
    const fonte: FonteAziende = { db, cifratore, urlAmbiente: "http://costructo.invalid", tokenAmbiente: "", fetchFn };
    await Promise.all([1, 2, 3].map((i) => aggiungiAzienda(fonte, { token: `csa_parallelo_numero_${i}` })));
    assert.deepEqual(leggiAziende(fonte).map((a) => a.nome).sort(), ["Impresa 1", "Impresa 2", "Impresa 3"]);
  } finally { chiudi(); }
});

test("aziende via API: aggiungi, doppioni rifiutati, token non accettato, rinomina, rimuovi", async () => {
  const f = await avviaCostructoFinto();
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const aggiungi = (token: string, nome?: string) => a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token, nome } });
    let r = await aggiungi(TOKEN);
    assert.equal(r.status, 400, "senza indirizzo non si aggiunge");
    assert.match((await r.json()).errore, /indirizzo/);
    assert.equal((await a.chiama("/api/collegamenti", { method: "PUT", json: { costructoUrl: f.url } })).status, 200);

    r = await aggiungi(TOKEN);
    assert.equal(r.status, 200);
    let stato = await r.json();
    assert.deepEqual(stato.aziende.map((x: { nome: string }) => x.nome), ["Edilgreen"]);
    assert.equal(stato.aziende[0].token, "••••7890");

    r = await aggiungi(TOKEN);
    assert.equal(r.status, 400);
    assert.match((await r.json()).errore, /già collegato/);

    // stessa azienda in Costructo con un altro token: rifiutata
    f.risposte2["/io"] = { corpo: { versione: 1, azienda: { id: 11, nome: "Edilgreen" } } };
    r = await aggiungi(TOKEN_2);
    assert.equal(r.status, 400);
    assert.match((await r.json()).errore, /già collegata \(Edilgreen\)/);
    delete f.risposte2["/io"];

    r = await aggiungi("csa_sconosciuto_000000");
    assert.equal(r.status, 400);
    assert.match((await r.json()).errore, /non ha accettato questo token/);
    r = await aggiungi("token-senza-formato");
    assert.equal(r.status, 400);
    assert.match((await r.json()).errore, /csa_/);

    r = await aggiungi(TOKEN_2);
    stato = await r.json();
    assert.deepEqual(stato.aziende.map((x: { nome: string }) => x.nome), ["Edilgreen", "Rossi Costruzioni"]);
    const idRossi = stato.aziende[1].id;

    r = await a.chiama(`/api/collegamenti/aziende/${idRossi}`, { method: "PATCH", json: { nome: "Rossi" } });
    assert.equal((await r.json()).aziende[1].nome, "Rossi");
    r = await a.chiama(`/api/collegamenti/aziende/${idRossi}`, { method: "PATCH", json: { nome: "edilgreen" } });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).codice, "nome_esistente", "l'interfaccia fa scrivere un altro nome");

    // il vecchio campo «token unico» non può sovrascrivere l'elenco, e l'errore non lascia modifiche a metà
    r = await a.chiama("/api/collegamenti", { method: "PUT", json: { costructoUrl: "https://altro.example", costructoToken: TOKEN } });
    assert.equal(r.status, 400);
    assert.equal((await (await a.chiama("/api/impostazioni")).json()).collegamenti.costructoUrl, f.url, "l'indirizzo non è cambiato");

    r = await a.chiama(`/api/collegamenti/aziende/${idRossi}`, { method: "DELETE" });
    assert.deepEqual((await r.json()).aziende.map((x: { nome: string }) => x.nome), ["Edilgreen"]);
    assert.equal((await a.chiama("/api/collegamenti/aziende/inesistente", { method: "DELETE" })).status, 404);

    const reg = a.db.prepare("SELECT dettagli FROM registro WHERE azione = 'collegamenti.modifica'").all() as Array<{ dettagli: string }>;
    assert.ok(reg.some((x) => x.dettagli.includes("azienda.aggiungi")) && reg.some((x) => x.dettagli.includes("azienda.rimuovi")));
  } finally { await a.chiudi(); await f.chiudi(); }
});

test("aziende: al massimo 5; il nome scelto da Luigi vale più di quello di Costructo", async () => {
  const { db, chiudi } = dbProvvisorio();
  try {
    // Costructo finto senza server: ogni token è un'azienda diversa.
    const fetchFn = (async (_u: URL | string, init?: RequestInit) => {
      const t = String(new Headers(init?.headers).get("authorization")).slice(-1);
      return Response.json({ versione: 1, azienda: { id: `z${t}`, nome: `Impresa ${t}` } });
    }) as unknown as typeof fetch;
    const fonte: FonteAziende = { db, cifratore, urlAmbiente: "http://costructo.invalid", tokenAmbiente: "", fetchFn };
    for (let i = 1; i <= 5; i++) await aggiungiAzienda(fonte, { token: `csa_token_numero_${i}`, nome: i === 1 ? "La mia impresa" : undefined });
    assert.deepEqual(leggiAziende(fonte).map((a) => a.nome), ["La mia impresa", "Impresa 2", "Impresa 3", "Impresa 4", "Impresa 5"]);
    await assert.rejects(aggiungiAzienda(fonte, { token: "csa_token_numero_6" }), /al massimo 5/);
  } finally { chiudi(); }
});

test("aziende: nessuna risposta dell'API e nessuna riga del registro contiene un token in chiaro", async () => {
  const f = await avviaCostructoFinto();
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    const corpi: string[] = [];
    const prendi = async (p: Promise<Response>) => { const r = await p; corpi.push(await r.text()); return r; };
    await prendi(a.chiama("/api/collegamenti", { method: "PUT", json: { costructoUrl: f.url } }));
    await prendi(a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN } }));
    await prendi(a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN_2 } }));
    await prendi(a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN_2 } }));
    await prendi(a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: "csa_sconosciuto_000000" } }));
    await prendi(a.chiama("/api/collegamenti/aziende"));
    await prendi(a.chiama("/api/impostazioni"));
    await prendi(a.chiama("/api/avvio"));
    const prova = await prendi(a.chiama("/api/collegamenti/costructo/prova", { method: "POST", json: {} }));
    assert.equal(prova.status, 200);
    await prendi(a.chiama("/api/briefing"));
    await prendi(a.chiama("/api/registro"));
    const tutto = corpi.join("\n");
    for (const t of [TOKEN, TOKEN_2, "csa_sconosciuto_000000", "csa_prova", "csa_seconda"]) assert.ok(!tutto.includes(t), `il token ${t.slice(0, 8)}… non deve uscire`);
    const righe = (a.db.prepare("SELECT dettagli FROM registro").all() as Array<{ dettagli: string }>).map((x) => x.dettagli).join("\n");
    assert.ok(!righe.includes("csa_"), "il registro non contiene token");
  } finally { await a.chiudi(); await f.chiudi(); }
});

test("aziende: «Prova il collegamento» dà l'esito di ogni azienda", async () => {
  const f = await avviaCostructoFinto();
  const a = await avviaAmbiente();
  try {
    await a.accedi();
    await a.chiama("/api/collegamenti", { method: "PUT", json: { costructoUrl: f.url } });
    await a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN } });
    await a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN_2 } });
    f.risposte2["/io"] = { stato: 401 };
    const r = await (await a.chiama("/api/collegamenti/costructo/prova", { method: "POST", json: {} })).json();
    assert.equal(r.ok, false);
    assert.deepEqual(r.aziende.map((x: { nome: string; ok: boolean }) => [x.nome, x.ok]), [["Edilgreen", true], ["Rossi Costruzioni", false]]);
    assert.match(r.messaggio, /Edilgreen: collegata · Rossi Costruzioni: .*token/);
  } finally { await a.chiudi(); await f.chiudi(); }
});

// ------------------------------------------------------------------ strumenti dell'AI

test("strumenti: con una sola azienda si usa quella; se l'AI scrive un altro nome, una nota lo dice", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    f.risposte["/cantieri"] = { corpo: [{ nome: "Villa Verdi" }] };
    const sola = due(f.url).slice(0, 1);
    for (const azienda of [undefined, "", "edilgreen", "Bianchi"]) {
      const r = await eseguiStrumento("costructo_cantieri", azienda === undefined ? {} : { azienda }, contesto(db, sola));
      assert.equal(r.errore, false);
      const d = leggiJson(r.contenuto);
      assert.equal(d.azienda, "Edilgreen");
      assert.equal(d.dati[0].nome, "Villa Verdi");
      if (azienda === "Bianchi") {
        assert.equal(d.nota, "Nessuna azienda collegata si chiama «Bianchi»; questi dati sono di Edilgreen.");
        assert.ok(!r.contenuto.split("<dati_non_attendibili")[0].includes("Edilgreen"), "il nome dell'azienda sta solo dentro i dati");
      } else assert.equal(d.nota, undefined);
    }
  } finally { chiudi(); await f.chiudi(); }
});

test("strumenti: due aziende senza nome → legge tutte, ogni dato con la sua azienda; con nome → solo quella", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    f.risposte["/cantieri"] = { corpo: [{ nome: "Villa Verdi" }] };
    f.risposte2["/cantieri"] = { corpo: [{ nome: "Scuola Rossi" }, { nome: "Capannone" }] };
    const tutte = await eseguiStrumento("costructo_cantieri", { azienda: "" }, contesto(db, due(f.url)));
    assert.ok(tutte.contenuto.startsWith('<dati_non_attendibili fonte="costructo">'));
    const d = leggiJson(tutte.contenuto);
    assert.match(d.nota, /non sommare/);
    assert.deepEqual(d.aziende.map((x: { azienda: string; dati: unknown[] }) => [x.azienda, x.dati.length]), [["Edilgreen", 1], ["Rossi Costruzioni", 2]]);

    f.richieste.length = 0;
    const soloRossi = await eseguiStrumento("costructo_cantieri", { azienda: "rossi" }, contesto(db, due(f.url)));
    assert.equal(leggiJson(soloRossi.contenuto).azienda, "Rossi Costruzioni");
    assert.deepEqual(f.richieste.map((x) => x.auth), [`Bearer ${TOKEN_2}`], "letta solo l'azienda nominata");
    const perId = await eseguiStrumento("costructo_agenda", { giorni: 2, azienda: "a1" }, contesto(db, due(f.url)));
    assert.equal(perId.errore, true, "agenda non presente nel finto: errore, con il nome dell'azienda dentro i dati");
    assert.deepEqual(leggiJson(perId.contenuto), { azienda: "Edilgreen", errore: "Questa funzione non c'è ancora in Costructo." });
    assert.ok(!perId.contenuto.split("<dati_non_attendibili")[0].includes("Edilgreen"));
  } finally { chiudi(); await f.chiudi(); }
});

test("strumenti: azienda sconosciuta o ambigua → niente lettura, l'AI deve chiedere «di quale azienda parli?»", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const r = await eseguiStrumento("costructo_scadenze", { azienda: "Bianchi" }, contesto(db, due(f.url)));
    assert.equal(r.errore, false);
    assert.match(r.contenuto, /Di quale azienda parli: Edilgreen o Rossi Costruzioni\?/);
    assert.deepEqual(leggiJson(r.contenuto).aziendeCollegate, ["Edilgreen", "Rossi Costruzioni"]);
    assert.ok(!r.contenuto.split("<dati_non_attendibili")[0].match(/Edilgreen|Bianchi/), "nomi solo dentro i dati");
    const amb = [...due(f.url), { id: "a3", nome: "Rossi Impianti", client: creaClientCostructo({ url: f.url, token: TOKEN }) }];
    const r2 = await eseguiStrumento("costructo_cerca", { testo: "fattura 12", azienda: "Rossi" }, contesto(db, amb));
    assert.match(r2.contenuto, /più di un'azienda[\s\S]*Di quale azienda parli: Edilgreen, Rossi Costruzioni o Rossi Impianti\?/);
    assert.equal(f.richieste.length, 0, "nessuna chiamata a Costructo");
    assert.deepEqual(trovaAziende(due(f.url), "EDILGREEN srl").map((a) => a.id), ["a1"], "anche se Luigi aggiunge parole al nome");
  } finally { chiudi(); await f.chiudi(); }
});

test("strumenti: l'errore di un'azienda non nasconde i dati dell'altra", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    f.risposte["/scadenze"] = { corpo: [{ titolo: "F24 Edilgreen" }] };
    f.risposte2["/scadenze"] = { stato: 500 };
    const r = await eseguiStrumento("costructo_scadenze", {}, contesto(db, due(f.url)));
    assert.equal(r.errore, false);
    const d = leggiJson(r.contenuto);
    assert.equal(d.aziende[0].dati[0].titolo, "F24 Edilgreen");
    assert.equal(d.aziende[1].azienda, "Rossi Costruzioni");
    assert.match(d.aziende[1].errore, /problema \(500\)/);
    f.risposte["/scadenze"] = { stato: 401 };
    const tutte = await eseguiStrumento("costructo_scadenze", {}, contesto(db, due(f.url)));
    assert.equal(tutte.errore, true);
    const errori = leggiJson(tutte.contenuto).aziende;
    assert.equal(errori[0].azienda, "Edilgreen");
    assert.match(errori[0].errore, /token/);
    assert.match(errori[1].errore, /500/);
  } finally { chiudi(); await f.chiudi(); }
});

// ------------------------------------------------------------------ briefing e notifiche

async function briefingDue(f: Awaited<ReturnType<typeof avviaCostructoFinto>>, db: ContestoStrumenti["db"]) {
  f.risposte["/briefing"] = { corpo: {
    impegni: [{ titolo: "Sopralluogo Villa Verdi", inizio: new Date(Date.now() + 3600_000).toISOString() }],
    cantieri: [{ nome: "Villa Verdi" }, { nome: "Scuola" }, { nome: "Ponte" }],
    scadenze: [{ titolo: "F24 di novembre", scadenza: "2026-11-30" }],
  } };
  f.risposte2["/briefing"] = { corpo: { cantieri: [{ nome: "Capannone" }], fattureDaIncassare: [{ cliente: "Bianchi", residuo: 800 }], documentiInScadenza: [{ titolo: "DURC" }] } };
  return creaBriefing({ db, fuso: "Europe/Rome", aziende: due(f.url), linkCalendario: "" });
}

test("briefing con due aziende: una parte per azienda, ogni frase con il nome, «Adesso» con il nome", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const b = await briefingDue(f, db);
    const testo = b.righe.map((r) => r.testo).join(" ");
    assert.match(testo, /Edilgreen: 3 cantieri aperti, 1 scadenza in arrivo \(la prima: F24 di novembre\)\./);
    assert.match(testo, /Rossi Costruzioni: 1 cantiere aperto, 1 documento in scadenza \(per esempio DURC\), 1 fattura da incassare per 800\s€\./);
    assert.match(testo, /il primo alle \d\d:\d\d: Edilgreen: Sopralluogo Villa Verdi/);
    assert.deepEqual(b.aziende.map((x) => x.nome), ["Edilgreen", "Rossi Costruzioni"]);
    assert.equal(b.lavoro, null, "con più aziende i dati stanno in «aziende»");
    assert.equal(b.adesso.length, 3);
    for (const c of b.adesso.filter((x) => x.spazio === "lavoro")) assert.match(c.testo, /^(Edilgreen|Rossi Costruzioni): /);
    assert.ok(b.adesso.some((c) => c.azienda === "Rossi Costruzioni"), "anche la seconda azienda ha il suo posto in «Adesso»");
    assert.equal(b.oggi.find((x) => x.spazio === "lavoro")?.azienda, "Edilgreen");
    const ids = b.righe.filter((r) => r.numero).map((r) => r.numero!.id);
    assert.equal(new Set(ids).size, ids.length, "numeri con id diversi per azienda");
  } finally { chiudi(); await f.chiudi(); }
});

test("briefing con due aziende: se una non risponde, l'altra c'è lo stesso e l'avviso dice quale", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    f.risposte["/briefing"] = { corpo: { cantieri: [{ nome: "Villa Verdi" }] } };
    f.risposte2["/briefing"] = { stato: 500 };
    const b = await creaBriefing({ db, fuso: "Europe/Rome", aziende: due(f.url), linkCalendario: "" });
    const testo = b.righe.map((r) => r.testo).join(" ");
    assert.match(testo, /Edilgreen: 1 cantiere aperto/);
    assert.match(testo, /Rossi Costruzioni: Costructo non ha risposto/);
    assert.match(b.avvisi.join(" "), /^Rossi Costruzioni: Costructo ha avuto un problema/);
  } finally { chiudi(); await f.chiudi(); }
});

test("notifiche: due aziende → una notifica per azienda (più una privata solo se c'è qualcosa di privato)", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    let n = notificheDelMattino(await briefingDue(f, db));
    assert.equal(n.length, 2);
    assert.match(n[0].titolo, /^Edilgreen/);
    assert.match(n[0].testo, /^Edilgreen: 3 cantieri aperti.*Impegni di lavoro oggi: 1\./);
    assert.match(n[1].titolo, /^Rossi Costruzioni/);
    assert.match(n[1].testo, /^Rossi Costruzioni: /);
    assert.ok(n.every((x) => x.testo.length <= 180));

    aggiungiImpegno(db, { titolo: "Dentista", data: dataIso(Date.now(), "Europe/Rome"), ora: "23:59" }, "Europe/Rome");
    n = notificheDelMattino(await briefingDue(f, db));
    assert.equal(n.length, 3);
    assert.match(n[2].testo, /1 impegno personale, il primo alle 23:59: Dentista/);

    // con una sola azienda: una notifica, come prima
    const una = await creaBriefing({ db, fuso: "Europe/Rome", aziende: due(f.url).slice(0, 1), linkCalendario: "" });
    assert.deepEqual(notificheDelMattino(una), [{ titolo: "Buongiorno da Jarvis", testo: testoNotifica(una) }]);
    assert.match(una.righe.map((r) => r.testo).join(" "), /Cantieri aperti: 3\./, "una sola azienda: frasi di sempre");
  } finally { chiudi(); await f.chiudi(); }
});

test("notifiche: con due aziende partono 2 notifiche UNA sola volta al giorno, non a ogni minuto", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const inviate: Array<{ titolo: string }> = [];
    const invia: Invia = async (_i, corpo) => { inviate.push(JSON.parse(corpo)); return { statusCode: 201 }; };
    salvaIscrizione(db, { endpoint: "https://push.example/abc", keys: { p256dh: "chiave-finta-p256dh", auth: "auth-finta" } });
    salvaImpostazioni(db, { orarioBriefing: "07:00" });
    const prepara = async () => notificheDelMattino(await briefingDue(f, db));
    const giorno = (g: number, h: number, m: number) => daOraLocale(2026, 10, g, h, m, "Europe/Rome");
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", prepara, invia, giorno(18, 7, 0)), true);
    for (let m = 1; m < 10; m++) assert.equal(await controllaOraBriefing(db, "Europe/Rome", prepara, invia, giorno(18, 7, m)), false);
    assert.deepEqual(inviate.map((x) => x.titolo.split(" · ")[0]), ["Edilgreen", "Rossi Costruzioni"]);
    assert.equal(await controllaOraBriefing(db, "Europe/Rome", prepara, invia, giorno(19, 7, 5)), true, "il giorno dopo ripartono");
    assert.equal(inviate.length, 4);
  } finally { chiudi(); await f.chiudi(); }
});

// ------------------------------------------------------------------ prompt e contesto del turno

test("prompt e contesto: elenco delle aziende come dati, regola «di quale azienda parli?» nel prompt", async () => {
  const f = await avviaCostructoFinto();
  const { db, chiudi } = dbProvvisorio();
  try {
    const p = promptDiSistema("Luigi");
    assert.match(p, /Di quale azienda parli: X o Y\?/);
    assert.match(p, /Non mescolare mai i dati di aziende diverse/);
    const c = contestoDelTurno({ db, fuso: "Europe/Rome" }, "tutto", due(f.url));
    assert.match(c, /Aziende collegate: 2/);
    assert.match(c, /<dati_non_attendibili fonte="aziende">\n\["Edilgreen","Rossi Costruzioni"\]/);
    assert.doesNotMatch(contestoDelTurno({ db, fuso: "Europe/Rome" }, "privato", due(f.url)), /Edilgreen/, "nella scheda Privato niente lavoro");
  } finally { chiudi(); await f.chiudi(); }
});

test("prompt e contesto: dal vivo l'AI riceve i nomi delle aziende nel turno, non nel prompt di sistema", async () => {
  const f = await avviaCostructoFinto();
  const cervello = creaCervelloFinto(() => ({ testo: "Di quale azienda parli: Edilgreen o Rossi Costruzioni?" }));
  const a = await avviaAmbiente({ cervello: async () => cervello });
  try {
    await a.accedi();
    await a.chiama("/api/collegamenti", { method: "PUT", json: { costructoUrl: f.url } });
    await a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN } });
    await a.chiama("/api/collegamenti/aziende", { method: "POST", json: { token: TOKEN_2 } });
    await leggiEventi(await a.chiama("/api/chiedi", { method: "POST", json: { messaggio: "quanto devo incassare?", vista: "lavoro" } }));
    const r = cervello.richieste[0];
    const turno = r.messaggi.at(-1)!;
    assert.ok(turno.ruolo === "utente" && /Edilgreen","Rossi Costruzioni/.test(turno.testo));
    assert.ok(!r.sistema.includes("Edilgreen"));
    const cantieri = r.strumenti.find((s) => s.nome === "costructo_cantieri")!;
    assert.deepEqual((cantieri.schema as { required: string[] }).required, ["azienda"], "schema strict: il campo c'è sempre (vuoto = tutte)");
  } finally { await a.chiudi(); await f.chiudi(); }
});
