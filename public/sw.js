'use strict';
/*
 * Service worker: cache aplikacji i danych, żeby działała też bez internetu.
 * Nie cache'ujemy kafelków mapy ani zapytań do usług trasujących (inne originy).
 */
const VERSION = 'v1';
const CACHE = `odkrywca-${VERSION}`;
const BASE = new URL('./', self.location).href;
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './route.js',
  './state.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/qrcode.js',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './data/parks.json',
  './data/matrix.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
].map((path) => new URL(path, BASE).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('odkrywca-')).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(new URL('./index.html', BASE).href)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
