const CACHE_NAME = "eee-shell-v1";
const SHELL = ["/", "/offline.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    const html = await cache.match("/");
    const markup = html ? await html.text() : "";
    const assets = [...markup.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    if (assets.length) await cache.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("eee-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API responses, especially prices, are network-only.

  if (request.mode === "navigate") {
    const known = ["/", "/privacy", "/terms", "/affiliate", "/accessibility"].includes(url.pathname);
    if (known) {
      event.respondWith((async () => (await caches.match("/")) || (await fetch(request).catch(() => caches.match("/offline.html"))))());
    } else {
      event.respondWith((async () => (await fetch(request).catch(() => caches.match("/offline.html"))))());
    }
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
