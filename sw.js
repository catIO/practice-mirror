const CACHE_NAME = 'v20260425190919';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/vendor/ffmpeg.js',
  '/vendor/ffmpeg-core.wasm',
  '/vendor/umd/ffmpeg-core.js',
  '/vendor/814.ffmpeg.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request).catch((err) => {
        console.warn('SW fetch failed for:', e.request.url, err);
        return new Response('Network error occurred', { status: 408, headers: { 'Content-Type': 'text/plain' } });
      });
    })
  );
});
