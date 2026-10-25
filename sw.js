const CACHE_VERSION = "study-v13";
const NETWORK_TIMEOUT_MS = 3000;

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
  "./icons/apple-touch-icon.png",
  "./modules/qa/index.js",
  "./modules/qa/state.js",
  "./modules/qa/client.js",
  "./modules/qa/panel.js",
  "./modules/qa/errors.js",
  "./modules/qa/panel.css"
];

function relativePath(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  let path = url.pathname;
  if (path.startsWith(scopePath)) path = path.slice(scopePath.length);
  else path = path.replace(/^\//, "");
  try {
    path = decodeURIComponent(path);
  } catch (_) {}
  return path;
}

function isIconOrManifest(rel) {
  return rel === "manifest.webmanifest" || rel.startsWith("icons/");
}

function isLectureFile(rel) {
  if (!rel.startsWith("精讲/")) return false;
  return rel.endsWith(".html") || rel.endsWith(".json") || rel.endsWith(".mp3");
}

function isNetworkFirstPath(rel) {
  return rel === ""
    || rel === "index.html"
    || (rel.startsWith("data/") && rel.endsWith(".json"))
    || (rel.startsWith("modules/qa/") && /\.(js|css)$/.test(rel))
    || rel === "精讲/index.json"
    || isLectureFile(rel);
}

function shouldHandle(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (request.mode === "navigate") return true;
  const rel = relativePath(url);
  return isNetworkFirstPath(rel) || isIconOrManifest(rel);
}

function offlineResponse() {
  return new Response("离线且没有缓存", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function fetchNetwork(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  const input = request.mode === "navigate" ? request.url : request;
  return fetch(input, { cache: "no-store", signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function readCache(request) {
  const cache = await caches.open(CACHE_VERSION);
  return (await cache.match(request)) || (await cache.match(request.url));
}

async function writeCache(request, response) {
  if (!response || response.status !== 200) return;
  try {
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(request.url, response.clone());
  } catch (_) {}
}

async function networkFirst(request) {
  try {
    const response = await fetchNetwork(request);
    if (response && response.status === 200) {
      await writeCache(request, response);
      return response;
    }
  } catch (_) {}
  const cached = await readCache(request);
  if (cached) return cached;
  return offlineResponse();
}

function cacheFirst(event, request) {
  const update = fetch(request).then(async (response) => {
    if (response && response.status === 200) await writeCache(request, response);
    return response;
  }).catch(() => null);
  event.waitUntil(update.then(() => {}));
  return readCache(request).then(async (cached) => {
    if (cached) return cached;
    const fresh = await update;
    if (fresh) return fresh;
    return offlineResponse();
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = new Set([CACHE_VERSION, "study-chunks-v1"]);
    const oldKeys = keys.filter((key) => !keep.has(key));
    await Promise.all(oldKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
    // v2 页面没有 controllerchange 监听。不能 await navigate：activate 未结束时
    // 导航请求会排队，和 waitUntil 互相等待。
    if (!oldKeys.includes("study-v2")) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const client of windows) {
      if (!client.url || typeof client.navigate !== "function") continue;
      client.navigate(client.url).catch(() => {});
    }
  })());
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
  if (!shouldHandle(request, url)) return;

  const rel = relativePath(url);
  if (request.headers.get("range") && isLectureFile(rel)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" || isNetworkFirstPath(rel)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isIconOrManifest(rel)) {
    event.respondWith(cacheFirst(event, request));
  }
});
