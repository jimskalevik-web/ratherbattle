// RatherBattle service worker.
// Nett først, alltid: spillet skal aldri vise en gammel versjon når det finnes
// en ny. Lagret kopi brukes bare når telefonen er uten nett.
const LAGER = "rb-2026-09-21 14:21 · ingen-gjentak+temaer+puls";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(LAGER).then((c) => c.addAll(["/"])).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((n) => Promise.all(n.filter((k) => k !== LAGER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin || u.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(r)
      .then((svar) => {
        if (svar.ok) { const kopi = svar.clone(); caches.open(LAGER).then((c) => c.put(r, kopi)); }
        return svar;
      })
      .catch(() => caches.match(r).then((m) => m || caches.match("/")))
  );
});
