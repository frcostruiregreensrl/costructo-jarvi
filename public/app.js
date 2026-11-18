// Interfaccia principale di Jarvis (PWA per iPhone, iPad e Mac).
import { api, chiedi, NonAutenticato } from "./api.js";
import { Voce, Ascolto, divisoreFrasi } from "./voce.js";
import { createScena2D } from "./classic/scena2d.js";

const $ = (s) => document.querySelector(s);
const crea = (tag, classe, testo) => { const el = document.createElement(tag); if (classe) el.className = classe; if (testo !== undefined) el.textContent = testo; return el; };

const stato = {
  vista: leggiLocale("vista", "tutto"),
  vistaMemoria: "tutto",
  conversazione: { privato: null, lavoro: null, tutto: null },
  impostazioni: null,
  briefing: null,
  inCorso: null,
  ultimoRegistro: null,
  urlSalvato: "",
};

function leggiLocale(k, predefinito) { try { return localStorage.getItem(`jarvis.${k}`) || predefinito; } catch { return predefinito; } }
function scriviLocale(k, v) { try { localStorage.setItem(`jarvis.${k}`, v); } catch { /* navigazione privata */ } }

// ------------------------------------------------------------------ sfera e voce
const scena = createScena2D($("#sfera"), null, { compatta: true });
scena.setMode("sleep");
const voce = new Voce({
  onLivello: (v) => scena.setLevel(v),
  onFrase: () => { scena.setMode("speak"); impostaStato("Rispondo"); },
  onRiposo: () => { if (!ascolto.attivo) { scena.setMode("sleep"); impostaStato("Pronto"); } },
});
const ascolto = new Ascolto({
  continuo: false,
  onParziale: (t) => { $("#domanda").value = t; },
  onFinale: (t) => { $("#domanda").value = ""; invia(t); },
  onStato: (s) => {
    const attivo = s === "ascolto";
    $("#parla").setAttribute("aria-pressed", String(attivo));
    $("#parla span").textContent = attivo ? "Ti ascolto… tocca per fermare" : "Parla";
    document.body.classList.toggle("ascolta", attivo);
    if (attivo) { scena.setMode("listen"); impostaStato("In ascolto"); }
    else if (!voce.occupata && !stato.inCorso) { scena.setMode("sleep"); impostaStato("Pronto"); }
  },
  onErrore: (e) => {
    if (e === "not-allowed" || e === "service-not-allowed") impostaStato("Microfono non consentito: scrivi qui sotto");
    else if (e === "non-disponibile") impostaStato("Riconoscimento vocale non disponibile: scrivi qui sotto");
    else impostaStato("Non ho capito, riprova");
  },
});
function impostaStato(t) { $("#statoVoce").textContent = t; }

// ------------------------------------------------------------------ tema
function applicaTema(t) {
  const r = document.documentElement;
  if (t === "chiaro") r.dataset.theme = "light";
  else if (t === "scuro") r.dataset.theme = "dark";
  else delete r.dataset.theme;
  scriviLocale("tema", t || "automatico");
}
applicaTema(leggiLocale("tema", "automatico"));

// ------------------------------------------------------------------ accesso
async function avvia() {
  let s;
  try { s = await api("/api/stato"); } catch { s = { accesso: false }; }
  if (!s.accesso) return s.primoAccesso ? mostraPrimo() : mostraAccesso();
  try {
    const a = await api("/api/avvio");
    stato.impostazioni = a.impostazioni;
    applicaTema(a.impostazioni.tema);
    voce.nomeVoce = a.impostazioni.vocePreferita;
    voce.velocita = a.impostazioni.velocitaVoce;
    $("#saluto").textContent = `Ciao ${a.nome}`;
    $("#accesso").hidden = true;
    $("#app").hidden = false;
    impostaVista(stato.vista);
    instrada();
    caricaBriefing();
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    impostaStato("Server non raggiungibile");
  }
}
function mostraAccesso() {
  $("#app").hidden = true;
  $("#accesso").hidden = false;
  $("#formPrimo").hidden = true;
  $("#formAccesso").hidden = false;
  $("#password").focus();
}
function mostraPrimo() {
  $("#app").hidden = true;
  $("#accesso").hidden = false;
  $("#formAccesso").hidden = true;
  $("#formPrimo").hidden = false;
  $("#primoCodice").focus();
}
$("#formPrimo").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#errorePrimo").textContent = "";
  const bottone = $("#formPrimo button[type=submit]");
  bottone.disabled = true;
  try {
    const r = await api("/api/primo-accesso", { metodo: "POST", corpo: {
      codice: $("#primoCodice").value, nome: $("#primoNome").value.trim(), password: $("#primoPassword").value } });
    $("#primoCodice").value = $("#primoPassword").value = "";
    $("#primoSegreto").textContent = r.segreto;
    $("#primoLink").href = r.link;
    $("#primoFatto").hidden = false;
    bottone.hidden = true;
  } catch (err) {
    $("#errorePrimo").textContent = err.message;
    bottone.disabled = false;
  }
});
$("#primoVaiAccesso").addEventListener("click", () => mostraAccesso());
$("#formAccesso").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#erroreAccesso").textContent = "";
  const bottone = e.submitter || $("#formAccesso button");
  bottone.disabled = true;
  try {
    await api("/api/accesso", { metodo: "POST", corpo: { password: $("#password").value, codice: $("#codice").value.trim() } });
    $("#password").value = $("#codice").value = "";
    await avvia();
  } catch (err) {
    $("#erroreAccesso").textContent = err.message;
  } finally { bottone.disabled = false; }
});
$("#esci").addEventListener("click", async () => {
  await api("/api/uscita", { metodo: "POST", corpo: {} }).catch(() => {});
  location.hash = "";
  mostraAccesso();
});

// ------------------------------------------------------------------ menu e pagine
$("#apriMenu").addEventListener("click", () => {
  const aperto = $("#menu").hidden;
  $("#menu").hidden = !aperto;
  $("#apriMenu").setAttribute("aria-expanded", String(aperto));
  if (aperto) $("#menu a").focus();
});
document.addEventListener("click", (e) => {
  if (!$("#menu").hidden && !e.target.closest("#menu, #apriMenu")) { $("#menu").hidden = true; $("#apriMenu").setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#menu").hidden) { $("#menu").hidden = true; $("#apriMenu").focus(); } });
addEventListener("hashchange", instrada);

const PAGINE = ["home", "memoria", "registro", "spesa", "impostazioni"];
function instrada() {
  if ($("#app").hidden) return;
  let p = location.hash.replace("#", "") || "home";
  const vuoleParlare = p === "parla";
  if (!PAGINE.includes(p)) p = "home";
  for (const n of PAGINE) $(`#pagina-${n}`).hidden = n !== p;
  $("#barraParla").hidden = p !== "home";
  document.querySelectorAll("#menu a").forEach((a) => a.toggleAttribute("aria-current", a.getAttribute("href") === `#${p}`));
  if (a11yCambio) $("#principale").focus({ preventScroll: true });
  a11yCambio = true;
  $("#menu").hidden = true;
  if (p === "memoria") caricaMemorie();
  if (p === "registro") caricaRegistro(true);
  if (p === "spesa") caricaSpesa();
  if (p === "impostazioni") caricaImpostazioni();
  if (vuoleParlare) { $("#parla").focus(); impostaStato("Tocca Parla e chiedi"); }
}
let a11yCambio = false;

// ------------------------------------------------------------------ schede Privato / Lavoro / Tutto
function impostaVista(v) {
  stato.vista = v;
  scriviLocale("vista", v);
  document.querySelectorAll("[data-vista]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.vista === v)));
  $("#dialogo").textContent = "";
  disegnaAdesso();
}
document.querySelectorAll("[data-vista]").forEach((b) => b.addEventListener("click", () => impostaVista(b.dataset.vista)));

// ------------------------------------------------------------------ briefing e «Adesso»
async function caricaBriefing() {
  try {
    stato.briefing = await api("/api/briefing");
    disegnaAdesso();
    $("#avvisiBriefing").textContent = stato.briefing.avvisi.join(" · ");
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    $("#adesso").replaceChildren(crea("li", "vuoto", "Briefing non disponibile."));
  }
}
function disegnaAdesso() {
  const b = stato.briefing;
  if (!b) return;
  const cose = b.adesso.filter((c) => stato.vista === "tutto" || c.spazio === stato.vista);
  const lista = $("#adesso");
  lista.replaceChildren();
  if (!cose.length) { lista.append(crea("li", "vuoto", "Niente di urgente. Buona giornata.")); return; }
  for (const c of cose) {
    const li = crea("li", c.spazio);
    const div = crea("div");
    // Lavoro: si vede sempre di quale azienda è (nel testo, se le aziende sono più di una, oppure qui sotto).
    const azienda = c.spazio === "lavoro" && c.azienda && !c.testo.startsWith(c.azienda) ? ` · ${c.azienda}` : "";
    div.append(crea("b", "", c.testo), crea("small", "", `${c.spazio === "lavoro" ? "Lavoro" : "Privato"}${azienda}${c.quando ? ` · ${c.quando}` : ""}`));
    li.append(div);
    lista.append(li);
  }
}
$("#leggiBriefing").addEventListener("click", () => {
  voce.sblocca();
  if (!stato.briefing) return;
  voce.stop();
  for (const r of stato.briefing.righe) { voce.di(r.testo); aggiungiBattuta("jarvis", r.testo); }
});

// ------------------------------------------------------------------ conversazione
function aggiungiBattuta(chi, testo = "") {
  const el = crea("div", `battuta ${chi}`, testo);
  $("#dialogo").append(el);
  el.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  return el;
}
function mostraNumero(e) {
  const el = crea("div", "numero-grande");
  el.append(crea("small", "", e.etichetta), crea("b", "", `${Number(e.valore).toLocaleString("it-IT")}${e.suffisso || ""}`));
  $("#dialogo").append(el);
}
function mostraConferma(e) {
  const box = crea("div", "conferma");
  box.setAttribute("role", "group");
  box.append(crea("p", "", e.domanda));
  const azioni = crea("div", "azioni");
  const rispondi = async (scelta) => {
    azioni.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const r = await api(`/api/conferme/${encodeURIComponent(e.id)}`, { metodo: "POST", corpo: { scelta } });
      box.append(crea("p", "", r.messaggio));
      if (stato.impostazioni?.leggiRisposteAVoce) voce.di(r.messaggio);
      caricaBriefing();
    } catch (err) { box.append(crea("p", "", err.message)); }
  };
  if (e.opzioni?.length) {
    for (const o of e.opzioni) { const b = crea("button", "secondario", o.testo); b.addEventListener("click", () => rispondi(o.indice)); azioni.append(b); }
  } else {
    const si = crea("button", "primario", "Conferma"); si.addEventListener("click", () => rispondi("conferma")); azioni.append(si);
  }
  const no = crea("button", "secondario", "Annulla"); no.addEventListener("click", () => rispondi("annulla")); azioni.append(no);
  box.append(azioni);
  $("#dialogo").append(box);
}

async function invia(testo) {
  testo = testo.trim();
  if (!testo) return;
  voce.sblocca();
  voce.stop();
  stato.inCorso?.abort();
  const ctrl = new AbortController();
  stato.inCorso = ctrl;
  aggiungiBattuta("luigi", testo);
  const bolla = aggiungiBattuta("jarvis", "…");
  let scritto = "";
  scena.setMode("think");
  scena.burstSynapses(30);
  impostaStato("Ci penso");
  const leggi = stato.impostazioni?.leggiRisposteAVoce !== false;
  const frasi = divisoreFrasi((f) => { if (leggi) voce.di(f); });
  voce.aperta = leggi;
  try {
    await chiedi({ messaggio: testo, vista: stato.vista, conversazione: stato.conversazione[stato.vista] || undefined }, (e) => {
      if (e.tipo === "delta") { scritto += e.testo; bolla.textContent = scritto; frasi.aggiungi(e.testo); }
      else if (e.tipo === "numero") mostraNumero(e);
      else if (e.tipo === "conferma") mostraConferma(e);
      else if (e.tipo === "agenda") caricaBriefing();
      else if (e.tipo === "memoria") scena.highlight();
      else if (e.tipo === "strumento") scena.burstSynapses(20);
      else if (e.tipo === "avviso") $("#dialogo").append(crea("p", "avviso", e.testo));
      else if (e.tipo === "scarta") { scritto = e.testo; bolla.textContent = scritto || "…"; voce.stop(); }
      else if (e.tipo === "modello") bolla.dataset.modello = e.modello;
      else if (e.tipo === "fine") {
        stato.conversazione[stato.vista] = e.conversazione;
        if (bolla.dataset.modello) bolla.append(crea("span", "meta", nomeModello(bolla.dataset.modello)));
      }
    }, ctrl.signal);
    frasi.chiudi();
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    if (!ctrl.signal.aborted) { bolla.textContent = "La connessione si è interrotta. Riprova tra un istante."; if (leggi) voce.di(bolla.textContent); }
  } finally {
    voce.aperta = false;
    voce.prossima();
    if (stato.inCorso === ctrl) stato.inCorso = null;
    if (!voce.occupata) { scena.setMode("sleep"); impostaStato("Pronto"); }
  }
}
function nomeModello(m) {
  return { calcolatrice: "calcolatrice · gratis", "claude-haiku-5-5": "Claude Haiku", "claude-sonnet-5-5": "Claude Sonnet · ragionamento" }[m] || m;
}

$("#scrivi").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("#domanda").value;
  $("#domanda").value = "";
  invia(t);
});
$("#parla").addEventListener("click", () => {
  voce.sblocca();
  if (voce.occupata) { voce.stop(); stato.inCorso?.abort(); }
  if (ascolto.attivo) { ascolto.ferma(); return; }
  if (!ascolto.disponibile) { impostaStato("Riconoscimento vocale non disponibile: scrivi qui sotto"); $("#domanda").focus(); return; }
  ascolto.avvia();
});

// ------------------------------------------------------------------ «Cosa sa di me»
document.querySelectorAll("[data-mvista]").forEach((b) => b.addEventListener("click", () => {
  stato.vistaMemoria = b.dataset.mvista;
  document.querySelectorAll("[data-mvista]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  caricaMemorie();
}));
async function caricaMemorie() {
  const lista = $("#listaMemorie");
  try {
    const memorie = await api(`/api/memorie?vista=${stato.vistaMemoria}`);
    lista.replaceChildren();
    if (!memorie.length) { lista.append(crea("li", "vuoto", "Nessun ricordo in questo spazio.")); return; }
    for (const m of memorie) lista.append(rigaMemoria(m));
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function rigaMemoria(m) {
  const li = crea("li", m.spazio);
  const testo = crea("div", "testo-memoria", m.testo);
  const meta = crea("div", "meta", `${m.spazio === "lavoro" ? "Lavoro" : "Privato"} · ${m.origine === "luigi" ? "scritto da te" : "salvato da Jarvis"} · ${new Date(m.aggiornato).toLocaleDateString("it-IT")}`);
  const azioni = crea("div", "azioni");
  const modifica = crea("button", "secondario", "Correggi");
  const sposta = crea("button", "secondario", m.spazio === "lavoro" ? "Sposta in Privato" : "Sposta in Lavoro");
  const cancella = crea("button", "secondario", "Cancella");
  modifica.addEventListener("click", () => {
    const area = crea("textarea");
    area.value = m.testo;
    area.setAttribute("aria-label", "Correggi il ricordo");
    const salva = crea("button", "primario", "Salva");
    salva.addEventListener("click", async () => { await api(`/api/memorie/${m.id}`, { metodo: "PATCH", corpo: { testo: area.value } }); caricaMemorie(); });
    testo.replaceWith(area);
    azioni.replaceChildren(salva);
    area.focus();
  });
  sposta.addEventListener("click", async () => { await api(`/api/memorie/${m.id}`, { metodo: "PATCH", corpo: { spazio: m.spazio === "lavoro" ? "privato" : "lavoro" } }); caricaMemorie(); });
  cancella.addEventListener("click", async () => {
    if (!confirm(`Cancellare questo ricordo?\n\n«${m.testo}»`)) return;
    await api(`/api/memorie/${m.id}`, { metodo: "DELETE" });
    caricaMemorie();
  });
  azioni.append(modifica, sposta, cancella);
  li.append(testo, meta, azioni);
  return li;
}
$("#nuovaMemoria").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/memorie", { metodo: "POST", corpo: { spazio: $("#spazioMemoria").value, testo: $("#testoMemoria").value } });
  $("#testoMemoria").value = "";
  caricaMemorie();
});

// ------------------------------------------------------------------ «Cosa ha fatto»
const NOMI_AZIONI = {
  "accesso": "Accesso", "costructo.leggi": "Lettura da Costructo", "calendario.leggi": "Lettura del calendario", "agenda.leggi": "Lettura dell'agenda",
  "agenda.aggiungi": "Impegno aggiunto", "agenda.cancella": "Impegno cancellato", "memoria.salva": "Ricordo salvato", "memoria.leggi": "Ricordi letti",
  "memoria.correggi": "Ricordo corretto", "memoria.cancella": "Ricordo cancellato", "interfaccia.numero": "Numero mostrato", "ai.chiamata": "Intelligenza artificiale",
  "impostazioni.modifica": "Impostazioni cambiate", "collegamenti.modifica": "Collegamenti cambiati", "notifica.briefing": "Notifica del briefing",
  "notifica.iscrizione": "Notifiche attivate", "conversazioni.pulizia": "Pulizia conversazioni (30 giorni)", "sicurezza.csrf": "Richiesta estranea bloccata", "server.errore": "Errore del server",
};
const NOMI_ESITI = { fatto: "Fatto", negato: "Bloccato", errore: "Errore", richiesta_conferma: "In attesa di conferma" };
const NOMI_ORIGINI = { luigi: "da te", jarvis: "da Jarvis", sistema: "dal sistema" };
async function caricaRegistro(daCapo) {
  const lista = $("#listaRegistro");
  try {
    const voci = await api(`/api/registro${!daCapo && stato.ultimoRegistro ? `?prima=${stato.ultimoRegistro}` : ""}`);
    if (daCapo) lista.replaceChildren();
    for (const v of voci) {
      const li = crea("li", v.esito);
      const quando = crea("time", "", new Date(v.quando).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
      quando.dateTime = new Date(v.quando).toISOString();
      const titolo = crea("div");
      titolo.append(crea("b", "", NOMI_AZIONI[v.azione] || v.azione), document.createTextNode(` ${NOMI_ORIGINI[v.origine] || ""} · `), crea("span", "esito-voce", NOMI_ESITI[v.esito] || v.esito));
      const det = v.dettagli?.motivo || v.dettagli?.strumento || v.dettagli?.percorso || "";
      li.append(quando, titolo);
      if (det) li.append(crea("div", "dettagli", String(det)));
      lista.append(li);
    }
    if (daCapo && !voci.length) lista.append(crea("li", "vuoto", "Ancora nessuna azione."));
    stato.ultimoRegistro = voci.length ? voci[voci.length - 1].id : stato.ultimoRegistro;
    $("#altroRegistro").hidden = voci.length < 100;
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
$("#altroRegistro").addEventListener("click", () => caricaRegistro(false));

// ------------------------------------------------------------------ «Spesa del mese»
const dollari = (n) => n.toLocaleString("it-IT", { style: "currency", currency: "USD", minimumFractionDigits: n < 1 ? 3 : 2, maximumFractionDigits: n < 1 ? 3 : 2 });
async function caricaSpesa() {
  try {
    const s = await api("/api/spesa");
    $("#spesaValore").textContent = dollari(s.spesaUsd);
    $("#spesaTetto").textContent = dollari(s.tettoUsd);
    const perc = s.tettoUsd > 0 ? Math.min(100, (s.spesaUsd / s.tettoUsd) * 100) : 100;
    $("#barraSpesaInterna").style.width = `${perc}%`;
    $("#barraSpesa").setAttribute("aria-valuenow", String(Math.round(perc)));
    $("#barraSpesa").className = `barra-spesa ${s.raggiunto ? "pieno" : s.quasi ? "quasi" : ""}`;
    $("#spesaNota").textContent = `${s.mese} · ${s.richieste} richieste all'AI · ${s.raggiunto ? "tetto raggiunto: Jarvis è in pausa fino al mese prossimo o finché non alzi il tetto." : `restano ${dollari(Math.max(0, s.tettoUsd - s.spesaUsd))}.`}`;
    const corpo = $("#spesaModelli");
    corpo.replaceChildren();
    if (!s.perModello.length) { const tr = crea("tr"); const td = crea("td", "vuoto", "Nessuna richiesta questo mese."); td.colSpan = 3; tr.append(td); corpo.append(tr); }
    for (const m of s.perModello) {
      const tr = crea("tr");
      tr.append(crea("td", "", nomeModello(m.modello)), crea("td", "", String(m.richieste)), crea("td", "", dollari(m.spesaUsd)));
      corpo.append(tr);
    }
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}

// ------------------------------------------------------------------ Impostazioni
async function caricaImpostazioni() {
  try {
    const { impostazioni: i, collegamenti: c } = await api("/api/impostazioni");
    stato.impostazioni = i;
    $("#impTetto").value = i.tettoMensileUsd;
    $("#impNome").value = i.comeChiamarmi;
    $("#impVelocita").value = i.velocitaVoce;
    $("#impLeggi").checked = i.leggiRisposteAVoce;
    $("#impParole").value = i.paroleRisveglio.join(", ");
    $("#impOrario").value = i.orarioBriefing;
    $("#impPush").checked = i.briefingPush;
    $("#impMeteo").checked = i.meteoCantieri;
    $("#impTema").value = i.tema;
    riempiVoci(i.vocePreferita);
    $("#colUrl").value = c.costructoUrl || "";
    stato.urlSalvato = c.costructoUrl || "";
    disegnaAziende(c.aziende || []);
    $("#colIcalStato").textContent = c.calendario ? "sì" : "no";
    aggiornaStatoNotifiche();
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function riempiVoci(scelta) {
  const sel = $("#impVoce");
  sel.replaceChildren(crea("option", "", "Automatica"));
  sel.firstChild.value = "";
  for (const v of voce.voci()) { const o = crea("option", "", `${v.name} (${v.lang})`); o.value = v.name; sel.append(o); }
  sel.value = scelta || "";
}
if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { if (!$("#pagina-impostazioni").hidden) riempiVoci($("#impVoce").value); });
$("#provaVoce").addEventListener("click", () => {
  voce.sblocca();
  voce.nomeVoce = $("#impVoce").value;
  voce.velocita = Number($("#impVelocita").value);
  voce.stop();
  voce.di(`Buongiorno ${$("#impNome").value}, sono Jarvis.`);
});
$("#formImpostazioni").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoImpostazioni");
  try {
    const { impostazioni: i } = await api("/api/impostazioni", { metodo: "PUT", corpo: {
      tettoMensileUsd: Number($("#impTetto").value),
      comeChiamarmi: $("#impNome").value,
      vocePreferita: $("#impVoce").value,
      velocitaVoce: Number($("#impVelocita").value),
      leggiRisposteAVoce: $("#impLeggi").checked,
      paroleRisveglio: $("#impParole").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      orarioBriefing: $("#impOrario").value,
      briefingPush: $("#impPush").checked,
      meteoCantieri: $("#impMeteo").checked,
      tema: $("#impTema").value,
    } });
    stato.impostazioni = i;
    voce.nomeVoce = i.vocePreferita;
    voce.velocita = i.velocitaVoce;
    applicaTema(i.tema);
    esito.className = "esito";
    esito.textContent = "Impostazioni salvate.";
  } catch (err) { esito.className = "esito male"; esito.textContent = err.message; }
});
// Aziende di Costructo: una per token. Il server manda solo il nome e le ultime cifre del token.
function disegnaAziende(aziende) {
  const lista = $("#listaAziende");
  lista.replaceChildren();
  if (!aziende.length) { lista.append(crea("li", "vuoto", "Nessuna azienda collegata.")); return; }
  for (const a of aziende) {
    const li = crea("li");
    const nome = crea("span", "nome-azienda", a.nome);
    nome.append(crea("small", "", `token ${a.token}`));
    const togli = crea("button", "secondario", "Rimuovi");
    togli.type = "button";
    togli.setAttribute("aria-label", `Rimuovi l'azienda ${a.nome}`);
    togli.addEventListener("click", async () => {
      if (!confirm(`Vuoi scollegare «${a.nome}» da Jarvis? Il token verrà cancellato da Jarvis (in Costructo resta).`)) return;
      const esito = $("#esitoCollegamenti");
      try {
        const c = await api(`/api/collegamenti/aziende/${encodeURIComponent(a.id)}`, { metodo: "DELETE" });
        disegnaAziende(c.aziende || []);
        esito.className = "esito"; esito.textContent = `${a.nome} scollegata.`;
        caricaBriefing();
      } catch (err) { esito.className = "esito male"; esito.textContent = err.message; }
    });
    li.append(nome, togli);
    lista.append(li);
  }
}
/** Salva l'indirizzo di Costructo se è cambiato (serve prima di aggiungere un token). */
async function salvaUrlSeCambiato() {
  const url = $("#colUrl").value.trim();
  if (url === (stato.urlSalvato || "")) return;
  const c = await api("/api/collegamenti", { metodo: "PUT", corpo: { costructoUrl: url } });
  stato.urlSalvato = c.costructoUrl || "";
}
async function aggiungiAzienda() {
  const esito = $("#esitoCollegamenti");
  const token = $("#colToken").value.trim();
  if (!token) { esito.className = "esito male"; esito.textContent = "Scrivi il token dell'azienda (inizia con csa_)."; $("#colToken").focus(); return false; }
  esito.className = "esito"; esito.textContent = "Controllo il token con Costructo…";
  try {
    await salvaUrlSeCambiato();
    const c = await api("/api/collegamenti/aziende", { metodo: "POST", corpo: { token } });
    $("#colToken").value = "";
    disegnaAziende(c.aziende || []);
    const nuova = (c.aziende || []).at(-1);
    esito.className = "esito"; esito.textContent = nuova ? `Azienda collegata: ${nuova.nome}.` : "Azienda collegata.";
    caricaBriefing();
    return true;
  } catch (err) { esito.className = "esito male"; esito.textContent = err.message; return false; }
}
$("#aggiungiAzienda").addEventListener("click", () => { aggiungiAzienda(); });
$("#formCollegamenti").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoCollegamenti");
  const corpo = { costructoUrl: $("#colUrl").value };
  if ($("#colIcal").value) corpo.calendarioIcal = $("#colIcal").value;
  try {
    const c = await api("/api/collegamenti", { metodo: "PUT", corpo });
    stato.urlSalvato = c.costructoUrl || "";
    $("#colIcal").value = "";
    disegnaAziende(c.aziende || []);
    $("#colIcalStato").textContent = c.calendario ? "sì" : "no";
    esito.className = "esito"; esito.textContent = "Collegamenti salvati.";
    // Un token scritto nel campo e confermato con Invio vale come «Aggiungi».
    if ($("#colToken").value.trim()) await aggiungiAzienda();
    else caricaBriefing();
  } catch (err) { esito.className = "esito male"; esito.textContent = err.message; }
});
$("#provaCostructo").addEventListener("click", async () => {
  const esito = $("#esitoCollegamenti");
  const lista = $("#esitoProvaAziende");
  lista.replaceChildren();
  esito.className = "esito"; esito.textContent = "Provo il collegamento…";
  const r = await api("/api/collegamenti/costructo/prova", { metodo: "POST", corpo: {} }).catch((e) => ({ ok: false, messaggio: e.message, aziende: [] }));
  const aziende = r.aziende || [];
  if (aziende.length > 1) {
    for (const a of aziende) lista.append(crea("li", a.ok ? "" : "male", `${a.nome}: ${a.ok ? "collegamento riuscito" : a.messaggio}`));
    esito.className = r.ok ? "esito" : "esito male";
    esito.textContent = r.ok ? "Tutte le aziende rispondono." : "Una o più aziende non rispondono: vedi sopra.";
  } else {
    esito.className = r.ok ? "esito" : "esito male";
    esito.textContent = aziende[0] && r.ok ? `${aziende[0].nome}: collegamento riuscito.` : r.messaggio;
  }
});

// ------------------------------------------------------------------ notifiche push
async function aggiornaStatoNotifiche() {
  const el = $("#statoNotifiche");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    el.textContent = "Su iPhone e iPad le notifiche funzionano solo dopo «Aggiungi alla schermata Home» (iOS 16.4 o successivo).";
    $("#attivaNotifiche").disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  el.textContent = sub ? "Notifiche attive su questo dispositivo." : Notification.permission === "denied" ? "Notifiche bloccate nelle impostazioni del dispositivo." : "Notifiche non ancora attive su questo dispositivo.";
}
$("#attivaNotifiche").addEventListener("click", async () => {
  const el = $("#statoNotifiche");
  try {
    const { chiave } = await api("/api/push/chiave");
    if (!chiave) { el.textContent = "Il server non ha ancora le chiavi per le notifiche (VAPID)."; return; }
    const permesso = await Notification.requestPermission();
    if (permesso !== "granted") { el.textContent = "Permesso negato."; return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64aByte(chiave) });
    await api("/api/push/iscrivi", { metodo: "POST", corpo: sub.toJSON() });
    el.textContent = "Notifiche attive su questo dispositivo.";
  } catch (err) { el.textContent = `Non riuscito: ${err.message}`; }
});
function base64aByte(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ------------------------------------------------------------------ service worker (installabile come app)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

avvia();
