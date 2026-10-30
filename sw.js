// Offline support: the app itself works with no signal (rural roads!). Map tiles
// and drive-time lookups still need a connection; tiles you've seen are cached.
const VERSION = 'v1';
const APP = `app-${VERSION}`;
const TILES = 'tiles';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/geo.js', 'js/tracker.js', 'js/ui.js', 'js/optimizer.js',
  'js/matrix.js', 'js/analysis.js', 'js/importer.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }).catch(() => new Response('', { status: 504 })));
    return;
  }

  if (url.origin === location.origin) {
    // Network first so updates show up, cache fallback for no signal.
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(APP).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
