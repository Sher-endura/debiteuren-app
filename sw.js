/* Service worker — alleen om de app zelf te kunnen openen zonder internet
   (het omhulsel: HTML, CSS, JS, icoon). Gegevens uit Twinfield worden NOOIT
   bewaard door de service worker: elke aanroep naar het doorgeefluik gaat
   rechtstreeks naar het netwerk. */

const CACHE = "debiteuren-endura-v5";   // v5: P.up by Endura (naam + logo), 12 okt 2026
const OMHULSEL = ["./", "index.html", "styles.css", "api.js", "app.js", "config.js", "manifest.json",
  "pup-logo.png", "pup-logo-licht.png", "favicon.ico", "favicon-16.png", "favicon-32.png", "favicon-48.png",
  "favicon-180.png", "favicon-192.png", "favicon-512.png", "werkbeschrijving.html", "werkbeschrijving.pdf"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OMHULSEL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then(namen => Promise.all(namen.filter(n => n !== CACHE).map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Alles wat niet ons eigen omhulsel is (Supabase, DirectLink, de supabase-js
  // bibliotheek) laten we ongemoeid: dat moet altijd verse gegevens zijn.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(antwoord => {
        const kopie = antwoord.clone();
        caches.open(CACHE).then(c => c.put(e.request, kopie)).catch(() => {});
        return antwoord;
      })
      .catch(() => caches.match(e.request).then(gevonden => gevonden || caches.match("index.html")))
  );
});
