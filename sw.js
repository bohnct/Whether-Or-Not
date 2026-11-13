// Service worker: caches the app shell so it opens instantly and works offline.
// Forecast data is cached by the app itself (localStorage); radar tiles are always live.
const CACHE = "my-weather-v3";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "cities.js",
  "charts.js",
  "manifest.json",
  "icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: network first (so updates show immediately), cache when offline.
// Leaflet + fonts: cache first (versioned, never change).
// Everything else (forecast API, radar and map tiles) goes straight to the network.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request, { cache: "no-cache" }) // always revalidate so updates appear on the next open
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  } else if (url.host === "unpkg.com" || url.host.endsWith("fonts.googleapis.com") || url.host.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
