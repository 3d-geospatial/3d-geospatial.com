/* Service worker — modern caching strategies.
   - App shell: precached during install (cache-first afterwards).
   - HTML navigations: network-first with cache fallback (so updates land fast,
     offline still works).
   - Static assets (CSS/JS/IMG/FONT): stale-while-revalidate (fast, refreshes
     in the background).
   - All other GETs: stale-while-revalidate as a sensible default.
*/

const VERSION = "v1.0.1";
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// CSS/JS are intentionally NOT precached here: they ship under stable filenames
// but are referenced with a content-hash query (?v=…), so they're cached fresh
// at runtime (stale-while-revalidate) keyed by the versioned URL. Precaching the
// bare URLs would just pull a copy that the pages never request.
const SHELL_ASSETS = [
  "/",
  "/assets/img/logo.svg",
  "/assets/img/logo-mark.svg",
  "/assets/img/icon-192.png",
  "/assets/img/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  return /\.(?:css|js|mjs|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)$/i.test(url.pathname);
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-resort offline fallback: try cached home
    const home = await caches.match("/");
    if (home) return home;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't intercept cross-origin

  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
