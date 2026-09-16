// Service Worker — Império dos Espetos PWA v2
const CACHE_NAME = "imperio-v3";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Nunca faz cache de chamadas de API: qualquer request para fora da
  // origem do painel. Antes checava "onrender.com" (backend antigo), entao
  // com o backend em bisao.tech o SW cacheava pedidos/config/cardapio.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // Pedido com "?": e checagem de versao ou consulta, nunca arquivo do app.
  // Cachear isso enchia o cache de copias e mascarava a versao nova.
  if (url.search) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
