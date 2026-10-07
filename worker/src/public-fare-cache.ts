/** Shared public data only. No vendor keys, passenger details or pending promises. */
export interface PublicFareCache {
  get<T>(key: string): Promise<{ fares: T[]; expires: number } | null>;
  put<T>(key: string, fares: T[]): Promise<void>;
}
const TTL_MS = 10 * 60_000;
const MAX_BYTES = 500_000;
const hosts = new Set(["services-api.ryanair.com", "flights.aegeanair.com", "www.aircanada.com", "www.flytap.com", "www.ethiopianairlines.com", "www.aireuropa.com", "flights.philippineairlines.com", "flights.virginatlantic.com", "www.airnewzealand.com"]);
function cacheRequest(key: string): Request {
  const url = new URL(key);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error("Unsupported public fare source");
  if (url.hostname === "services-api.ryanair.com") {
    if (!/^\/farfnd\/v4\/oneWayFares\/[A-Z]{3}\/[A-Z]{3}\/cheapestPerDay$/.test(url.pathname) || [...url.searchParams.keys()].some((name) => name !== "outboundMonthOfDate" && name !== "currency") || url.searchParams.get("currency") !== "EUR" || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(url.searchParams.get("outboundMonthOfDate") ?? "")) throw new Error("Unsupported public calendar");
  } else if (url.hostname === "www.aircanada.com" && url.pathname === "/en-ca/flights-from-tel-aviv") {
    if (url.search) throw new Error("Unsupported public Air Canada origin page");
  } else if (url.hostname === "www.airnewzealand.com") {
    if (url.search || url.pathname !== "/flights/en-us/flights-from-los-angeles") throw new Error("Unsupported public Air NZ page");
  } else if (url.hostname === "flights.virginatlantic.com") {
    if (url.search || url.pathname !== "/en-il/flights-from-tel-aviv") throw new Error("Unsupported public Virgin page");
  } else if (url.hostname === "flights.philippineairlines.com") {
    if (url.search || url.pathname !== "/en-ph/flights-from-manila-to-bangkok") throw new Error("Unsupported public PAL page");
  } else if (url.hostname === "www.aireuropa.com") {
    if (url.search || url.pathname !== "/en-il/flight-deals-from-tel-aviv-to-spain") throw new Error("Unsupported public country page");
  } else if (url.hostname === "www.ethiopianairlines.com") {
    if (url.search || url.pathname !== "/en-il/") throw new Error("Unsupported public origin page");
  } else if (url.search || !new RegExp(`^/${url.hostname === "www.aircanada.com" ? "en-ca" : url.hostname === "www.flytap.com" ? "en_pt" : "(he|en)"}/flights-from-[a-z-]+-to-[a-z-]+$`).test(url.pathname)) throw new Error("Unsupported public route page");
  // Synthetic internal key is never fetched. The API does not serve this path.
  // Daily Aegean fares were absent from the old parsed cache payload.
  const version = url.hostname === "flights.aegeanair.com" ? "v2" : "v1";
  return new Request(`https://eee-api.liorilay2004.workers.dev/__public_fares/${version}/${encodeURIComponent(key)}`);
}
export function createPublicFareCache(storage: Pick<Cache, "match" | "put">, now: Date): PublicFareCache {
  return {
    async get<T>(key: string): Promise<{ fares: T[]; expires: number } | null> {
      try {
        const response = await storage.match(cacheRequest(key));
        if (!response) return null;
        const text = await response.text();
        if (text.length > MAX_BYTES) return null;
        const data = JSON.parse(text) as { expires?: unknown; fares?: unknown };
        if (typeof data.expires !== "number" || data.expires <= now.getTime() || data.expires > now.getTime() + TTL_MS || !Array.isArray(data.fares) || data.fares.length > 500) return null;
        return { fares: data.fares as T[], expires: data.expires };
      } catch { return null; }
    },
    async put<T>(key: string, fares: T[]): Promise<void> {
      try {
        if (fares.length > 500) return;
        const body = JSON.stringify({ expires: now.getTime() + TTL_MS, fares });
        if (body.length > MAX_BYTES) return;
        await storage.put(cacheRequest(key), new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } }));
      } catch { /* Cache failures never turn a valid source response into a search failure. */ }
    },
  };
}
