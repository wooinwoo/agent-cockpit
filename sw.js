// Service Worker for Cockpit PWA
// Network-first for everything — ensures fresh code after updates
const CACHE_NAME = 'cockpit-v99';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip API, SSE, WebSocket
  if (url.pathname.startsWith('/api/') || event.request.headers.get('accept')?.includes('text/event-stream')) {
    return;
  }

  // Network-first: try network, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request)
        .then(cached => cached || new Response('Offline', { status: 503 }))
      )
  );
});
