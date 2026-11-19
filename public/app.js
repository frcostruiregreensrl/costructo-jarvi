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

const PAGINE = ["home", "posta", "whatsapp", "proposte", "memoria", "registro", "spesa", "impostazioni"];
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
  if (p === "proposte") caricaProposte();
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
  if (!$("#pagina-proposte").hidden) caricaProposte();
  caricaPerOggi();
}
document.querySelectorAll("[data-vista]").forEach((b) => b.addEventListener("click", () => impostaVista(b.dataset.vista)));

// ------------------------------------------------------------------ briefing e «Adesso»
async function caricaBriefing() {
  try {
    stato.briefing = await api("/api/briefing");
    disegnaAdesso();
    caricaPerOggi();
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
  for (const t of stato.perOggi?.righe ?? []) { voce.di(t); aggiungiBattuta("jarvis", t); }
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
  "proposta.prepara": "Proposta per Costructo preparata", "proposta.invio": "Proposta mandata a Costructo", "proposta.correggi": "Proposta corretta",
  "proposta.scarta": "Proposta scartata", "proposta.stato": "Stato delle proposte da Costructo", "costructo.proposta": "Proposta per Costructo",
  "proposta.leggi": "Lettura delle proposte", "ricerca.leggi": "Ricerca unica", "whatsapp.vocale": "Vocale trascritto", "whatsapp.allegato": "Allegato WhatsApp scaricato",
  "whatsapp.operaio": "Operaio di un contatto WhatsApp", "whatsapp.promessa": "Promessa in chat", "whatsapp.scontrino": "Scontrino (solo in Jarvis)",
  "whatsapp.modello": "Promemoria con modello Meta", "funzioni.analisi": "Analisi dei messaggi", "funzioni.estrazione": "Estrazione con l'AI", "funzioni.pulizia": "Pulizia funzioni (30 giorni)",
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
    if (s.whatsapp) {
      const w = s.whatsapp;
      const euro = (n) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 });
      $("#spesaWaInviati").textContent = String(w.inviati);
      $("#spesaWaTetto").textContent = String(w.tetto);
      $("#spesaWaPrezzo").textContent = euro(w.prezzoEur);
      $("#spesaWaNota").textContent = `${w.mese} · risposte ${w.perTipo.risposta}, conferme automatiche ${w.perTipo.conferma}, modelli ${w.perTipo.modello} · costo stimato ${euro(w.stimaEur)}${w.raggiunto ? " · tetto raggiunto: Jarvis non manda più messaggi da solo fino al mese prossimo (tu puoi sempre rispondere dal telefono)." : "."}`;
    }
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
    caricaFunzioniImpostazioni();
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
    contenitore.append(crea("p", "vuoto", d.collegamento?.webhookAttivo ? "Nessuna chat in questo periodo." : "Ancora nessun messaggio: collega WhatsApp in Impostazioni → WhatsApp."));
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
    if (m.vicino) li.append(crea("p", "posta-meta", `Vicino al cantiere ${m.vicino.cantiere} (${m.vicino.metri} m)`));
    else if (m.cantiere) li.append(crea("p", "posta-meta", `Cantiere: ${m.cantiere}`));
    if (m.proposte?.length) {
      const et = crea("span", "etichette");
      for (const x of m.proposte) et.append(crea("span", "etichetta proposta", `Proposta: ${NOMI_TIPI_BREVI[x.tipo] || x.tipo}`));
      li.append(et);
    }
    if (!d.contatto.gruppo && m.direzione !== "out" && !m.automatico) li.append(azioneProponi(d, m));
    lista.append(li);
  }
  box.append(lista);
  if (d.contatto.spazio === "privato") box.append(spuntaEsclusa(d));
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
    box.append(crea("p", "avviso-forte", "Sono passate più di 24 ore dall'ultimo messaggio di questo contatto: WhatsApp permette di scrivere solo con un «modello» approvato da Meta. Se serve, rispondi dal telefono."));
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
  const d360 = provider === "360dialog";
  $("#waCampiMeta").hidden = d360;
  $("#waCampiFirma").hidden = d360;
  $("#waCampiBsp").hidden = !d360;
  $("#waPassi360").hidden = !d360;
  $("#waAvanzate").hidden = !d360;
  $("#waConfigura360").hidden = !d360;
  $("#waFacoltativo").hidden = !d360;
  $("#waEtichettaToken").textContent = d360 ? "Chiave API di 360dialog" : "Token di accesso di Meta";
}
const quandoWa = (ms) => (ms ? new Date(ms).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "");
const NOMI_EVENTI_WA = { PARTNER_REMOVED: "collegamento tolto", ACCOUNT_OFFBOARDED: "numero scollegato da Meta", ACCOUNT_RECONNECTED: "di nuovo collegato", MESSAGGI_IN_ARRIVO: "messaggi di nuovo in arrivo" };
function disegnaWaImpostazioni(d) {
  $("#waStatoColl").textContent = d.stato;
  $("#waProvider").value = d.provider;
  mostraCampiWa(d.provider);
  $("#waVersione").value = d.versione || "";
  $("#waBase").value = d.baseUrl || "https://waba-v2.360dialog.io";
  $("#waPhoneId").value = d.phoneNumberId || "";
  $("#waPercorsoSalute").value = d.percorsoSalute || "";
  $("#waPercorsoSync").value = d.percorsoSync || "";
  for (const id of ["#waToken", "#waSegreto", "#waVerifica"]) { $(id).value = ""; $(id).type = "password"; }
  $("#waTokenStato").textContent = `${d.provider === "360dialog" ? "Impostata" : "Impostato"}: ${d.tokenImpostato ? "sì" : "no"}.`;
  $("#waSegretoStato").textContent = `Impostato: ${d.appSecretImpostato ? "sì" : "no"}. Serve a controllare che ogni messaggio arrivi davvero da Meta.`;
  $("#waVerificaStato").textContent = `Impostata: ${d.verifyTokenImpostato ? "sì" : "no"}.`;
  $("#waUrl").textContent = d.urlWebhook;
  $("#waControllo").textContent = `Controllo dei messaggi in arrivo: ${d.controlloWebhook}`;
  $("#waStatoWebhook").textContent = d.provider === "360dialog"
    ? (d.webhookConfigurato ? `Webhook configurato su 360dialog il ${quandoWa(d.webhookConfigurato)}. Indirizzo: ${d.urlWebhook}` : "Webhook non ancora configurato su 360dialog.")
    : "";
  const c = d.connessione;
  const conn = $("#waConnessione");
  conn.className = c && c.stato === "interrotto" ? "avviso-forte" : "aiuto";
  conn.textContent = !c ? "" : c.stato === "interrotto"
    ? `Il collegamento WhatsApp si è interrotto${c.evento ? ` (${NOMI_EVENTI_WA[c.evento] || c.evento}, ${quandoWa(c.quando)})` : ""}: apri WhatsApp Business sul telefono.`
    : `Collegato il ${quandoWa(c.collegatoIl)}.${c.ultimaAttivita ? ` Ultimo messaggio arrivato: ${quandoWa(c.ultimaAttivita)}.` : " Nessun messaggio ancora arrivato."}${c.evento ? ` Ultimo evento: ${NOMI_EVENTI_WA[c.evento] || c.evento} (${quandoWa(c.quando)}).` : ""}`;
  const s = d.sync || {};
  const passo = (p, nome) => (p?.stato === "fatto" ? `${nome}: fatto il ${quandoWa(p.quando)}` : p?.stato && p.stato !== "mai" ? `${nome}: ${p.stato === "incerto" ? "esito incerto" : "non riuscito"} (${p.esito})` : `${nome}: da fare`);
  $("#waStatoSync").textContent = s.fatta
    ? `Sincronizzazione delle chat fatta (${passo(s.contatti, "contatti")}; ${passo(s.storico, "storico")}). Non va ripetuta.`
    : `Sincronizzazione delle chat: una volta sola, entro 24 ore dal collegamento${c ? ` (collegato il ${quandoWa(c.collegatoIl)})` : ""}. ${passo(s.contatti, "Contatti")}; ${passo(s.storico, "storico")}.`;
  $("#waSincronizza").disabled = !!s.fatta;
  const inv = d.invii;
  if (inv) {
    $("#waInviiMese").textContent = String(inv.inviati);
    $("#waInviiTetto").textContent = String(inv.tetto);
    if (document.activeElement !== $("#waTettoMessaggi")) $("#waTettoMessaggi").value = String(inv.tetto);
    if (document.activeElement !== $("#waPrezzoMessaggio")) $("#waPrezzoMessaggio").value = String(inv.prezzoEur);
  }
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
  if (corpo.provider === "meta") {
    corpo.versione = $("#waVersione").value.trim();
    if ($("#waSegreto").value.trim()) corpo.appSecret = $("#waSegreto").value.trim();
    if ($("#waVerifica").value.trim()) corpo.verifyToken = $("#waVerifica").value.trim();
  } else {
    corpo.baseUrl = $("#waBase").value.trim();
    corpo.percorsoSalute = $("#waPercorsoSalute").value.trim();
    corpo.percorsoSync = $("#waPercorsoSync").value.trim();
  }
  if ($("#waToken").value.trim()) corpo.token = $("#waToken").value.trim();
  try {
    const d = await api("/api/whatsapp/collegamento", { metodo: "PUT", corpo });
    disegnaWaImpostazioni(d);
    esito.className = "esito";
    esito.textContent = d.provider === "360dialog" && !d.webhookAttivo ? "Salvato. Ora premi «Configura il webhook su 360dialog»." : "Salvato.";
  } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
});
/** Pulsanti della parte 2: risposta {ok, messaggio, stato?} anche quando l'esito non è buono (502). */
async function operazioneWa(bottone, percorso, corpo) {
  const esito = $("#esitoWhatsapp");
  bottone.disabled = true;
  esito.className = "esito"; esito.textContent = "Un momento…";
  try {
    const r = await fetch(percorso, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), credentials: "same-origin" });
    if (r.status === 401) return mostraAccesso();
    const d = await r.json().catch(() => ({}));
    if (d.stato) disegnaWaImpostazioni(d.stato); else await caricaWaImpostazioni();
    esito.className = d.ok ? "esito" : "esito male";
    esito.textContent = d.messaggio || d.errore || "Operazione non riuscita.";
  } catch { esito.className = "esito male"; esito.textContent = "Jarvis non risponde: riprova."; } finally { bottone.disabled = false; }
}
$("#waConfigura360").addEventListener("click", (e) => operazioneWa(e.currentTarget, "/api/whatsapp/360dialog/webhook", {}));
$("#waProva").addEventListener("click", (e) => operazioneWa(e.currentTarget, "/api/whatsapp/prova", {}));
$("#waSincronizza").addEventListener("click", (e) => {
  if (!confirm("Sincronizzare contatti e storico delle chat? Si fa una volta sola, entro 24 ore dal collegamento dell'app WhatsApp Business.")) return;
  operazioneWa(e.currentTarget, "/api/whatsapp/sincronizza", { conferma: true });
});
$("#waSalvaTetto").addEventListener("click", async () => {
  const esito = $("#esitoWaTetto");
  const tetto = Number($("#waTettoMessaggi").value), prezzo = Number($("#waPrezzoMessaggio").value);
  if (!Number.isInteger(tetto) || tetto < 0 || !(prezzo >= 0 && prezzo <= 1)) { esito.className = "esito male"; esito.textContent = "Scrivi un tetto (numero intero) e un prezzo tra 0 e 1 euro."; return; }
  try {
    await api("/api/impostazioni", { metodo: "PUT", corpo: { whatsappTettoMessaggiMese: tetto, whatsappPrezzoMessaggioEur: prezzo } });
    esito.className = "esito"; esito.textContent = `Salvato: al massimo ${tetto} messaggi di Jarvis al mese.`;
    await caricaWaImpostazioni();
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

// ------------------------------------------------------------------ Fase 3b: proposte per Costructo, «Per oggi», ricerca, rubrica
// Regola di Luigi: Jarvis non scrive mai record definitivi in Costructo. Prepara proposte: Luigi vede il testo completo,
// conferma qui («Sì, manda») e approva in Costructo. Le cose private restano nell'agenda di Jarvis.
const NOMI_TIPI_BREVI = { ore: "ore", foto: "foto", rinnovo_documento: "rinnovo documento", carico_magazzino: "consegna", richiesta_lavoro: "richiesta di lavoro", agenda: "appuntamento", contatto: "telefono", documento_fornitore: "documento fornitore", diario: "diario", invio_documenti: "invio documenti", agenda_privata: "promemoria privato" };
const NOMI_STATI_PROPOSTA = { da_confermare: "Da confermare", errore: "Non partita", attesa_costructo: "In attesa della pagina Proposte in Costructo", inviata: "Mandata", gia_presente: "Già presente in Costructo", in_invio: "In invio" };
const NOMI_STATI_COSTRUCTO = { in_attesa: "da approvare in Costructo", accettata: "accettata in Costructo", scartata: "scartata in Costructo", superata: "superata in Costructo" };
const CONFERMABILI = ["da_confermare", "errore", "attesa_costructo"];
stato.scelteProposte = new Map();
stato.perOggi = null;
const dataBreve = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d || "");

async function caricaProposte() {
  try {
    const d = await api(`/api/proposte?vista=${stato.vista}`);
    disegnaProposte(d);
  } catch (e) {
    if (e instanceof NonAutenticato) return mostraAccesso();
    $("#propGruppi").replaceChildren(crea("p", "vuoto", "Le proposte non sono disponibili in questo momento."));
  }
  caricaDomandeOperai();
  caricaRubrica();
  caricaScontrini();
  $("#rigaCercaPrivato").hidden = stato.vista !== "tutto";
}
function aggiornaPulsanteLotto() {
  const n = stato.scelteProposte.size;
  $("#propMandaScelte").disabled = n === 0;
  $("#propMandaScelte").textContent = n ? `Manda le ${n} proposte scelte` : "Manda le proposte scelte";
}
function disegnaProposte(d) {
  stato.scelteProposte.clear();
  aggiornaPulsanteLotto();
  $("#propConfermaLotto").replaceChildren();
  const contenitore = $("#propGruppi");
  contenitore.replaceChildren();
  if (!d.proposte.length) { contenitore.append(crea("p", "vuoto", "Nessuna proposta. Quando su WhatsApp arrivano ore, foto, documenti o appuntamenti, le trovi qui.")); return; }
  const gruppi = [
    { titolo: "Da confermare", stati: ["da_confermare", "errore", "in_invio"] },
    { titolo: "In attesa della pagina Proposte in Costructo", stati: ["attesa_costructo"] },
    { titolo: "Mandate", stati: ["inviata"] },
    { titolo: "Già presenti in Costructo", stati: ["gia_presente"] },
  ];
  for (const g of gruppi) {
    const qui = d.proposte.filter((p) => g.stati.includes(p.stato));
    if (!qui.length) continue;
    const sezione = crea("section", "gruppo-proposte");
    sezione.append(crea("h2", "", `${g.titolo} (${qui.length})`));
    const lista = crea("ul", "lista-posta");
    for (const p of qui.sort((a, b) => a.nomeAzienda.localeCompare(b.nomeAzienda, "it") || b.creata - a.creata)) lista.append(schedaProposta(p));
    sezione.append(lista);
    contenitore.append(sezione);
  }
}
function schedaProposta(p) {
  const li = crea("li", `proposta ${p.azienda === "privato" ? "privato" : "lavoro"}${p.completa ? "" : " incompleta"}`);
  li.id = `proposta-${p.id}`;
  const testa = crea("div", "posta-testa");
  testa.append(crea("b", "posta-oggetto", p.titolo));
  const et = crea("span", "etichette");
  et.append(crea("span", "etichetta", p.nomeTipo));
  et.append(crea("span", `etichetta ${p.stato === "gia_presente" ? "attesa" : ""}`, NOMI_STATI_PROPOSTA[p.stato] || p.stato));
  if (p.statoCostructo) et.append(crea("span", "etichetta", NOMI_STATI_COSTRUCTO[p.statoCostructo] || p.statoCostructo));
  if (!p.completa && CONFERMABILI.includes(p.stato)) et.append(crea("span", "etichetta urgente", "Da completare"));
  if (p.automatica) et.append(crea("span", "etichetta", "Mandata in automatico"));
  testa.append(et);
  li.append(testa, crea("small", "posta-meta", `${p.nomeAzienda} · ${quando(p.creata)}`));
  const testo = crea("pre", "testo-completo", p.testoCompleto);
  testo.setAttribute("aria-label", `Testo completo della proposta: ${p.titolo}`);
  li.append(testo);
  if (p.allegati.length) {
    const box = crea("div", "miniature");
    p.allegati.forEach((a, n) => {
      const url = `/api/proposte/${encodeURIComponent(p.id)}/allegato/${n}`;
      if (a.mime.startsWith("image/") && a.mime !== "image/heic") { const img = crea("img"); img.src = url; img.alt = `Allegato: ${a.nome}`; img.loading = "lazy"; box.append(img); }
      else { const l = crea("a", "", `Apri ${a.nome}`); l.href = url; l.target = "_blank"; l.rel = "noopener noreferrer"; box.append(l); }
    });
    li.append(box);
  }
  if (p.mancano.length && CONFERMABILI.includes(p.stato)) li.append(crea("p", "esito male", `Da completare prima di confermare: ${p.mancano.join(", ")}.`));
  if (p.esito && p.stato !== "da_confermare") li.append(crea("p", p.stato === "errore" ? "esito male" : "posta-meta", p.esito));
  if (p.motivoCostructo) li.append(crea("p", "posta-meta", `Costructo: ${p.motivoCostructo}`));
  if (!CONFERMABILI.includes(p.stato)) return li;
  const zona = crea("div", "zona-bozza");
  const esito = crea("p", "esito"); esito.setAttribute("role", "status");
  const azioni = crea("div", "azioni-modulo");
  const scegli = crea("label", "spunta");
  const spunta = crea("input"); spunta.type = "checkbox"; spunta.disabled = !p.completa;
  spunta.addEventListener("change", () => { if (spunta.checked) stato.scelteProposte.set(p.id, p); else stato.scelteProposte.delete(p.id); aggiornaPulsanteLotto(); });
  scegli.append(spunta, document.createTextNode(" Scegli"));
  const manda = crea("button", "primario", p.perCostructo ? "Manda a Costructo" : "Segna nell'agenda privata"); manda.type = "button"; manda.disabled = !p.completa;
  const correggi = crea("button", "secondario", "Correggi"); correggi.type = "button";
  const scarta = crea("button", "secondario", "Scarta"); scarta.type = "button";
  manda.setAttribute("aria-label", `${manda.textContent}: ${p.titolo}`);
  manda.addEventListener("click", () => chiediConfermaProposte([p], zona, esito));
  correggi.addEventListener("click", () => apriCorrezione(p, zona, esito));
  scarta.addEventListener("click", async () => {
    if (!confirm("Scartare questa proposta? In Costructo non arriva niente.")) return;
    try { await api(`/api/proposte/${encodeURIComponent(p.id)}`, { metodo: "DELETE" }); caricaProposte(); } catch (e) { esito.className = "esito male"; esito.textContent = e.message; }
  });
  azioni.append(scegli, manda, correggi, scarta);
  li.append(azioni, zona, esito);
  return li;
}
/** Conferma esplicita: il testo COMPLETO di ogni proposta, poi «Sì, manda». Si mandano le impronte di quello che si è visto. */
function chiediConfermaProposte(lista, zona, esito) {
  zona.querySelector(".conferma-proposte")?.remove();
  const box = crea("div", "conferma conferma-proposte");
  box.setAttribute("role", "group");
  const perCostructo = lista.some((p) => p.perCostructo);
  box.append(crea("p", "", lista.length === 1
    ? (perCostructo ? "Mando questa proposta a Costructo? Resta una bozza: la approvi tu in Costructo." : "Segno questo promemoria nell'agenda privata di Jarvis?")
    : `Mando queste ${lista.length} proposte? Quelle per Costructo restano bozze da approvare in Costructo; quelle private vanno nell'agenda di Jarvis.`));
  for (const [n, p] of lista.entries()) box.append(crea("pre", "testo-completo", `${lista.length > 1 ? `${n + 1}) ` : ""}${p.testoCompleto}`));
  const azioni = crea("div", "azioni");
  const si = crea("button", "primario", lista.length === 1 ? "Sì, manda" : `Sì, manda tutte e ${lista.length}`); si.type = "button";
  const no = crea("button", "secondario", "Annulla"); no.type = "button";
  no.addEventListener("click", () => box.remove());
  si.addEventListener("click", async () => {
    si.disabled = true; no.disabled = true;
    try {
      const r = await api("/api/proposte/manda", { metodo: "POST", corpo: { conferma: true, voci: lista.map((p) => ({ id: p.id, impronta: p.impronta })) } });
      esito.className = r.esiti.every((x) => x.ok) ? "esito" : "esito male"; esito.textContent = r.messaggio;
      setTimeout(caricaProposte, 1500);
    } catch (e) { if (e instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = e.message; }
    box.remove();
  });
  azioni.append(si, no);
  box.append(azioni);
  zona.append(box);
  si.focus();
}
$("#propMandaScelte").addEventListener("click", () => {
  const lista = [...stato.scelteProposte.values()];
  if (lista.length) chiediConfermaProposte(lista, $("#propConfermaLotto"), $("#propStato"));
});
$("#propAggiornaStati").addEventListener("click", async () => {
  try { const r = await api("/api/proposte/aggiorna-stati", { metodo: "POST", corpo: {} }); $("#propStato").className = "esito"; $("#propStato").textContent = r.messaggio; caricaProposte(); }
  catch (e) { if (e instanceof NonAutenticato) return mostraAccesso(); $("#propStato").className = "esito male"; $("#propStato").textContent = e.message; }
});
async function apriCorrezione(p, zona, esito) {
  zona.querySelector(".correzione")?.remove();
  const modulo = crea("form", "sottomodulo correzione");
  let scelte = { cantieri: [], operai: [] };
  if (p.campi.some((c) => c.tipo === "cantiere" || c.tipo === "operaio")) { try { scelte = await api(`/api/proposte/${encodeURIComponent(p.id)}/scelte`); } catch { /* restano vuote */ } }
  const campi = [];
  for (const c of p.campi) {
    if (c.tipo === "sola_lettura") continue;
    const id = `corr-${p.id}-${c.chiave}`;
    const etichetta = crea("label", "", `${c.etichetta}${c.obbligatorio ? " (obbligatorio)" : ""}`);
    etichetta.htmlFor = id;
    let el;
    const valore = p.dati[c.chiave];
    if (c.tipo === "cantiere" || c.tipo === "operaio" || c.tipo === "scelta") {
      el = crea("select");
      const opzioni = c.tipo === "cantiere" ? scelte.cantieri : c.tipo === "operaio" ? scelte.operai : (c.opzioni || []).map((x) => ({ id: x, nome: x }));
      el.append(Object.assign(crea("option", "", "—"), { value: "" }));
      for (const o of opzioni) { const op = crea("option", "", o.nome); op.value = o.id; if (String(valore ?? "") === String(o.id)) op.selected = true; el.append(op); }
    } else if (c.tipo === "testo_lungo" || c.tipo === "righe") {
      el = crea("textarea", "testo-bozza"); el.rows = 4;
      el.value = c.tipo === "righe" ? (Array.isArray(valore) ? valore.map((r) => `${r.quantita} ${r.unita} ${r.descrizione}`).join("\n") : "") : (valore ?? "");
    } else {
      el = crea("input");
      el.type = c.tipo === "numero" ? "number" : c.tipo === "data" ? "date" : c.tipo === "ora" ? "time" : "text";
      if (c.tipo === "numero") el.step = "0.5";
      el.value = valore ?? "";
    }
    el.id = id;
    etichetta.append(el);
    modulo.append(etichetta);
    campi.push({ c, el });
  }
  const azioni = crea("div", "azioni-modulo");
  const salva = crea("button", "primario", "Salva le correzioni"); salva.type = "submit";
  const annulla = crea("button", "secondario", "Annulla"); annulla.type = "button";
  annulla.addEventListener("click", () => modulo.remove());
  azioni.append(salva, annulla);
  modulo.append(azioni);
  modulo.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dati = {}, nomi = {};
    for (const { c, el } of campi) {
      const v = el.value.trim();
      if (c.tipo === "numero") dati[c.chiave] = v === "" ? null : Number(v.replace(",", "."));
      else if (c.tipo === "righe") dati[c.chiave] = v ? v.split("\n").map((r) => /^\s*(\d+(?:[.,]\d+)?)\s+(\S+)\s+(.+)$/.exec(r)).filter(Boolean).map((m) => ({ quantita: Number(m[1].replace(",", ".")), unita: m[2], descrizione: m[3].trim() })) : null;
      else dati[c.chiave] = v || null;
      if ((c.tipo === "cantiere" || c.tipo === "operaio") && v) nomi[c.chiave] = el.selectedOptions[0]?.textContent || "";
    }
    try { await api(`/api/proposte/${encodeURIComponent(p.id)}`, { metodo: "PATCH", corpo: { dati, nomi } }); caricaProposte(); }
    catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
  });
  zona.append(modulo);
  modulo.querySelector("input, select, textarea")?.focus();
}
async function caricaDomandeOperai() {
  const box = $("#propDomande");
  try {
    const domande = stato.vista === "privato" ? [] : await api("/api/funzioni/operai/domande");
    box.replaceChildren();
    $("#propSezioneDomande").hidden = !domande.length;
    for (const q of domande) {
      const s = crea("section", "conferma domanda-operaio");
      s.setAttribute("aria-label", q.domanda);
      s.append(crea("p", "", q.domanda));
      if (q.errore) s.append(crea("p", "esito male", q.errore));
      const azioni = crea("div", "azioni");
      const rispondi = async (operaioId) => {
        azioni.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try { const r = await api(`/api/funzioni/operai/domande/${encodeURIComponent(q.id)}`, { metodo: "POST", corpo: { operaioId } }); $("#propStato").className = "esito"; $("#propStato").textContent = r.messaggio; caricaProposte(); }
        catch (e) { s.append(crea("p", "esito male", e.message)); azioni.querySelectorAll("button").forEach((b) => (b.disabled = false)); }
      };
      for (const o of q.operai) { const b = crea("button", o.id === q.suggerito ? "primario" : "secondario", o.nome); b.type = "button"; b.addEventListener("click", () => rispondi(o.id)); azioni.append(b); }
      const no = crea("button", "secondario", "Non è un operaio"); no.type = "button"; no.addEventListener("click", () => rispondi("")); azioni.append(no);
      s.append(azioni);
      box.append(s);
    }
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
async function caricaRubrica() {
  const box = $("#propRubrica");
  try {
    const d = await api(`/api/funzioni/rubrica?vista=${stato.vista}`);
    box.replaceChildren();
    if (stato.vista === "privato") { box.append(crea("p", "vuoto", "La rubrica riguarda le aziende: apri la scheda Lavoro o Tutto.")); return; }
    let quanti = 0;
    for (const a of d.aziende) {
      const sconosciuti = a.contatti.filter((c) => c.stato === "sconosciuto" || c.stato === "non_operaio_sconosciuto");
      if (!sconosciuti.length && !a.avviso) continue;
      const sez = crea("section", "gruppo-proposte");
      sez.append(crea("h3", "sottotitolo", `${a.nomeAzienda}: ${sconosciuti.length} ${sconosciuti.length === 1 ? "numero sconosciuto" : "numeri sconosciuti"}`));
      if (a.avviso) sez.append(crea("p", "aiuto", a.avviso));
      const ul = crea("ul", "lista-posta");
      for (const c of sconosciuti) {
        quanti++;
        const li = crea("li", "voce-elenco");
        li.append(crea("b", "", c.nome), crea("small", "posta-meta", `${c.numero} · non è tra le controparti di Costructo`));
        if (c.proposta) { li.append(crea("p", "posta-meta", "Proposta già pronta: la trovi qui sopra.")); ul.append(li); continue; }
        if (!c.suggerite.length) { li.append(crea("p", "aiuto", "Nessuna controparte con lo stesso nome: se serve, aggiungila in Costructo.")); ul.append(li); continue; }
        const riga = crea("div", "azioni-modulo wa-azienda");
        const et = crea("label", "", "Controparte ");
        const sel = crea("select");
        for (const s of c.suggerite) { const o = crea("option", "", s.nome); o.value = s.id; sel.append(o); }
        et.append(sel);
        const b = crea("button", "secondario", "Proponi il numero a Costructo"); b.type = "button";
        const es = crea("p", "esito"); es.setAttribute("role", "status");
        b.addEventListener("click", async () => {
          try { const v = await api(`/api/funzioni/rubrica/${encodeURIComponent(c.id)}/proponi`, { metodo: "POST", corpo: { controparteId: sel.value } }); es.className = "esito"; es.textContent = `Proposta pronta: «${v.titolo}». Confermala qui sopra.`; caricaProposte(); }
          catch (e) { es.className = "esito male"; es.textContent = e.message; }
        });
        riga.append(et, b);
        li.append(riga, es);
        ul.append(li);
      }
      sez.append(ul);
      box.append(sez);
    }
    if (!quanti && !box.childElementCount) box.append(crea("p", "vuoto", "Tutti i contatti delle aziende sono in Costructo (o sono operai)."));
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); else box.replaceChildren(crea("p", "vuoto", "Rubrica non disponibile in questo momento.")); }
}
async function caricaScontrini() {
  const ul = $("#propScontrini");
  try {
    const d = await api(`/api/funzioni/scontrini?vista=${stato.vista}`);
    ul.replaceChildren();
    if (!d.scontrini.length) { ul.append(crea("li", "vuoto", "Nessuno scontrino arrivato.")); return; }
    for (const s of d.scontrini) {
      const li = crea("li", "voce-elenco");
      li.append(crea("b", "", s.descrizione || "Scontrino"), crea("small", "posta-meta", `${s.nomeAzienda} · da ${s.contatto} · ${quando(s.creato)}${s.conFoto ? " · foto salvata in Jarvis" : ""}`));
      ul.append(li);
    }
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
$("#formCerca").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#cercaTesto").value.trim();
  if (!q) return;
  const ul = $("#cercaRisultati"), st = $("#cercaStato");
  try {
    const r = await api(`/api/funzioni/cerca?q=${encodeURIComponent(q)}&vista=${stato.vista}${stato.vista === "tutto" && $("#cercaPrivato").checked ? "&privato=1" : ""}`);
    ul.replaceChildren();
    st.className = "esito";
    st.textContent = r.domanda || `${r.risultati.length ? `${r.risultati.length} risultati` : "Nessun risultato"}${r.privatoIncluso ? " (anche nel privato)" : ""}.${r.avvisi.length ? ` ${r.avvisi.join(" · ")}` : ""}`;
    for (const x of r.risultati) {
      const li = crea("li", `voce-elenco ${x.spazio === "privato" ? "privato" : ""}`);
      li.append(crea("b", "", x.titolo), crea("small", "posta-meta", `${x.spazio === "privato" ? "Privato" : x.azienda}${x.quando ? ` · ${quando(x.quando)}` : ""}`));
      if (x.estratto) li.append(crea("p", "posta-riassunto", x.estratto));
      ul.append(li);
    }
  } catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); st.className = "esito male"; st.textContent = err.message; }
});

// «Proponi in Costructo» su un messaggio della pagina WhatsApp: si sceglie il tipo, Jarvis prepara la proposta (non la manda).
function azioneProponi(d, m) {
  const box = crea("div", "proponi-messaggio");
  const apri = crea("button", "link", d.contatto.spazio === "privato" ? "Segna come promemoria" : "Proponi in Costructo");
  apri.type = "button";
  apri.setAttribute("aria-expanded", "false");
  const zona = crea("div", "azioni-modulo");
  zona.hidden = true;
  const sel = crea("select");
  sel.setAttribute("aria-label", "Tipo di proposta");
  const tipi = d.contatto.spazio === "privato" ? ["agenda_privata"] : ["ore", "foto", "documento_fornitore", "rinnovo_documento", "carico_magazzino", "richiesta_lavoro", "agenda", "diario"];
  for (const t of tipi) { const o = crea("option", "", NOMI_TIPI_BREVI[t] || t); o.value = t; sel.append(o); }
  const vai = crea("button", "secondario", "Prepara"); vai.type = "button";
  const esito = crea("p", "esito"); esito.setAttribute("role", "status");
  apri.addEventListener("click", () => { zona.hidden = !zona.hidden; apri.setAttribute("aria-expanded", String(!zona.hidden)); });
  vai.addEventListener("click", async () => {
    try {
      const v = await api("/api/proposte/da-messaggio", { metodo: "POST", corpo: { messaggioId: m.id, tipo: sel.value } });
      esito.className = "esito"; esito.replaceChildren(document.createTextNode(`Proposta pronta, non ancora mandata: «${v.titolo}». `));
      const l = crea("a", "", "Vai alle Proposte"); l.href = "#proposte"; esito.append(l);
    } catch (e) { if (e instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = e.message; }
  });
  zona.append(sel, vai);
  box.append(apri, zona, esito);
  return box;
}
function spuntaEsclusa(d) {
  const l = crea("label", "spunta");
  const c = crea("input"); c.type = "checkbox"; c.checked = !!d.esclusa;
  const es = crea("span", "aiuto");
  c.addEventListener("change", async () => {
    try { await api(`/api/funzioni/chat-escluse/${encodeURIComponent(d.contatto.id)}`, { metodo: "PUT", corpo: { escludi: c.checked } }); es.textContent = c.checked ? " Esclusa." : " Di nuovo inclusa."; }
    catch (e) { c.checked = !c.checked; es.textContent = ` ${e.message}`; }
  });
  l.append(c, document.createTextNode(" Escludi questa chat dalle funzioni private (promemoria, compleanni, vocali)"), es);
  return l;
}

// «Per oggi», azienda per azienda: i testi pronti si aprono in WhatsApp sul tuo telefono (link wa.me): li mandi tu.
async function caricaPerOggi() {
  const box = $("#perOggi");
  try { stato.perOggi = await api(`/api/funzioni/briefing?vista=${stato.vista}`); disegnaPerOggi(stato.perOggi); }
  catch (e) { if (e instanceof NonAutenticato) return mostraAccesso(); box.replaceChildren(crea("p", "vuoto", "Non disponibile in questo momento.")); }
}
function testoPronto(t, modelliAttivi) {
  const li = crea("li", "testo-pronto");
  li.append(crea("b", "", t.titolo), crea("p", "anteprima-pronta", t.testo));
  const azioni = crea("div", "azioni-modulo");
  if (t.link) {
    const a = crea("a", "pulsante-link", `Apri WhatsApp con il testo (${t.numero})`);
    a.href = t.link; a.target = "_blank"; a.rel = "noopener noreferrer";
    azioni.append(a);
  } else azioni.append(crea("span", "aiuto", t.nota || ""));
  const copia = crea("button", "secondario", "Copia il testo"); copia.type = "button";
  copia.addEventListener("click", async () => { try { await navigator.clipboard.writeText(t.testo); copia.textContent = "Copiato"; } catch { copia.textContent = "Non riesco a copiare"; } });
  azioni.append(copia);
  if (modelliAttivi && t.telefono) {
    const b = crea("button", "secondario", "Manda con il modello di Meta"); b.type = "button";
    b.addEventListener("click", () => confermaModello(t, li));
    azioni.append(b);
  }
  li.append(azioni, crea("small", "aiuto", "Jarvis non lo manda: lo mandi tu dal telefono."));
  return li;
}
async function confermaModello(t, li) {
  li.querySelector(".conferma")?.remove();
  const nome = prompt("Nome del modello approvato da Meta (per esempio promemoria_appuntamento):", "promemoria_appuntamento");
  if (!nome) return;
  const corpo = { telefono: t.telefono, nome: nome.trim(), lingua: "it", parametri: [t.titolo.split(" · ")[0]] };
  const box = crea("div", "conferma"); box.setAttribute("role", "group");
  try {
    const pr = await api("/api/funzioni/modello/prepara", { metodo: "POST", corpo });
    box.append(crea("p", "", "Mando questo promemoria con il modello? Parte subito."), crea("p", "anteprima-pronta", pr.anteprima));
    const si = crea("button", "primario", "Sì, manda"); si.type = "button";
    const no = crea("button", "secondario", "Annulla"); no.type = "button";
    no.addEventListener("click", () => box.remove());
    si.addEventListener("click", async () => {
      si.disabled = true;
      try { const r = await api("/api/funzioni/modello/invia", { metodo: "POST", corpo: { ...corpo, conferma: true, id: pr.id, impronta: pr.impronta } }); box.replaceChildren(crea("p", "esito", r.messaggio)); }
      catch (e) { box.replaceChildren(crea("p", "esito male", e.message)); }
    });
    const az = crea("div", "azioni"); az.append(si, no); box.append(az);
  } catch (e) { box.append(crea("p", "esito male", e.message)); }
  li.append(box);
}
function disegnaPerOggi(d) {
  const box = $("#perOggi");
  box.replaceChildren();
  const blocco = (titolo, voci, fn) => {
    if (!voci?.length) return null;
    const s = crea("div", "blocco-oggi");
    s.append(crea("h4", "", titolo));
    const ul = crea("ul", "lista-oggi");
    for (const v of voci) ul.append(fn(v));
    s.append(ul);
    return s;
  };
  const semplice = (t) => crea("li", "", t);
  const promessa = (p) => {
    const li = crea("li", p.scaduta ? "scaduta" : "");
    li.append(document.createTextNode(`${p.scaduta ? "Non mantenuta" : "Entro oggi"}: a ${p.contatto} hai scritto «${p.cosa}». `));
    const b = crea("button", "link", "Fatta"); b.type = "button";
    b.addEventListener("click", async () => { try { await api(`/api/funzioni/promesse/${encodeURIComponent(p.id)}/chiudi`, { metodo: "POST", corpo: {} }); li.remove(); } catch { /* resta */ } });
    li.append(b);
    return li;
  };
  let qualcosa = false;
  for (const a of d.aziende) {
    const parti = [
      blocco("Aspettano una risposta", a.aspettano, (x) => semplice(`${x.contatto} (dal ${quando(x.daQuando)})`)),
      blocco("Promesse", a.promesse, promessa),
      blocco("Solleciti pronti (fatture scadute)", a.solleciti, (t) => testoPronto(t, false)),
      blocco("Preventivi senza risposta", a.preventivi, (t) => testoPronto(t, false)),
      blocco("Appuntamenti di domani: promemoria per i clienti", a.appuntamentiDomani, (t) => testoPronto(t, d.modelliAttivi)),
      blocco(`Cantieri del ${dataBreve(d.giornoCantieri)}`, a.cantieri, (c) => {
        const li = crea("li", "");
        li.append(crea("b", "", c.nome), document.createTextNode(` · ${[c.messaggi ? `${c.messaggi} messaggi` : "", c.foto ? `${c.foto} foto` : "", c.mail ? `${c.mail} mail` : "", c.proposte ? `${c.proposte} proposte` : "", c.impegni ? `${c.impegni} impegni` : ""].filter(Boolean).join(", ")}`));
        for (const f of c.frasi) li.append(crea("small", "posta-meta blocco", f));
        const b = crea("button", "link", "Prepara il diario"); b.type = "button";
        const es = crea("span", "aiuto");
        b.addEventListener("click", async () => {
          try { const v = await api("/api/proposte/diario", { metodo: "POST", corpo: { azienda: a.id, cantiereId: c.cantiereId, data: d.giornoCantieri } }); es.textContent = ` Bozza pronta in Proposte: «${v.titolo}».`; }
          catch (e) { es.textContent = ` ${e.message}`; }
        });
        li.append(b, es);
        return li;
      }),
    ].filter(Boolean);
    if (!parti.length && !a.proposte && !a.avvisi.length) continue;
    qualcosa = true;
    const s = crea("section", "azienda-oggi lavoro");
    const h = crea("h3", "", a.nome);
    if (a.proposte) { const l = crea("a", "conteggio-attesa", `${a.proposte} ${a.proposte === 1 ? "proposta" : "proposte"} da confermare`); l.href = "#proposte"; h.append(l); }
    s.append(h, ...parti);
    for (const av of a.avvisi) s.append(crea("p", "aiuto", av));
    box.append(s);
  }
  if (d.privato && (d.privato.aspettano.length || d.privato.promesse.length || d.privato.promemoria)) {
    qualcosa = true;
    const s = crea("section", "azienda-oggi privato");
    const h = crea("h3", "", "Privato");
    if (d.privato.promemoria) { const l = crea("a", "conteggio-attesa", `${d.privato.promemoria} promemoria da confermare`); l.href = "#proposte"; h.append(l); }
    s.append(h, ...[blocco("Aspettano una risposta", d.privato.aspettano, (x) => semplice(`${x.contatto} (dal ${quando(x.daQuando)})`)), blocco("Promesse", d.privato.promesse, promessa)].filter(Boolean));
    box.append(s);
  }
  if (!qualcosa) box.append(crea("p", "vuoto", "Niente da segnalare."));
}

// Impostazioni → funzioni WhatsApp (le chiavi della trascrizione non tornano mai: solo «impostata sì/no»)
async function caricaFunzioniImpostazioni() {
  try {
    disegnaFunzioniImpostazioni(await api("/api/funzioni/impostazioni"));
    const operai = await api("/api/funzioni/operai");
    const ul = $("#funOperai");
    ul.replaceChildren();
    if (!operai.length) ul.append(crea("li", "vuoto", "Nessun contatto ancora indicato."));
    for (const o of operai) {
      const li = crea("li");
      li.append(crea("span", "", `${o.nomeContatto} (${o.nomeAzienda}): ${o.nomeOperaio}`));
      const b = crea("button", "secondario", "Dimentica"); b.type = "button"; b.setAttribute("aria-label", `Dimentica: ${o.nomeContatto}`);
      b.addEventListener("click", async () => { await api(`/api/funzioni/operai/${encodeURIComponent(o.contatto)}?azienda=${encodeURIComponent(o.azienda)}`, { metodo: "DELETE" }).catch(() => {}); caricaFunzioniImpostazioni(); });
      li.append(b);
      ul.append(li);
    }
  } catch (e) { if (e instanceof NonAutenticato) mostraAccesso(); }
}
function disegnaFunzioniImpostazioni(d) {
  stato.funzioni = d;
  $("#funScarica").checked = d.scaricaAllegati;
  $("#funTrascrizione").value = d.trascrizione.fornitore;
  $("#funChiaveGoogle").value = ""; $("#funChiaveOpenai").value = "";
  $("#funChiaveGoogleStato").textContent = `Impostata: ${d.trascrizione.chiaveImpostata.google ? "sì" : "no"}.`;
  $("#funChiaveOpenaiStato").textContent = `Impostata: ${d.trascrizione.chiaveImpostata.openai ? "sì" : "no"}.`;
  const l = d.trascrizione.listino;
  $("#funCosti").textContent = `Costi indicativi: Google circa ${l.google.alMinuto.toLocaleString("it-IT")} $ al minuto (${l.google.nota}); OpenAI circa ${l.openai.alMinuto.toLocaleString("it-IT")} $ al minuto (${l.openai.nota}). Questo mese: ${d.trascrizione.spesaMese.richieste} vocali, ${d.trascrizione.spesaMese.spesaUsd.toLocaleString("it-IT", { style: "currency", currency: "USD", maximumFractionDigits: 3 })}. Contano nel tetto di spesa. L'audio non viene mai salvato.`;
  const auto = $("#funAutomatiche");
  auto.replaceChildren();
  for (const t of d.tipi) {
    const lab = crea("label", "spunta");
    const c = crea("input"); c.type = "checkbox"; c.value = t.tipo; c.checked = d.proposteAutomatiche.includes(t.tipo);
    lab.append(c, document.createTextNode(` ${t.nome}`));
    auto.append(lab);
  }
  $("#funGiorni").value = d.giorniPreventiviInAttesa;
  $("#funModelli").checked = d.modelliAttivi;
  const ul = $("#funEscluse");
  ul.replaceChildren();
  if (!d.chatEscluse.length) ul.append(crea("li", "vuoto", "Nessuna chat esclusa. Si escludono dalla pagina WhatsApp, aprendo una chat privata."));
  for (const c of d.chatEscluse) {
    const li = crea("li");
    li.append(crea("span", "", c.nome));
    const b = crea("button", "secondario", "Riammetti"); b.type = "button"; b.setAttribute("aria-label", `Riammetti la chat con ${c.nome}`);
    b.addEventListener("click", async () => { try { disegnaFunzioniImpostazioni(await api(`/api/funzioni/chat-escluse/${encodeURIComponent(c.id)}`, { metodo: "PUT", corpo: { escludi: false } })); } catch { /* resta */ } });
    li.append(b);
    ul.append(li);
  }
}
$("#formFunzioni").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esito = $("#esitoFunzioni");
  const spunte = [...$("#funAutomatiche").querySelectorAll("input:checked")];
  const automatiche = spunte.map((c) => c.value);
  const nuove = spunte.filter((c) => !(stato.funzioni?.proposteAutomatiche ?? []).includes(c.value)).map((c) => c.parentElement.textContent.trim());
  if (nuove.length && !confirm(`Queste proposte partiranno per Costructo senza chiederti la conferma: ${nuove.join(", ")}. Restano bozze da approvare in Costructo. Confermi?`)) return;
  const corpo = {
    scaricaAllegati: $("#funScarica").checked, trascrizioneFornitore: $("#funTrascrizione").value, proposteAutomatiche: automatiche,
    giorniPreventiviInAttesa: Number($("#funGiorni").value) || 7, modelliAttivi: $("#funModelli").checked,
  };
  if ($("#funChiaveGoogle").value.trim()) corpo.chiaveGoogle = $("#funChiaveGoogle").value.trim();
  if ($("#funChiaveOpenai").value.trim()) corpo.chiaveOpenai = $("#funChiaveOpenai").value.trim();
  try { disegnaFunzioniImpostazioni(await api("/api/funzioni/impostazioni", { metodo: "PUT", corpo })); esito.className = "esito"; esito.textContent = "Salvato."; }
  catch (err) { if (err instanceof NonAutenticato) return mostraAccesso(); esito.className = "esito male"; esito.textContent = err.message; }
});

// ------------------------------------------------------------------ service worker (installabile come app)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

avvia();
