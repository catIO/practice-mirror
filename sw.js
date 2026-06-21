const CACHE_NAME = '__CACHE_VERSION__';
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
  // Only handle GET requests to avoid issues with POST/PUT uploads
  if (e.request.method !== 'GET') {
    return;
  }

  const url = new URL(e.request.url);
  const isWasmOrCore = url.pathname.includes('ffmpeg-core') || url.pathname.endsWith('.wasm');

  if (isWasmOrCore) {
    // Cache-First for very large WebAssembly/core files to load instantly and save bandwidth
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(e.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, cacheCopy));
          }
          return networkResponse;
        });
      })
    );
  } else {
    // Network-First for HTML, JS, CSS, and other assets to ensure quick updates
    e.respondWith(
      fetch(e.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, cacheCopy));
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback to cache if network is unavailable
          return caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            return new Response('Network error occurred', { status: 408, headers: { 'Content-Type': 'text/plain' } });
          });
        })
    );
  }
});
