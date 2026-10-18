// Guarda la app en el equipo para que abra sin internet.
// Al publicar cambios, sube el número de CACHE para forzar la actualización.
const CACHE = 'inventario-v2';
const ARCHIVOS = ['./', './index.html', './app.js', './excel.js', './config.js', './styles.css', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Las llamadas al servidor (Apps Script) nunca pasan por la caché
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const enCache = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    const red = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    if (enCache) { e.waitUntil(red); return enCache; }
    return (await red) || new Response('Sin conexión', { status: 503 });
  }));
});
