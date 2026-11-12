// Offline support for the Skyhold game. Static assets only; nothing dynamic.
const CACHE = 'skyhold-v1';
const ASSETS = ['./', './index.html', './game.js', './style.css', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the game code so edits are never trapped behind a stale cache;
// cache-first for everything else. Falls back to cache when offline.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const isDocument = event.request.mode === 'navigate';
  const isCode = isDocument || /\.(?:js|webmanifest)$/.test(url.pathname);
  if (!isCode) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetchAndCache(event.request)));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {}); return response; })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
  );
});

function fetchAndCache(request) {
  return fetch(request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
    return response;
  }).catch(() => undefined);
}
