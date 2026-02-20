// Minimal service worker for PWA installability
// Network-first strategy — Companion is a live dashboard, not an offline app

const CACHE_NAME = 'companion-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
