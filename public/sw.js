// Service worker di Jarvis: rende l'app installabile, tiene in cache solo i file dell'interfaccia
// (MAI le risposte delle API, che contengono dati personali) e mostra le notifiche del briefing.
const VERSIONE = "jarvis-v4";
const FILE = ["/", "/index.html", "/stile.css", "/app.js", "/api.js", "/voce.js", "/classic/scena2d.js", "/manifest.webmanifest", "/icone/icona.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== VERSIONE).map((x) => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/vendor/")) return;
  // prima la rete (versione aggiornata), la cache solo se la rete manca
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && FILE.includes(u.pathname)) { const copia = r.clone(); caches.open(VERSIONE).then((c) => c.put(e.request, copia)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))));
});
self.addEventListener("push", (e) => {
  let d = { titolo: "Jarvis", testo: "Il briefing di oggi è pronto.", url: "/" };
  try { d = { ...d, ...e.data.json() }; } catch { /* notifica senza dati */ }
  e.waitUntil(self.registration.showNotification(d.titolo, { body: d.testo, icon: "/icone/icona-192.png", badge: "/icone/icona-192.png", data: { url: d.url }, lang: "it" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", location.origin);
  if (url.origin !== location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((lista) => {
    const aperta = lista.find((c) => new URL(c.url).origin === location.origin);
    return aperta ? aperta.focus() : self.clients.openWindow(url.href);
  }));
});
