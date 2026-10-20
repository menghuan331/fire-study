const CACHE_VERSION = "study-v2";

const PRECACHE = [
  "./",
  "./index.html",
  "./data/map.json",
  "./data/schedule.json",
  "./data/cards.json",
  "./data/questions.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

function relativePath(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  const path = url.pathname;
  if (!path.startsWith(scopePath)) return path.replace(/^\//, "");
  return path.slice(scopePath.length);
}

function isTracked(url) {
  if (url.origin !== self.location.origin) return false;
  const rel = relativePath(url);
  return rel === ""
    || rel === "index.html"
    || rel.startsWith("data/")
    || rel === "manifest.webmanifest"
    || rel.startsWith("icons/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }
  if (url.hostname === "api.github.com") return;
  if (!isTracked(url)) return;

  const cachePromise = caches.open(CACHE_VERSION);
  const networkPromise = fetch(request).then(async (response) => {
    if (response && response.ok) {
      const cache = await cachePromise;
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  event.waitUntil(networkPromise.then(() => {}));
  event.respondWith((async () => {
    const cache = await cachePromise;
    const cached = await cache.match(request);
    if (cached) return cached;
    const fresh = await networkPromise;
    if (fresh) return fresh;
    return new Response("离线且没有缓存", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  })());
});
