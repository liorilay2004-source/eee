// The BUILD_ID placeholder below is replaced at build time (see stampServiceWorker in vite.config.ts), so every deploy gets a new
// cache name, a byte-different sw.js, and therefore a real service-worker update.
const BUILD_ID = "__BUILD_ID__";
const CACHE_PREFIX = "eee-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const SHELL = ["/", "/offline.html", "/offline.css", "/manifest.webmanifest", "/icon.svg"];
const APP_ROUTES = ["/", "/privacy", "/terms", "/affiliate", "/accessibility"];

/**
 * A copy of a response without the "redirected" flag. Cloudflare Pages answers /offline.html with a 308 to /offline;
 * browsers refuse a redirected response for a navigation (redirect mode "manual"), so cached copies are stored clean.
 */
async function clean(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Bypass the HTTP cache so a new build never precaches the previous shell.
    await Promise.all(SHELL.map(async (url) => {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error(`precache failed: ${url} ${response.status}`);
      await cache.put(url, await clean(response));
    }));
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
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API responses, especially prices, are network-only.

  if (request.mode === "navigate") {
    // Network first: a deploy is visible on the next load. Offline: the cached shell, then the offline page.
    event.respondWith((async () => {
      const known = APP_ROUTES.includes(url.pathname.replace(/\/+$/, "") || "/");
      try {
        const response = await fetch(request);
        if (known && response.ok && url.pathname === "/") {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", await clean(response.clone()));
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        if (known) {
          const shell = await cache.match("/");
          if (shell) return clean(shell);
        }
        const offline = await cache.match("/offline.html");
        return offline ? clean(offline) : Response.error();
      }
    })());
    return;
  }

  if (SHELL.includes(url.pathname) && url.pathname !== "/") {
    // Small static files (offline page styles, icon, manifest): network first, cached copy offline.
    event.respondWith(fetch(request).catch(async () => (await caches.match(url.pathname)) || Response.error()));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Hashed file names: cache first is safe.
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
