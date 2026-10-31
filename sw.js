// Офлайн-кеш: застосунок і модель працюють без інтернету після першого відкриття.
const CACHE = 'beardguide-v1';
const CORE = ['./', 'index.html', 'styles.css', 'app.js', 'face.js', 'manifest.webmanifest', 'icon.svg',
  'vendor/vision_bundle.mjs', 'vendor/face_landmarker.task'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Модель і wasm великі й незмінні — з кешу. Код застосунку — спочатку з мережі,
// щоб оновлення доходили одразу, а без інтернету — з кешу.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const put = (res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  };
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(put)));
  } else {
    e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
