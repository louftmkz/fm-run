// FM RUN service worker
// Strategy: cache-first für statische Assets, network-first für HTML (damit Updates beim
// neuen Deploy schnell durchkommen).

const CACHE_NAME = 'fm-run-v14';
const PRECACHE = [
  './',
  './index.html',
  './install.html',
  './qr-install.png',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.png',
  './sprites/lou-run.png',
  './sprites/sasch-run.png',
  './sprites/shizzo-run.png',
  './sprites/long-run.png',
  './sprites/level-minus-1.png',
  './sprites/level-0.png',
  './sprites/level-1.png',
  './sprites/level-2.png',
  './sprites/level-3.png',
  './sprites/level-4.png',
  './sprites/level-5.png',
  './sprites/level-6.png',
  './sprites/button-lou.png',
  './sprites/button-sasch.png',
  './sprites/button-shizzo.png',
  './sprites/button-long.png',
  './sprites/icon-lou.png?v=2',
  './sprites/icon-sasch.png?v=2',
  './sprites/icon-shizzo.png?v=2',
  './sprites/icon-long.png?v=2',
  './sprites/coin-1.png',
  './sprites/coin-stack.png',
  './sprites/coin-bag.png',
  './sprites/coin-case.png',
  './sprites/coin-pot.png',
  './sprites/coin-1up.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML / navigation: network-first damit neue Versionen sofort sichtbar werden
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Alles andere: cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      return res;
    }))
  );
});
