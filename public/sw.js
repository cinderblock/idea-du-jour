// idea-du-jour service worker — conservative, capture-first.
// Network-first for navigations (fresh triage data), with a cached shell as the
// offline fallback. Cache-first for static assets. Never caches /api or the
// server-function transport (/_serverFn) — those must always hit the network.

const CACHE = 'idj-v2'
// Don't precache '/' — it redirects to /login when unauthenticated, and a
// redirected response can't be cached. It's populated opportunistically below.
const SHELL = ['/icon-192.png', '/icon-512.png', '/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/_serverFn')) return

  // Navigations: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a real, non-redirected 200 for the app shell.
          if (res.ok && !res.redirected) {
            caches.open(CACHE).then((c) => c.put('/', res.clone())).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match('/').then((r) => r || caches.match(req))),
    )
    return
  }

  // Static assets: cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {})
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
