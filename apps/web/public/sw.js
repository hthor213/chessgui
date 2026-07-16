// Offline app shell (spec 223). Scope: cache the shell + hashed static
// assets so airplane-mode open shows the app instead of a browser error.
// Deliberately NOT cached: the arena API (personas run server-side, the
// arena DB is canonical — spec 217) and the WASM engine assets (tens of MB;
// iOS PWA storage is evictable, so caching them buys little and costs a
// lot). Play stays online-only by design; the offline feature that matters
// is a clean resume after reconnect, which the server already provides.
//
// Update model: navigations are network-first (fresh HTML wins whenever the
// server is reachable), _next/static chunks are cache-first (content-hashed
// filenames never change meaning), so there is no manual cache-version chore
// per deploy. Bump CACHE only if the caching STRATEGY changes shape.

const CACHE = "chessgui-shell-v1"

// The deploy prefix (/chess behind Caddy, also /chess under `next dev` —
// basePath applies in dev). Derived from the registration scope so this file
// never hardcodes the Caddy layout.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, "")

// The two prerendered entries of the static export (next.config.mjs
// `output: 'export'`): the board app and the arena.
const SHELL = [`${BASE}/`, `${BASE}/arena`]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Arena API: never cached, never intercepted — a stale game state is
  // worse than an honest network error (the game screen has its own retry).
  if (url.pathname.startsWith(`${BASE}/api/`)) return

  // WASM engine assets: pass through (see header comment).
  if (url.pathname.startsWith(`${BASE}/engine/`)) return

  // Navigations: network-first with cache fallback, so the app opens
  // offline. An uncached deep link falls back to the arena shell (the
  // mobile front door, spec 223) rather than erroring.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy))
          return res
        })
        .catch(async () => {
          const cached = await caches.match(req)
          return cached ?? (await caches.match(`${BASE}/arena`)) ?? caches.match(`${BASE}/`)
        }),
    )
    return
  }

  // Static assets (hashed chunks, icons, manifest, board sprites):
  // cache-first, filling the cache from the network on first sight.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy))
          }
          return res
        }),
    ),
  )
})
