// 공부캠 service worker: keeps the app, AI files and fonts so it opens without internet.
const VERSION = 'studycam-v2';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/ai.js',
  './lib/mp4-muxer.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
// Big files that never change at the same path: keep the saved copy, don't download again.
const STATIC = /\/(lib|models|icons)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Carry the big AI files over from older versions instead of downloading them again.
    const keys = await caches.keys();
    const cur = await caches.open(VERSION);
    for (const k of keys) {
      if (k === VERSION) continue;
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        if (STATIC.test(new URL(req.url).pathname) && !(await cur.match(req))) {
          const res = await old.match(req);
          if (res) await cur.put(req, res);
        }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function save(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(VERSION).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return;

  if (req.mode === 'navigate') {
    // Newest page when online, saved copy when offline.
    event.respondWith(
      fetch(req)
        .then((res) => { save('./index.html', res.clone()); return res; })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  if (fonts || STATIC.test(url.pathname)) {
    // Saved copy first; download only if missing.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => save(req, res))));
    return;
  }

  // App code: newest when online (so page and code always match), saved copy when offline.
  event.respondWith(
    fetch(req)
      .then((res) => save(req, res))
      .catch(() => caches.match(req))
  );
});
