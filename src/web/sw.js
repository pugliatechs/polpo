// Polpo Service Worker — cache-first for the explicit static shell
// whitelist, network-passthrough for everything else.
//
// v1.2.3 note: earlier versions of this file used a blacklist ("cache
// everything except /api and WebSocket upgrades"). That silently
// intercepted /health — the endpoint the dashboard uses to read the
// polpo version at page load — and returned stale cached responses
// for hours after a polpo restart, so the version bar and About
// modal showed the wrong number (or nothing at all if the cached
// response was gone but the fresh fetch was blocked by an in-flight
// SW upgrade). The fix is to invert the rule: only cache what's on
// the SHELL_ASSETS list, and let everything else pass through to
// the network. Any future dynamic endpoint we add is safe by
// default — no more accidental cache poisoning of dynamic responses.
const CACHE_NAME = 'polpo-v__POLPO_VERSION__';
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/logo-96.png',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];
const SHELL_SET = new Set(SHELL_ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
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
  const url = new URL(event.request.url);

  // Only intercept our own origin. External resources go directly to
  // the network — no chance of caching a CDN response by accident.
  if (url.origin !== self.location.origin) return;

  // Whitelist-only: cache-first ONLY for the explicit shell assets.
  // Everything else (including /health, /api/*, /sw.js, and any
  // future dynamic endpoints) falls through to the browser and hits
  // the network directly.
  if (!SHELL_SET.has(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback: serve index.html for navigation requests
      // that couldn't be answered from cache or network.
      if (event.request.mode === 'navigate') {
        return caches.match('/');
      }
    })
  );
});

// ---- Web Push Notifications ----
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { return; }
  const title = data.title || 'Polpo';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/logo-96.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
