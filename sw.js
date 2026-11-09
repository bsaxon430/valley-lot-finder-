// Minimal app-shell cache. Live data (tiles, photos, shared marks) is always fetched from the network.
const CACHE = 'vlf-shell-v57';
const SHELL = ['./', './index.html', './styles.css?v=57', './app.js?v=57', './config.js?v=57', './lots.json', './manifest.webmanifest', './icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never cache remote data
  e.respondWith(fetch(e.request, { cache:'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
