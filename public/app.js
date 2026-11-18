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

const PAGINE = ["home", "posta", "whatsapp", "memoria", "registro", "spesa", "impostazioni"];
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
  if (p === "posta") caricaPosta();
  if (p === "whatsapp") caricaWhatsapp();
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
  if (!$("#pagina-posta").hidden) caricaPosta();
  if (!$("#pagina-whatsapp").hidden) caricaWhatsapp();
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
  // Testo intero, a capo compresi: è esattamente quello che verrà mandato o salvato.
  box.append(crea("p", "testo-conferma", e.domanda));
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
  "posta.leggi": "Lettura della posta", "posta.classifica": "Riassunti della posta", "posta.bozza": "Bozza di risposta", "posta.caselle": "Caselle email cambiate",
  "posta.conferma_automatica": "Conferma di ricezione automatica", "posta.pulizia": "Pulizia posta (30 giorni)", "notifica.posta": "Notifica mail urgente",
  "calendario_aziende.leggi": "Lettura dei calendari di lavoro",
  "whatsapp.leggi": "Lettura di WhatsApp", "whatsapp.ricevuti": "Messaggi WhatsApp arrivati", "whatsapp.classifica": "Riassunti di WhatsApp",
  "whatsapp.risposta": "Risposta WhatsApp preparata", "whatsapp.invio": "Messaggio WhatsApp mandato", "whatsapp.assegna": "Azienda di un contatto WhatsApp",
  "whatsapp.azienda": "Azienda di un contatto WhatsApp", "whatsapp.conferma_automatica": "Conferma automatica WhatsApp", "whatsapp.webhook": "Webhook WhatsApp",
  "whatsapp.storico": "Storico WhatsApp", "whatsapp.pulizia": "Pulizia WhatsApp (30 giorni)", "whatsapp.account": "Account WhatsApp", "notifica.whatsapp": "Notifica WhatsApp",
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
      const det = v.dettagli?.motivo || v.dettagli?.strumento || v.dettagli?.percorso || [v.dettagli?.operazione, v.dettagli?.casella, v.dettagli?.dominio].filter(Boolean).join(" · ") || "";
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
    caricaCaselle();
    caricaApple();
    caricaWaImpostazioni();
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
    const azioni = crea("span", "azioni-azienda");
    const rinomina = crea("button", "secondario", "Rinomina");
    rinomina.type = "button";
    rinomina.setAttribute("aria-label", `Rinomina l'azienda ${a.nome}`);
    rinomina.addEventListener("click", async () => {
      const nuovo = prompt(`Nuovo nome per «${a.nome}»:`, a.nome);
      if (nuovo === null || !nuovo.trim() || nuovo.trim() === a.nome) return;
      const esito = $("#esitoCollegamenti");
      try {
        const c = await api(`/api/collegamenti/aziende/${encodeURIComponent(a.id)}`, { metodo: "PATCH", corpo: { nome: nuovo.trim() } });
        disegnaAziende(c.aziende || []);
        esito.className = "esito"; esito.textContent = `Nome cambiato: ${nuovo.trim()}.`;
        caricaBriefing();
      } catch (err) { esito.className = "esito male"; esito.textContent = err.message; }
    });
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
    azioni.append(rinomina, togli);
    li.append(nome, azioni);
    lista.append(li);
  }
}
async function ricaricaAziende() {
  try { disegnaAziende(await api("/api/collegamenti/aziende")); } catch { /* resta l'elenco di prima */ }
}
/** Salva l'indirizzo di Costructo se è cambiato (serve prima di aggiungere un token). */
async function salvaUrlSeCambiato() {
  const url = $("#colUrl").value.trim();
  if (url === (stato.urlSalvato || "")) return;
  const c = await api("/api/collegamenti", { metodo: "PUT", corpo: { costructoUrl: url } });
  stato.urlSalvato = c.costructoUrl || "";
}
/** Mostra o nasconde il campo per scegliere un altro nome (quando il nome letto da Costructo c'è già). */
function campoNome(visibile) {
  $("#rigaNomeAzienda").hidden = !visibile;
  if (!visibile) $("#colNomeAzienda").value = "";
}
let aggiuntaInCorso = false;
async function aggiungiAzienda() {
  if (aggiuntaInCorso) return false; // niente doppio invio (pulsante o Invio)
  const esito = $("#esitoCollegamenti");
  const token = $("#colToken").value.trim();
  if (!token) { esito.className = "esito male"; esito.textContent = "Scrivi il token dell'azienda (inizia con csa_)."; $("#colToken").focus(); return false; }
  const corpo = { token };
  const nome = $("#rigaNomeAzienda").hidden ? "" : $("#colNomeAzienda").value.trim();
  if (nome) corpo.nome = nome;
  aggiuntaInCorso = true;
  $("#aggiungiAzienda").disabled = true;
  esito.className = "esito"; esito.textContent = "Controllo il token con Costructo…";
  try {
    await salvaUrlSeCambiato();
    const r = await fetch("/api/collegamenti/aziende", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    if (r.status === 401) throw new NonAutenticato();
    const c = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (c.codice === "nome_esistente") {
        campoNome(true);
        $("#colNomeAzienda").focus();
        throw new Error(`${c.errore} Poi premi di nuovo «Aggiungi».`);
      }
      throw new Error(c.errore || `Errore ${r.status}`);
    }
    $("#colToken").value = "";
    campoNome(false);
    disegnaAziende(c.aziende || []);
    const nuova = (c.aziende || []).at(-1);
    esito.className = "esito"; esito.textContent = nuova ? `Azienda collegata: ${nuova.nome}.` : "Azienda collegata.";
    caricaBriefing();
    return true;
  } catch (err) {
    if (err instanceof NonAutenticato) { mostraAccesso(); return false; }
    esito.className = "esito male"; esito.textContent = err.message; return false;
  } finally {
    aggiuntaInCorso = false;
    $("#aggiungiAzienda").disabled = false;
  }
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
  ricaricaAziende(); // la prova può aver letto il nome vero dell'azienda
  if (aziende.length > 1) {
    for (const a of aziende) lista.append(crea("li", a.ok ? "" : "male", `${a.nome}: ${a.ok ? "collegamento riuscito" : a.messaggio}`));
    esito.className = r.ok ? "esito" : "esito male";
    esito.textContent = r.ok ? "Tutte le aziende rispondono." : "Una o più aziende non rispondono: vedi sopra.";
  } else {
    esito.className = r.ok ? "esito" : "esito male";
    esito.textContent = aziende[0] && r.ok ? `${aziende[0].nome}: collegamento riuscito.` : r.messaggio;
  }
});

// ------------------------------------------------------------------ Posta (Fase 2)
// Jarvis legge le caselle in sola lettura: qui si vedono le mail divise per azienda e privato,
// le urgenti evidenziate, il riassunto e il dettaglio. «Prepara bozza di risposta» mette una bozza
// nella cartella Bozze della casella: NON la invia mai.
const quando = (ms) => new Date(ms).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const NOMI_PEC = { messaggio: "PEC", accettazione: "Ricevuta PEC di accettazione", consegna: "Ricevuta PEC di consegna", non_accettazione: "PEC non accettata", mancata_consegna: "PEC non consegnata", presa_in_carico: "Ricevuta PEC", errore: "Errore PEC" };

async function caricaPosta() {
  const contenitore = $("#postaGruppi");
  try {
    const d = await api(`/api/posta/messaggi?vista=${stato.vista}&giorni=${$("#postaGiorni").value}${$("#postaUrgenti").checked ? "&soloUrgenti=1" : ""}`);
    disegnaPosta(d);
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    contenitore.replaceChildren(crea("p", "vuoto", "La posta non è disponibile in questo momento."));
  }
}
function disegnaPosta(d) {
  const contenitore = $("#postaGruppi");
  contenitore.replaceChildren();
  const avvisi = [];
  if (d.senzaRiassuntoPerTetto) avvisi.push(`${d.senzaRiassuntoPerTetto} mail senza riassunto: tetto di spesa del mese raggiunto.`);
  for (const c of d.caselle) if (c.stato.esito === "errore") avvisi.push(`${c.nome}: ${c.stato.messaggio}`);
  $("#postaAvviso").textContent = avvisi.join(" · ");
  if (!d.caselle.length && d.vista !== "tutto") {
    contenitore.append(crea("p", "vuoto", d.vista === "privato" ? "Nessuna casella privata. Le caselle delle aziende sono nella scheda Lavoro." : "Nessuna casella di lavoro. Le caselle private sono nella scheda Privato."));
    return;
  }
  if (!d.caselle.length) {
    const p = crea("p", "vuoto", "Nessuna casella collegata. ");
    const a = crea("a", "", "Aggiungila dalle Impostazioni");
    a.href = "#impostazioni";
    p.append(a, document.createTextNode("."));
    contenitore.append(p);
    return;
  }
  // Gruppi: prima le aziende (in ordine di nome), poi il privato.
  const gruppi = new Map();
  for (const c of d.caselle) if (!gruppi.has(c.spazio)) gruppi.set(c.spazio, { nome: c.nomeSpazio, privato: c.spazio === "privato", mail: [] });
  for (const m of d.messaggi) gruppi.get(m.spazio)?.mail.push(m);
  const ordinati = [...gruppi.values()].sort((a, b) => (a.privato - b.privato) || a.nome.localeCompare(b.nome, "it"));
  for (const g of ordinati) {
    const sezione = crea("section", `gruppo-posta ${g.privato ? "privato" : "lavoro"}`);
    const titolo = crea("h2", "", g.nome);
    const urgenti = g.mail.filter((m) => m.urgente).length;
    if (urgenti) titolo.append(crea("span", "conteggio-urgenti", `${urgenti} ${urgenti === 1 ? "urgente" : "urgenti"}`));
    sezione.append(titolo);
    const lista = crea("ul", "lista-posta");
    if (!g.mail.length) lista.append(crea("li", "vuoto", "Nessuna mail in questo periodo."));
    for (const m of g.mail) lista.append(rigaPosta(m));
    sezione.append(lista);
    contenitore.append(sezione);
  }
}
function rigaPosta(m) {
  const li = crea("li", `posta-mail${m.urgente ? " urgente" : ""}${m.automatica ? " automatica" : ""}`);
  const testa = crea("div", "posta-testa");
  testa.append(crea("b", "posta-oggetto", m.oggetto || "(senza oggetto)"));
  const etichette = crea("span", "etichette");
  if (m.urgente) etichette.append(crea("span", "etichetta urgente", "Urgente"));
  if (m.pec) etichette.append(crea("span", "etichetta pec", NOMI_PEC[m.pec] || "PEC"));
  if (m.tocca) etichette.append(crea("span", "etichetta soldi", "Soldi o impegni"));
  if (m.confermaAutomatica) etichette.append(crea("span", "etichetta", "Conferma automatica inviata"));
  testa.append(etichette);
  const meta = crea("small", "posta-meta", `${m.daNome || m.daIndirizzo} · ${m.casellaNome} · ${quando(m.data)}`);
  const riassunto = crea("p", "posta-riassunto", m.riassunto || (m.stato === "tetto" ? "Senza riassunto (tetto di spesa raggiunto)." : "Riassunto in arrivo…"));
  li.append(testa, meta, riassunto);
  if (m.urgente && m.motivo) li.append(crea("p", "posta-motivo", `Perché è urgente: ${m.motivo}`));
  const apri = crea("button", "secondario", "Apri");
  apri.type = "button";
  apri.setAttribute("aria-expanded", "false");
  apri.setAttribute("aria-label", `Apri la mail «${m.oggetto || "senza oggetto"}» di ${m.daNome || m.daIndirizzo}`);
  const dettaglio = crea("div", "posta-dettaglio");
  dettaglio.hidden = true;
  dettaglio.id = `dettaglio-${m.id}`;
  apri.setAttribute("aria-controls", dettaglio.id);
  apri.addEventListener("click", async () => {
    const aperto = apri.getAttribute("aria-expanded") === "true";
    apri.setAttribute("aria-expanded", String(!aperto));
    apri.textContent = aperto ? "Apri" : "Chiudi";
    dettaglio.hidden = aperto;
    if (!aperto && !dettaglio.childElementCount) await riempiDettaglio(m.id, dettaglio);
  });
  li.append(apri, dettaglio);
  return li;
}
async function riempiDettaglio(id, box) {
  box.replaceChildren(crea("p", "vuoto", "Carico…"));
  let m;
  try { m = await api(`/api/posta/messaggi/${encodeURIComponent(id)}`); } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    box.replaceChildren(crea("p", "vuoto", e.message));
    return;
  }
  box.replaceChildren();
  box.append(crea("p", "posta-meta", `Da: ${m.daNome ? `${m.daNome} <${m.daIndirizzo}>` : m.daIndirizzo} · A: ${m.a || "—"} · ${m.nomeSpazio} · casella ${m.casellaNome}`));
  box.append(crea("div", "estratto", m.estratto || "(nessun testo)"));
  if (m.allegati?.length) {
    const ul = crea("ul", "allegati");
    for (const a of m.allegati) ul.append(crea("li", "", `${a.nome} (${Math.max(1, Math.round(a.dimensione / 1024))} KB)`));
    box.append(crea("p", "sottotitolo", "Allegati (solo il nome: aprili dalla tua app di posta)"), ul);
  }
  for (const b of m.bozze || []) {
    box.append(crea("p", "nota-bozza", `Bozza del ${quando(b.creata)}: ${b.stato === "in_bozze" ? "nella cartella Bozze" : `salvata solo in Jarvis (${b.dettaglio})`}.`));
  }
  const prepara = crea("button", "primario", "Prepara bozza di risposta");
  prepara.type = "button";
  const zona = crea("div", "zona-bozza");
  prepara.addEventListener("click", () => apriBozza(m, zona, prepara));
  box.append(prepara, zona);
}
async function apriBozza(m, zona, pulsante) {
  pulsante.disabled = true;
  zona.replaceChildren(crea("p", "vuoto", "Jarvis prepara il testo…"));
  let testo = "";
  try { testo = (await api(`/api/posta/messaggi/${encodeURIComponent(m.id)}/bozza/proponi`, { metodo: "POST", corpo: {} })).testo; } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    zona.replaceChildren(crea("p", "esito male", e.message));
  }
  const id = `bozza-${m.id}`;
  const etichetta = crea("label", "", `Bozza per ${m.rispondiA} — «${m.oggettoRisposta}»`);
  etichetta.htmlFor = id;
  const area = crea("textarea", "testo-bozza");
  area.id = id;
  area.value = testo;
  area.rows = 8;
  area.maxLength = 5000;
  const nota = crea("p", "aiuto", "Correggi il testo se serve. Jarvis NON invia la mail: la mette nella cartella Bozze della casella e la mandi tu dalla tua app di posta.");
  const metti = crea("button", "primario", "Metti nelle Bozze");
  metti.type = "button";
  const annulla = crea("button", "secondario", "Annulla");
  annulla.type = "button";
  const esito = crea("p", "esito");
  esito.setAttribute("role", "status");
  annulla.addEventListener("click", () => { zona.replaceChildren(); pulsante.disabled = false; pulsante.focus(); });
  metti.addEventListener("click", async () => {
    if (!area.value.trim()) { esito.className = "esito male"; esito.textContent = "Scrivi il testo della bozza."; return; }
    metti.disabled = true;
    try {
      const r = await api(`/api/posta/messaggi/${encodeURIComponent(m.id)}/bozza`, { metodo: "POST", corpo: { testo: area.value } });
      esito.className = r.inBozze ? "esito" : "esito male";
      esito.textContent = r.messaggio;
      pulsante.disabled = false;
    } catch (e) {
      if (e instanceof NonAutenticato) return mostraAccesso();
      esito.className = "esito male"; esito.textContent = e.message; metti.disabled = false;
    }
  });
  const azioni = crea("div", "azioni-modulo");
  azioni.append(metti, annulla);
  if (zona.firstChild?.classList?.contains("vuoto")) zona.replaceChildren();
  zona.append(etichetta, area, nota, azioni, esito);
  area.focus();
}
$("#postaGiorni").addEventListener("change", caricaPosta);
$("#postaUrgenti").addEventListener("change", caricaPosta);
$("#postaAggiorna").addEventListener("click", async () => {
  const b = $("#postaAggiorna"), st = $("#postaStato");
  b.disabled = true;
  st.className = "esito"; st.textContent = "Controllo le caselle…";
  try {
    const r = await api("/api/posta/aggiorna", { metodo: "POST", corpo: {} });
    st.className = r.ok ? "esito" : "esito male"; st.textContent = r.messaggio;
    await caricaPosta();
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    st.className = "esito male"; st.textContent = e.message;
  } finally { b.disabled = false; }
});

// ------------------------------------------------------------------ WhatsApp (Fase 3, parte 1: senza collegamento reale)
// Chat divise per azienda, privato e «Da assegnare»; urgenti e senza risposta evidenziate; domande «Di quale azienda è…?»
// con i pulsanti. «Prepara risposta» → testo modificabile → «Invia» → conferma esplicita. Mai «spunte blu».
const NOMI_ALLEGATI = { image: "foto", document: "documento", audio: "audio", video: "video", sticker: "adesivo" };

async function caricaWhatsapp() {
  try {
    disegnaWhatsapp(await api(`/api/whatsapp/chat?vista=${stato.vista}&giorni=${$("#waGiorni").value}${$("#waUrgenti").checked ? "&soloUrgenti=1" : ""}`));
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    $("#waGruppi").replaceChildren(crea("p", "vuoto", "WhatsApp non è disponibile in questo momento."));
  }
}
function disegnaWhatsapp(d) {
  $("#waNonCollegato").hidden = !!d.collegamento?.webhookAttivo;
  const domande = $("#waDomande");
  domande.replaceChildren();
  for (const q of d.domande) domande.append(schedaDomanda(q, d.aziende));
  const contenitore = $("#waGruppi");
  contenitore.replaceChildren();
  if (!d.chat.length) {
    contenitore.append(crea("p", "vuoto", d.collegamento?.webhookAttivo ? "Nessuna chat in questo periodo." : "Ancora nessun messaggio: WhatsApp si collega nella parte 2."));
    return;
  }
  // Gruppi: prima le aziende (per nome), poi il privato, poi i contatti da assegnare.
  const ordine = (s) => (s === "" ? 2 : s === "privato" ? 1 : 0);
  const gruppi = new Map();
  for (const g of d.gruppi) gruppi.set(g.spazio, { spazio: g.spazio, nome: g.nome, chat: [] });
  for (const c of d.chat) {
    if (!gruppi.has(c.contatto.spazio)) gruppi.set(c.contatto.spazio, { spazio: c.contatto.spazio, nome: c.contatto.nomeSpazio, chat: [] });
    gruppi.get(c.contatto.spazio).chat.push(c);
  }
  const ordinati = [...gruppi.values()].filter((g) => g.chat.length).sort((a, b) => (ordine(a.spazio) - ordine(b.spazio)) || a.nome.localeCompare(b.nome, "it"));
  for (const g of ordinati) {
    const tipo = g.spazio === "privato" ? "privato" : g.spazio === "" ? "da-assegnare" : "lavoro";
    const sezione = crea("section", `gruppo-wa ${tipo}`);
    const titolo = crea("h2", "", g.nome);
    const urgenti = g.chat.filter((c) => c.urgenti).length, senza = g.chat.filter((c) => c.senzaRisposta && !c.soloStorico).length;
    if (urgenti) titolo.append(crea("span", "conteggio-urgenti", `${urgenti} ${urgenti === 1 ? "urgente" : "urgenti"}`));
    if (senza) titolo.append(crea("span", "conteggio-attesa", `${senza} senza risposta`));
    sezione.append(titolo);
    const lista = crea("ul", "lista-posta lista-wa");
    for (const c of g.chat) lista.append(rigaChat(c, d.aziende));
    sezione.append(lista);
    contenitore.append(sezione);
  }
}
function schedaDomanda(q, aziende) {
  const box = crea("section", "conferma wa-domanda");
  box.setAttribute("aria-label", q.domanda);
  box.append(crea("p", "", q.domanda));
  if (q.propostaNome) box.append(crea("small", "posta-meta", `Dalla chat, Jarvis pensa: ${q.propostaNome}. Decidi tu.`));
  const azioni = crea("div", "azioni");
  const scegli = async (spazio) => {
    azioni.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const r = await api(`/api/whatsapp/domande/${encodeURIComponent(q.id)}`, { metodo: "POST", corpo: { spazio } });
      $("#waStato").className = "esito"; $("#waStato").textContent = r.messaggio;
      await caricaWhatsapp();
    } catch (e) {
      if (e instanceof NonAutenticato) return mostraAccesso();
      box.append(crea("p", "esito male", e.message));
      azioni.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  for (const a of [...aziende, { id: "privato", nome: "Privato" }]) {
    const b = crea("button", a.id === q.proposta ? "primario" : "secondario", a.nome);
    b.type = "button";
    b.addEventListener("click", () => scegli(a.id));
    azioni.append(b);
  }
  box.append(azioni);
  return box;
}
function rigaChat(c, aziende) {
  const li = crea("li", `wa-chat${c.urgenti ? " urgente" : ""}${c.senzaRisposta && !c.soloStorico ? " attesa" : ""}`);
  const testa = crea("div", "posta-testa");
  testa.append(crea("b", "posta-oggetto", c.contatto.nome));
  const etichette = crea("span", "etichette");
  if (c.urgenti) etichette.append(crea("span", "etichetta urgente", "Urgente"));
  if (c.senzaRisposta && !c.soloStorico) etichette.append(crea("span", "etichetta attesa", "Senza risposta"));
  if (c.ultimo.tocca) etichette.append(crea("span", "etichetta soldi", "Soldi o impegni"));
  if (c.proposte) etichette.append(crea("span", "etichetta", "Risposta proposta"));
  if (c.contatto.gruppo) etichette.append(crea("span", "etichetta", "Gruppo"));
  if (c.soloStorico) etichette.append(crea("span", "etichetta", "Chat passata"));
  testa.append(etichette);
  const chi = c.ultimo.direzione === "in" ? "" : c.ultimo.automatico ? "Conferma automatica: " : "Tu: ";
  const meta = crea("small", "posta-meta", [c.contatto.numero, quando(c.ultimo.quando), c.contatto.trovatoInCostructo ? "trovato in Costructo" : ""].filter(Boolean).join(" · "));
  const testo = c.ultimo.riassunto || (c.ultimo.stato === "tetto" ? "Senza riassunto (tetto di spesa raggiunto)." : `${chi}${c.ultimo.testo}`);
  li.append(testa, meta, crea("p", "posta-riassunto", testo.length > 220 ? `${testo.slice(0, 220)}…` : testo));
  if (c.ultimo.urgente && c.ultimo.motivo) li.append(crea("p", "posta-motivo", `Perché è urgente: ${c.ultimo.motivo}`));
  const apri = crea("button", "secondario", "Apri");
  apri.type = "button";
  apri.setAttribute("aria-expanded", "false");
  apri.setAttribute("aria-label", `Apri la chat con ${c.contatto.nome}`);
  const dettaglio = crea("div", "posta-dettaglio");
  dettaglio.hidden = true;
  dettaglio.id = `chat-${c.contatto.id}`;
  apri.setAttribute("aria-controls", dettaglio.id);
  apri.addEventListener("click", async () => {
    const aperto = apri.getAttribute("aria-expanded") === "true";
    apri.setAttribute("aria-expanded", String(!aperto));
    apri.textContent = aperto ? "Apri" : "Chiudi";
    dettaglio.hidden = aperto;
    if (!aperto) await riempiChat(c.contatto.id, dettaglio, aziende);
  });
  li.append(apri, dettaglio);
  return li;
}
async function riempiChat(id, box, aziende) {
  box.replaceChildren(crea("p", "vuoto", "Carico…"));
  let d;
  try { d = await api(`/api/whatsapp/chat/${encodeURIComponent(id)}`); } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    box.replaceChildren(crea("p", "vuoto", e.message));
    return;
  }
  box.replaceChildren();
  box.append(crea("p", "posta-meta", `${d.contatto.nomeSpazio}${d.contatto.sceltoDaLuigi ? " (scelto da te)" : d.contatto.trovatoInCostructo ? " (numero trovato in Costructo)" : ""}`));
  const lista = crea("ol", "wa-messaggi");
  lista.setAttribute("aria-label", `Ultimi messaggi con ${d.contatto.nome}`);
  for (const m of d.messaggi) {
    const li = crea("li", `wa-msg ${m.direzione === "in" ? "in" : "out"}${m.urgente ? " urgente" : ""}`);
    const chi = m.direzione === "in" ? d.contatto.nome : m.automatico ? "Jarvis (conferma automatica)" : m.direzione === "out" ? "Jarvis, per te" : "Tu dal telefono";
    const stato = m.statoInvio ? ` · ${{ sent: "inviato", delivered: "consegnato", read: "letto", failed: "non consegnato" }[m.statoInvio] || m.statoInvio}` : "";
    li.append(crea("small", "posta-meta", `${chi} · ${quando(m.quando)}${m.storico ? " · chat passata" : ""}${stato}`));
    if (m.testo) li.append(crea("p", "wa-testo", m.testo));
    if (m.allegato) li.append(crea("p", "posta-meta", `Allegato: ${NOMI_ALLEGATI[m.allegato.tipo] || m.allegato.tipo}${m.allegato.nomeFile ? ` «${m.allegato.nomeFile}»` : ""} (aprilo dal telefono)`));
    if (m.erroreInvio) li.append(crea("p", "esito male", m.erroreInvio));
    lista.append(li);
  }
  box.append(lista);
  // Risposte proposte o in bozza
  for (const r of d.risposte) box.append(schedaRisposta(d, r, () => riempiChat(id, box, aziende)));
  // Cambiare l'azienda del contatto
  const riga = crea("div", "azioni-modulo wa-azienda");
  const etichetta = crea("label", "", "Appartiene a ");
  const scelta = crea("select");
  for (const a of [...aziende, { id: "privato", nome: "Privato" }]) {
    const o = crea("option", "", a.nome); o.value = a.id; if (a.id === d.contatto.spazio) o.selected = true; scelta.append(o);
  }
  if (!d.contatto.spazio) { const o = crea("option", "", "Da assegnare"); o.value = ""; o.selected = true; o.disabled = true; scelta.prepend(o); }
  etichetta.append(scelta);
  const salva = crea("button", "secondario", "Salva l'azienda");
  salva.type = "button";
  const esitoAz = crea("p", "esito"); esitoAz.setAttribute("role", "status");
  salva.addEventListener("click", async () => {
    if (!scelta.value) return;
    try {
      const r = await api(`/api/whatsapp/chat/${encodeURIComponent(id)}/azienda`, { metodo: "PUT", corpo: { spazio: scelta.value } });
      esitoAz.className = "esito"; esitoAz.textContent = r.messaggio;
    } catch (e) { esitoAz.className = "esito male"; esitoAz.textContent = e.message; }
  });
  riga.append(etichetta, salva);
  box.append(riga, esitoAz);
  if (d.contatto.gruppo) { box.append(crea("p", "aiuto", "Nei gruppi Jarvis non scrive: rispondi dal telefono.")); return; }
  if (!d.dentroFinestra) {
    box.append(crea("p", "avviso-forte", "Sono passate più di 24 ore dall'ultimo messaggio di questo contatto: WhatsApp permette di scrivere solo con un «modello» approvato da Meta, che arriverà nella parte 2. Se serve, rispondi dal telefono."));
    return;
  }
  const prepara = crea("button", "primario", "Prepara risposta");
  prepara.type = "button";
  const zona = crea("div", "zona-bozza");
  prepara.addEventListener("click", () => apriRispostaWa(d, zona, prepara, () => riempiChat(id, box, aziende)));
  box.append(prepara, zona);
}
/**
 * Conferma esplicita dentro la pagina: il messaggio parte solo dopo «Sì, manda».
 * `r` arriva dal server (testo già pulito + impronta): si mostra quel testo e si manda quell'impronta,
 * così parte esattamente il testo visto (non quello che c'è nella casella al momento del clic).
 */
function chiediConfermaInvio(d, r, zona, esito, ricarica) {
  zona.querySelector(".wa-conferma")?.remove();
  const box = crea("div", "conferma wa-conferma");
  box.setAttribute("role", "group");
  box.append(crea("p", "", `Mando questo messaggio su WhatsApp a ${d.contatto.nome} (${d.contatto.nomeSpazio})? Parte subito e non si può ritirare da Jarvis.`));
  box.append(crea("p", "wa-anteprima", r.testo));
  const azioni = crea("div", "azioni");
  const si = crea("button", "primario", "Sì, manda");
  const no = crea("button", "secondario", "Annulla");
  si.type = "button"; no.type = "button";
  no.addEventListener("click", () => box.remove());
  si.addEventListener("click", async () => {
    si.disabled = true; no.disabled = true;
    try {
      const e = await api(`/api/whatsapp/risposte/${encodeURIComponent(r.id)}/invia`, { metodo: "POST", corpo: { conferma: true, impronta: r.impronta } });
      esito.className = e.inviata ? "esito" : "esito male"; esito.textContent = e.messaggio;
      if (e.inviata) setTimeout(ricarica, 1200);
    } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
    box.remove();
  });
  azioni.append(si, no);
  box.append(azioni);
  zona.append(box);
  si.focus();
}
function schedaRisposta(d, r, ricarica) {
  const box = crea("div", "zona-bozza wa-risposta");
  box.append(crea("p", "sottotitolo", r.stato === "incerto" ? "Esito incerto: controlla sul telefono se è arrivata (Jarvis non riprova da solo)." : r.tipo === "richiesta_documento" ? "Jarvis propone di chiedere la fattura o il documento (si parla di un pagamento senza documento):" : r.stato === "errore" ? "Risposta non partita:" : "Risposta preparata, non ancora mandata:"));
  const idArea = `risposta-${r.id}`;
  const etichetta = crea("label", "nascosto", "Testo della risposta"); etichetta.htmlFor = idArea;
  const area = crea("textarea", "testo-bozza"); area.id = idArea; area.value = r.testo; area.rows = 4; area.maxLength = 4000;
  const esito = crea("p", r.stato === "errore" ? "esito male" : "esito"); esito.setAttribute("role", "status");
  if (r.esito && r.stato !== "inviata") esito.textContent = r.esito;
  const invia = crea("button", "primario", "Invia"); invia.type = "button";
  const scarta = crea("button", "secondario", "Scarta"); scarta.type = "button";
  if (r.stato === "incerto") { invia.hidden = true; }
  invia.addEventListener("click", async () => {
    if (/\[\s*da\s+completare\s*\]/i.test(area.value)) { esito.className = "esito male"; esito.textContent = "C'è ancora [da completare]: completa il testo prima di mandarlo."; return; }
    try {
      // Il server salva il testo pulito e restituisce testo + impronta: la conferma mostra quello.
      const pulita = await api(`/api/whatsapp/risposte/${encodeURIComponent(r.id)}`, { metodo: "PATCH", corpo: { testo: area.value } });
      area.value = pulita.testo;
      chiediConfermaInvio(d, pulita, box, esito, ricarica);
    } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
  });
  scarta.addEventListener("click", async () => { try { await api(`/api/whatsapp/risposte/${encodeURIComponent(r.id)}`, { metodo: "DELETE" }); ricarica(); } catch (err) { esito.textContent = err.message; } });
  const azioni = crea("div", "azioni-modulo"); azioni.append(invia, scarta);
  box.append(etichetta, area, azioni, esito);
  return box;
}
async function apriRispostaWa(d, zona, pulsante, ricarica) {
  pulsante.disabled = true;
  zona.replaceChildren(crea("p", "vuoto", "Jarvis prepara il testo…"));
  let testo = "";
  try { testo = (await api(`/api/whatsapp/chat/${encodeURIComponent(d.contatto.id)}/proponi`, { metodo: "POST", corpo: {} })).testo; } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    zona.replaceChildren(crea("p", "esito male", e.message));
  }
  const id = `nuova-risposta-${d.contatto.id}`;
  const etichetta = crea("label", "", `Risposta a ${d.contatto.nome} (${d.contatto.nomeSpazio})`); etichetta.htmlFor = id;
  const area = crea("textarea", "testo-bozza"); area.id = id; area.value = testo; area.rows = 5; area.maxLength = 4000;
  const nota = crea("p", "aiuto", "Correggi il testo se serve. Il messaggio parte solo quando premi «Invia» e confermi. Dove Jarvis non sa (soldi, date, impegni) ha scritto [da completare].");
  const invia = crea("button", "primario", "Invia"); invia.type = "button";
  const annulla = crea("button", "secondario", "Annulla"); annulla.type = "button";
  const esito = crea("p", "esito"); esito.setAttribute("role", "status");
  annulla.addEventListener("click", () => { zona.replaceChildren(); pulsante.disabled = false; pulsante.focus(); });
  let salvata = null; // la bozza già salvata sul server (al secondo «Invia» si corregge quella, non se ne crea un'altra)
  invia.addEventListener("click", async () => {
    esito.className = "esito"; esito.textContent = "";
    if (!area.value.trim()) { esito.className = "esito male"; esito.textContent = "Scrivi il testo della risposta."; return; }
    if (/\[\s*da\s+completare\s*\]/i.test(area.value)) { esito.className = "esito male"; esito.textContent = "C'è ancora [da completare]: completa il testo prima di mandarlo."; return; }
    try {
      // Il server salva la bozza pulita e restituisce testo + impronta: la conferma mostra QUEL testo e manda QUELL'impronta.
      salvata = salvata
        ? await api(`/api/whatsapp/risposte/${encodeURIComponent(salvata.id)}`, { metodo: "PATCH", corpo: { testo: area.value } })
        : await api(`/api/whatsapp/chat/${encodeURIComponent(d.contatto.id)}/risposte`, { metodo: "POST", corpo: { testo: area.value } });
      area.value = salvata.testo;
      chiediConfermaInvio(d, salvata, zona, esito, ricarica);
    } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
  });
  const azioni = crea("div", "azioni-modulo"); azioni.append(invia, annulla);
  if (zona.firstChild?.classList?.contains("vuoto")) zona.replaceChildren();
  zona.append(etichetta, area, nota, azioni, esito);
  area.focus();
}
$("#waGiorni").addEventListener("change", caricaWhatsapp);
$("#waUrgenti").addEventListener("change", caricaWhatsapp);
$("#waAggiorna").addEventListener("click", async () => {
  const b = $("#waAggiorna"), st = $("#waStato");
  b.disabled = true;
  try {
    const r = await api("/api/whatsapp/aggiorna", { metodo: "POST", corpo: {} });
    st.className = "esito"; st.textContent = r.messaggio;
    await caricaWhatsapp();
  } catch (e) { if (e instanceof NonAutenticato) return mostraAccesso(); st.className = "esito male"; st.textContent = e.message; } finally { b.disabled = false; }
});

// ------------------------------------------------------------------ Impostazioni → WhatsApp (i segreti non tornano mai: solo «impostato sì/no»)
async function caricaWaImpostazioni() {
  try { disegnaWaImpostazioni(await api("/api/whatsapp/collegamento")); } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function mostraCampiWa(provider) {
  $("#waCampiMeta").hidden = provider !== "meta";
  $("#waCampiBsp").hidden = provider !== "bsp";
  $("#waEtichettaToken").textContent = provider === "meta" ? "Token di accesso di Meta" : "Chiave API del fornitore";
}
function disegnaWaImpostazioni(d) {
  $("#waStatoColl").textContent = d.stato;
  $("#waProvider").value = d.provider;
  mostraCampiWa(d.provider);
  $("#waVersione").value = d.versione || "";
  $("#waBase").value = d.baseUrl || "";
  $("#waIntestazione").value = d.intestazione || "";
  $("#waPhoneId").value = d.phoneNumberId || "";
  for (const id of ["#waToken", "#waSegreto", "#waVerifica"]) { $(id).value = ""; $(id).type = "password"; }
  $("#waTokenStato").textContent = `Impostato: ${d.tokenImpostato ? "sì" : "no"}.`;
  $("#waSegretoStato").textContent = `Impostato: ${d.appSecretImpostato ? "sì" : "no"}. Serve a controllare che ogni messaggio arrivi davvero da Meta.`;
  $("#waVerificaStato").textContent = `Impostata: ${d.verifyTokenImpostato ? "sì" : "no"}.`;
  $("#waUrl").textContent = d.urlWebhook;
  $("#waConferme").checked = !!d.confermeAutomatiche;
  $("#waNascondi").checked = !!d.nascondiContenuto;
}
$("#waProvider").addEventListener("change", (e) => mostraCampiWa(e.target.value));
$("#waGenera").addEventListener("click", () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  $("#waVerifica").type = "text";
  $("#waVerifica").value = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  $("#waVerificaStato").textContent = "Copiala ora nel pannello di Meta (Verify Token), poi premi Salva: dopo non la mostro più.";
});
$("#formWhatsapp").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoWhatsapp");
  const corpo = { provider: $("#waProvider").value, phoneNumberId: $("#waPhoneId").value.trim() };
  if (corpo.provider === "meta") corpo.versione = $("#waVersione").value.trim();
  else { corpo.baseUrl = $("#waBase").value.trim(); corpo.intestazione = $("#waIntestazione").value.trim(); }
  if ($("#waToken").value.trim()) corpo.token = $("#waToken").value.trim();
  if ($("#waSegreto").value.trim()) corpo.appSecret = $("#waSegreto").value.trim();
  if ($("#waVerifica").value.trim()) corpo.verifyToken = $("#waVerifica").value.trim();
  try {
    disegnaWaImpostazioni(await api("/api/whatsapp/collegamento", { metodo: "PUT", corpo }));
    esito.className = "esito"; esito.textContent = "Salvato. Il collegamento vero arriva nella parte 2.";
  } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
});
$("#waScollega").addEventListener("click", async () => {
  if (!confirm("Scollegare WhatsApp? Jarvis dimentica token, segreto e parola di verifica (le chat già salvate restano fino a 30 giorni).")) return;
  try { disegnaWaImpostazioni(await api("/api/whatsapp/collegamento", { metodo: "DELETE" })); $("#esitoWhatsapp").className = "esito"; $("#esitoWhatsapp").textContent = "WhatsApp scollegato."; }
  catch (err) { $("#esitoWhatsapp").className = "esito male"; $("#esitoWhatsapp").textContent = err.message; }
});
$("#waConferme").addEventListener("change", async (e) => {
  const attiva = e.target.checked;
  const esito = $("#esitoWaOpzioni");
  if (attiva && !confirm("Attivare le conferme automatiche su WhatsApp? Partono solo ai contatti delle aziende, mai nei gruppi e mai quando si parla di soldi o impegni.")) { e.target.checked = false; return; }
  try {
    await api("/api/impostazioni", { metodo: "PUT", corpo: { whatsappConfermeAutomatiche: attiva } });
    esito.className = "esito"; esito.textContent = attiva ? "Conferme automatiche WhatsApp attive." : "Conferme automatiche WhatsApp spente.";
  } catch (err) { e.target.checked = !attiva; esito.className = "esito male"; esito.textContent = err.message; }
});
$("#waNascondi").addEventListener("change", async (e) => {
  const esito = $("#esitoWaOpzioni");
  try {
    await api("/api/impostazioni", { metodo: "PUT", corpo: { whatsappNascondiContenuto: e.target.checked } });
    esito.className = "esito"; esito.textContent = e.target.checked ? "Le notifiche non mostreranno il nome del contatto." : "Le notifiche mostreranno il nome del contatto (mai il testo).";
  } catch (err) { e.target.checked = !e.target.checked; esito.className = "esito male"; esito.textContent = err.message; }
});

// ------------------------------------------------------------------ Impostazioni → Caselle email
const AIUTO_PRESET = {
  gmail: "Gmail: serve una «password per le app», non la password normale. Vai su myaccount.google.com → Sicurezza (la verifica in due passaggi deve essere attiva) → «Password per le app», creane una chiamata «Jarvis» e copiala qui. Server già impostati.",
  pec: "PEC Aruba: usa l'indirizzo PEC completo e la password della PEC. Server già impostati. Jarvis legge e prepara bozze, ma dalla PEC non manda mai niente.",
  altro: "Altro: scrivi i server della tua posta (devono avere un nome pubblico, per esempio imap.esempio.it). Il collegamento è sempre cifrato (TLS).",
};
const statoCaselle = { tipo: "gmail", modifica: null, dati: null };
function scegliPreset(tipo) {
  statoCaselle.tipo = tipo;
  document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === tipo)));
  $("#aiutoPreset").textContent = AIUTO_PRESET[tipo];
  $("#casServer").hidden = tipo !== "altro";
  $("#casImapHost").required = tipo === "altro";
  $("#rigaConfermeCasella").hidden = tipo === "pec";
  $("#notaPec").hidden = tipo !== "pec";
  $("#etichettaPassword").textContent = tipo === "gmail" ? "Password per le app (16 lettere)" : tipo === "pec" ? "Password della PEC" : "Password";
  $("#casUtente").type = tipo === "altro" ? "text" : "email";
  if (tipo === "pec") $("#casConferme").checked = false;
}
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => scegliPreset(b.dataset.preset)));
scegliPreset("gmail");

async function caricaCaselle() {
  try { disegnaCaselle(await api("/api/posta/caselle")); } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function riempiSpazi(select, aziende, scelta) {
  select.replaceChildren();
  for (const a of aziende) { const o = crea("option", "", a.nome); o.value = a.id; select.append(o); }
  const p = crea("option", "", "Privato"); p.value = "privato"; select.append(p);
  select.value = scelta && [...select.options].some((o) => o.value === scelta) ? scelta : select.options[0]?.value ?? "privato";
}
function disegnaCaselle(d) {
  statoCaselle.dati = d;
  $("#impConferme").checked = !!d.confermeAutomaticheAttive;
  riempiSpazi($("#casSpazio"), d.aziende, statoCaselle.modifica?.spazio ?? $("#casSpazio").value);
  const lista = $("#listaCaselle");
  lista.replaceChildren();
  if (!d.caselle.length) { lista.append(crea("li", "vuoto", "Nessuna casella collegata.")); return; }
  const nomiTipo = { gmail: "Gmail", pec: "PEC", altro: "Altro" };
  for (const c of d.caselle) {
    const li = crea("li", c.spazio === "privato" ? "privato" : "");
    const info = crea("span", "nome-azienda", c.nome);
    info.append(crea("small", "", `${nomiTipo[c.tipo]} · ${c.nomeSpazio} · ${c.utente}`));
    const stato = c.stato.ultimoControllo
      ? `${c.stato.esito === "errore" ? "Errore: " : "Ultimo controllo "}${c.stato.esito === "errore" ? c.stato.messaggio : `${quando(c.stato.ultimoControllo)} (${c.stato.messaggio})`}`
      : "Non ancora controllata";
    const riga = crea("small", `stato-casella${c.stato.esito === "errore" ? " male" : ""}`, stato);
    if (c.confermeAutomatiche) riga.append(document.createTextNode(" · conferme automatiche permesse"));
    info.append(document.createElement("br"), riga);
    const azioni = crea("span", "azioni-azienda");
    const bottone = (testo, etichetta, fn) => { const b = crea("button", "secondario", testo); b.type = "button"; b.setAttribute("aria-label", `${etichetta} ${c.nome}`); b.addEventListener("click", fn); return b; };
    azioni.append(
      bottone("Prova", "Prova la casella", async () => {
        const esito = $("#esitoCaselle");
        esito.className = "esito"; esito.textContent = `Provo ${c.nome}…`;
        const r = await api(`/api/posta/caselle/${encodeURIComponent(c.id)}/prova`, { metodo: "POST", corpo: {} }).catch((e) => ({ ok: false, messaggio: e.message }));
        esito.className = r.ok ? "esito" : "esito male"; esito.textContent = r.messaggio;
      }),
      bottone("Modifica", "Modifica la casella", () => iniziaModifica(c)),
      bottone("Rimuovi", "Rimuovi la casella", async () => {
        if (!confirm(`Vuoi scollegare «${c.nome}» da Jarvis? La password e le mail salvate in Jarvis vengono cancellate; nella casella non cambia niente.`)) return;
        const esito = $("#esitoCaselle");
        try { disegnaCaselle(await api(`/api/posta/caselle/${encodeURIComponent(c.id)}`, { metodo: "DELETE" })); esito.className = "esito"; esito.textContent = `${c.nome} scollegata.`; }
        catch (e) { esito.className = "esito male"; esito.textContent = e.message; }
      }),
    );
    li.append(info, azioni);
    lista.append(li);
  }
}
function iniziaModifica(c) {
  statoCaselle.modifica = c;
  scegliPreset(c.tipo);
  $("#casNome").value = c.nome;
  riempiSpazi($("#casSpazio"), statoCaselle.dati.aziende, c.spazio);
  $("#casUtente").value = c.utente;
  $("#casPassword").value = "";
  $("#casPassword").placeholder = "lascia vuoto per non cambiarla";
  $("#casImapHost").value = c.imap?.host ?? "";
  $("#casImapPorta").value = c.imap?.porta ?? 993;
  $("#casSmtpHost").value = c.smtp?.host ?? "";
  $("#casSmtpPorta").value = c.smtp?.porta ?? 465;
  $("#casConferme").checked = c.confermeAutomatiche;
  $("#casSalva").textContent = "Salva le modifiche";
  $("#casAnnulla").hidden = false;
  $("#titoloNuovaCasella").textContent = `Modifica «${c.nome}»`;
  $("#casNome").focus();
}
function fineModifica() {
  statoCaselle.modifica = null;
  $("#formCasella").reset();
  $("#casPassword").placeholder = "";
  $("#casSalva").textContent = "Prova e aggiungi";
  $("#casAnnulla").hidden = true;
  $("#titoloNuovaCasella").textContent = "Aggiungi una casella";
  scegliPreset(statoCaselle.tipo);
  if (statoCaselle.dati) riempiSpazi($("#casSpazio"), statoCaselle.dati.aziende);
}
$("#casAnnulla").addEventListener("click", fineModifica);
$("#formCasella").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoCaselle");
  const tipo = statoCaselle.tipo;
  const corpo = {
    nome: $("#casNome").value.trim(), tipo, spazio: $("#casSpazio").value, utente: $("#casUtente").value.trim(),
    confermeAutomatiche: tipo !== "pec" && $("#casConferme").checked,
  };
  const password = $("#casPassword").value;
  if (password) corpo.password = password;
  if (tipo === "altro") {
    corpo.imap = { host: $("#casImapHost").value.trim(), porta: Number($("#casImapPorta").value) || 993 };
    if ($("#casSmtpHost").value.trim()) corpo.smtp = { host: $("#casSmtpHost").value.trim(), porta: Number($("#casSmtpPorta").value) || 465 };
  }
  const modifica = statoCaselle.modifica;
  if (!modifica && !password) { esito.className = "esito male"; esito.textContent = "Scrivi la password."; $("#casPassword").focus(); return; }
  const bottone = $("#casSalva");
  bottone.disabled = true;
  esito.className = "esito"; esito.textContent = "Provo l'accesso alla casella…";
  try {
    const d = modifica
      ? await api(`/api/posta/caselle/${encodeURIComponent(modifica.id)}`, { metodo: "PATCH", corpo })
      : await api("/api/posta/caselle", { metodo: "POST", corpo });
    esito.className = "esito"; esito.textContent = modifica ? "Casella aggiornata." : `Casella collegata: ${corpo.nome}.`;
    fineModifica();
    disegnaCaselle(d);
  } catch (err) {
    if (err instanceof NonAutenticato) return mostraAccesso();
    esito.className = "esito male"; esito.textContent = err.message;
  } finally {
    bottone.disabled = false;
    $("#casPassword").value = "";
  }
});
$("#impConferme").addEventListener("change", async (e) => {
  const attiva = e.target.checked;
  const esito = $("#esitoConferme");
  if (attiva && !confirm("Attivare le conferme di ricezione automatiche? Partono solo dalle caselle dove le hai permesse, mai dalle PEC e mai quando la mail parla di soldi o impegni.")) { e.target.checked = false; return; }
  try {
    await api("/api/impostazioni", { metodo: "PUT", corpo: { confermeAutomaticheAttive: attiva } });
    esito.className = "esito"; esito.textContent = attiva ? "Conferme automatiche attive." : "Conferme automatiche spente.";
  } catch (err) { e.target.checked = !attiva; esito.className = "esito male"; esito.textContent = err.message; }
});

// ------------------------------------------------------------------ Impostazioni → Calendario Apple
async function caricaApple() {
  try { disegnaApple(await api("/api/calendario-apple")); } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function disegnaApple(d) {
  $("#appleStato").textContent = d.collegato ? `sì (${d.appleId})` : "no";
  if (d.collegato) $("#appleId").value = d.appleId;
  $("#appleScollega").hidden = !d.collegato;
  $("#appleProva").hidden = !d.collegato;
  const lista = $("#listaCalendariApple");
  lista.replaceChildren();
  $("#appleSalvaScelta").hidden = !d.calendari.length;
  if (!d.collegato) { lista.append(crea("li", "vuoto", "Collega prima l'account Apple.")); return; }
  if (!d.calendari.length) { lista.append(crea("li", "vuoto", "Nessun calendario trovato.")); return; }
  d.calendari.forEach((c, i) => {
    const li = crea("li");
    li.dataset.url = c.url;
    const spunta = crea("label", "spunta");
    const box = crea("input");
    box.type = "checkbox";
    box.checked = c.incluso;
    box.className = "usa-calendario";
    const pallino = crea("span", "pallino");
    if (c.colore) pallino.style.background = c.colore;
    spunta.append(box, pallino, document.createTextNode(c.nome));
    const sel = crea("select", "spazio-calendario");
    sel.id = `spazioCal${i}`;
    sel.setAttribute("aria-label", `Il calendario «${c.nome}» è di`);
    riempiSpazi(sel, d.aziende, c.spazio);
    li.append(spunta, sel);
    lista.append(li);
  });
}
$("#formApple").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoApple");
  const appleId = $("#appleId").value.trim(), password = $("#applePassword").value;
  if (!appleId || !password) { esito.className = "esito male"; esito.textContent = "Scrivi l'Apple ID e la password specifica per le app."; return; }
  esito.className = "esito"; esito.textContent = "Mi collego a iCloud…";
  try {
    disegnaApple(await api("/api/calendario-apple", { metodo: "PUT", corpo: { appleId, password } }));
    esito.className = "esito"; esito.textContent = "Calendario Apple collegato: scegli qui sotto quali calendari usare.";
  } catch (err) {
    if (err instanceof NonAutenticato) return mostraAccesso();
    esito.className = "esito male"; esito.textContent = err.message;
  } finally { $("#applePassword").value = ""; }
});
$("#appleSalvaScelta").addEventListener("click", async () => {
  const esito = $("#esitoApple");
  const calendari = [...document.querySelectorAll("#listaCalendariApple li[data-url]")].map((li) => ({
    url: li.dataset.url, incluso: li.querySelector(".usa-calendario").checked, spazio: li.querySelector(".spazio-calendario").value,
  }));
  try {
    disegnaApple(await api("/api/calendario-apple/calendari", { metodo: "PUT", corpo: { calendari } }));
    esito.className = "esito"; esito.textContent = "Scelta salvata.";
    caricaBriefing();
  } catch (err) { esito.className = "esito male"; esito.textContent = err.message; }
});
$("#appleProva").addEventListener("click", async () => {
  const esito = $("#esitoApple");
  esito.className = "esito"; esito.textContent = "Provo il collegamento…";
  const r = await api("/api/calendario-apple/prova", { metodo: "POST", corpo: {} }).catch((e) => ({ ok: false, messaggio: e.message }));
  esito.className = r.ok ? "esito" : "esito male"; esito.textContent = r.messaggio;
});
$("#appleScollega").addEventListener("click", async () => {
  if (!confirm("Scollegare il calendario Apple? Apple ID e password specifica vengono cancellati da Jarvis.")) return;
  try { disegnaApple(await api("/api/calendario-apple", { metodo: "DELETE" })); $("#appleId").value = ""; $("#esitoApple").className = "esito"; $("#esitoApple").textContent = "Calendario Apple scollegato."; caricaBriefing(); }
  catch (err) { $("#esitoApple").className = "esito male"; $("#esitoApple").textContent = err.message; }
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
