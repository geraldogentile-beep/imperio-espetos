// Service Worker — Império dos Espetos PWA
const CACHE_NAME = "imperio-v1";
const ASSETS = ["/", "/index.html"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  // Só faz cache de assets estáticos, não das chamadas à API
  if (e.request.url.includes("/api/") || e.request.url.includes("onrender.com")) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
