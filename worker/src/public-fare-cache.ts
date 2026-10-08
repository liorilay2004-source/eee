import {isSingaporeCacheKey} from "./sources/singapore-fares";
import {aegeanCalendarUrl} from "./aegean-lowfare";
import {EXTERNAL_PUBLISHED_PAGES} from "./external-published-catalog";
import HAWAIIAN_PAGES from "../../collector/hawaiian-observed-pages.json";
import FLYDUBAI_PAGES from "./flydubai-published-catalog.json";
/** Shared public data only. No vendor keys, passenger details or pending promises. */
export interface PublicFareCache {
  get<T>(key: string): Promise<{ fares: T[]; expires: number } | null>;
  put<T>(key: string, fares: T[]): Promise<void>;
}
const TTL_MS = 10 * 60_000;
export const BACKGROUND_FARE_TTL_MS = 36 * 3_600_000;
const MAX_BYTES = 500_000;
const catalogOnlyHosts = new Set(["www.royalairmaroc.com", "flights.china-airlines.com", "www.koreanair.com"]);
const hosts = new Set(["www.royalairmaroc.com", "flights.china-airlines.com", "www.koreanair.com", "flights.evaair.com", "www.vietnamairlines.com", "www.kenya-airways.com", "bestfares.airastana.com", "asha.hawaiianairlines.com", "flights.flyfrontier.com", "www.singaporeair.com", "www.jetblue.com", "services-api.ryanair.com", "flights.aegeanair.com", "www.aircanada.com", "www.flytap.com", "www.ethiopianairlines.com", "www.aireuropa.com", "flights.philippineairlines.com", "flights.virginatlantic.com", "www.airnewzealand.com", "www.airbaltic.com", "www.skyexpress.gr", "www.voegol.com.br", "www.finnair.com", "www.iberia.com", "www.avianca.com", "www.copaair.com", "www.aeromexico.com", "www.klm.co.il", "www.aa.com", "www.aerlingus.com", "www.airserbia.com", "www.norwegian.com", "www.lufthansa.com", "www.swiss.com", "www.austrian.com", "www.brusselsairlines.com", "www.icelandair.com", "www.eurowings.com", "www.turkishairlines.com"]);
export function cacheRequest(key: string): Request {
  const url = new URL(key);
  if(url.hostname==="www.flydubai.com"){
    if(!FLYDUBAI_PAGES.some(p=>p.sourceUrl===key))throw new Error("Unsupported flydubai fare page");
    return new Request(`https://eee-api.liorilay2004.workers.dev/__public_fares/v1/${encodeURIComponent(key)}`);
  }
  if(url.hostname==="en.aegeanair.com") {
    const trip={origin:url.searchParams.get("dep")??"",destination:url.searchParams.get("arr")??"",departDate:url.searchParams.get("datedeparture")??"",returnDate:url.searchParams.get("datereturn")??""};
    if(aegeanCalendarUrl(trip)!==key)throw new Error("Unsupported Aegean selected calendar");
    return new Request(`https://eee-api.liorilay2004.workers.dev/__public_fares/v1/${encodeURIComponent(key)}`);
  }
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error("Unsupported public fare source");
  if(catalogOnlyHosts.has(url.hostname)&&!EXTERNAL_PUBLISHED_PAGES.some(page=>page.sourceUrl===key))throw new Error("Unsupported published fare page");
  if(isSingaporeCacheKey(key))return new Request(`https://eee-api.liorilay2004.workers.dev/__public_fares/v1/${encodeURIComponent(key)}`);
  if(EXTERNAL_PUBLISHED_PAGES.some(page=>page.sourceUrl===key)||HAWAIIAN_PAGES.some(page=>page.url===key))return new Request(`https://eee-api.liorilay2004.workers.dev/__public_fares/${url.hostname==="flights.aegeanair.com"?"v2":"v1"}/${encodeURIComponent(key)}`);
  if (url.hostname === "www.turkishairlines.com") {
    if (url.search || url.pathname !== "/en/flights-from-istanbul-to-athens") throw new Error("Unsupported Turkish public fare page");
  } else if (url.hostname === "www.eurowings.com") {
    const keys = [...url.searchParams.keys()];
    if (url.pathname !== "/en/booking/flights/low-fare-calendar.html" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get("month") ?? "") ||
        !(keys.length === 1 && keys[0] === "month" || keys.length === 2 && keys.includes("month") && keys.includes("destination") && url.searchParams.get("destination") === "ATH")) throw new Error("Unsupported Eurowings calendar cache");
  } else if (url.hostname === "www.lufthansa.com") {
    if (url.search || url.pathname !== "/lhg/gr/en/o-d/cy-cy/athens-tel-aviv") throw new Error("Unsupported public Lufthansa page");
  } else if (url.hostname === "www.austrian.com") {
    if (url.search || url.pathname !== "/lhg/at/en/o-d/cy-cy/vienna-tel-aviv") throw new Error("Unsupported public Austrian page");
  } else if (url.hostname === "www.swiss.com") {
    if (url.search || url.pathname !== "/lhg/ch/en/o-d/cy-cy/zurich-tel-aviv") throw new Error("Unsupported public Swiss page");
  } else if (url.hostname === "www.brusselsairlines.com") {
    if (url.search || url.pathname !== "/lhg/be/en/o-d/cy-cy/brussels-athens") throw new Error("Unsupported public Brussels page");
  } else if (url.hostname === "www.icelandair.com") {
    if(url.search || url.pathname!=="/en-gb/flights/flights-from-london-to-iceland")throw new Error("Unsupported Icelandair fare page");
  } else if (url.hostname === "www.norwegian.com") {
    if (url.pathname !== "/en/low-fare-calendar/Athens-OsloGardermoen" || [...url.searchParams.keys()].length !== 1 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get("month") ?? "")) throw new Error("Unsupported Norwegian calendar cache");
  } else if (url.hostname === "www.airserbia.com") {
    if (!/^\/api\/destination\/flight-prices\/(BEG\/ATH|ATH\/BEG)$/.test(url.pathname) || [...url.searchParams.keys()].length !== 3 || !/^\d{4}$/.test(url.searchParams.get("year") ?? "") || !/^(?:[1-9]|1[0-2])$/.test(url.searchParams.get("month") ?? "") || url.searchParams.get("pos") !== "GLOBAL" || [...url.searchParams.keys()].some(k => !["year", "month", "pos"].includes(k))) throw new Error("Unsupported Air Serbia calendar");
  } else if (url.hostname === "services-api.ryanair.com") {
    if (!/^\/farfnd\/v4\/oneWayFares\/[A-Z]{3}\/[A-Z]{3}\/cheapestPerDay$/.test(url.pathname) || [...url.searchParams.keys()].some((name) => name !== "outboundMonthOfDate" && name !== "currency") || url.searchParams.get("currency") !== "EUR" || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(url.searchParams.get("outboundMonthOfDate") ?? "")) throw new Error("Unsupported public calendar");
  } else if (url.hostname === "www.aircanada.com" && url.pathname === "/en-ca/flights-from-tel-aviv") {
    if (url.search) throw new Error("Unsupported public Air Canada origin page");
  } else if (url.hostname === "www.flytap.com" && url.pathname === "/en_il/flights-from-tel-aviv") {
    if (url.search) throw new Error("Unsupported public TAP origin page");
  } else if (url.hostname === "www.finnair.com") {
    if(url.pathname!=="/en/flights/from/hel/flights-from-Helsinki" || !/^[A-Z]{3}$/.test(url.searchParams.get("destination")??"") || !/^(?:[0-9]|[1-3][0-9])$/.test(url.searchParams.get("part")??"") || [...url.searchParams.keys()].length!==2) throw new Error("Unsupported Finnair cache partition");
  } else if (url.hostname === "www.iberia.com") {
    if(url.search || url.pathname !== "/es/cheap-flights/Madrid-Tel-Aviv/") throw new Error("Unsupported Iberia page");
  } else if (url.hostname === "www.avianca.com") {
    if (url.search || url.pathname !== "/us/en/flights-from-miami-to-cali") throw new Error("Unsupported public Avianca page");
  } else if (url.hostname === "www.copaair.com") {
    if (url.search || url.pathname !== "/en/flights-from-panama-city") throw new Error("Unsupported public Copa page");
  } else if (url.hostname === "www.aeromexico.com") {
    if (url.search || url.pathname !== "/en_us/flights-from-los-angeles") throw new Error("Unsupported public Aeromexico page");
  } else if (url.hostname === "www.klm.co.il") {
    if (url.search || url.pathname !== "/en-il/flights-from-tel-aviv") throw new Error("Unsupported public KLM page");
  } else if (url.hostname === "www.aa.com") {
    if (url.search || url.pathname !== "/en-us/flights-from-los-angeles-to-mexico-city") throw new Error("Unsupported public American page");
  } else if (url.hostname === "www.aerlingus.com") {
    if (url.search || url.pathname !== "/en-ie/flights-from-dublin") throw new Error("Unsupported public Aer Lingus page");
  } else if (url.hostname === "www.voegol.com.br") {
    if (url.search || url.pathname !== "/en/flights-from-sao-paulo") throw new Error("Unsupported public GOL page");
  } else if (url.hostname === "www.skyexpress.gr") {
    if (url.search || url.pathname !== "/en/flights-from-athens") throw new Error("Unsupported public SKY express page");
  } else if (url.hostname === "www.airbaltic.com") {
    if (url.search || !["/en/flight-deals/flights-from-israel", "/en/flight-deals/flights-from-riga-to-tel-aviv"].includes(url.pathname)) throw new Error("Unsupported public airBaltic page");
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

export const publicFareMaximumRows=(key:string)=>isSingaporeCacheKey(key)?1000:500;
export const publicFareMaximumAge = (key: string) => (isSingaporeCacheKey(key)||HAWAIIAN_PAGES.some(page=>page.url===key)||FLYDUBAI_PAGES.some(page=>page.sourceUrl===key)||EXTERNAL_PUBLISHED_PAGES.some(page=>page.sourceUrl===key)) ? TTL_MS : new URL(key).hostname === "www.turkishairlines.com" ? 3600000 : new URL(key).hostname === "en.aegeanair.com" ? TTL_MS : ["services-api.ryanair.com", "www.airserbia.com", "flights.aegeanair.com"].includes(new URL(key).hostname) ? TTL_MS : BACKGROUND_FARE_TTL_MS;
export function createPublicFareCache(storage: Pick<Cache, "match" | "put">, now: Date, ttlMs = TTL_MS): PublicFareCache {
  if (!Number.isFinite(ttlMs) || ttlMs < TTL_MS || ttlMs > BACKGROUND_FARE_TTL_MS) throw new Error("Invalid public cache lifetime");
  return {
    async get<T>(key: string): Promise<{ fares: T[]; expires: number } | null> {
      try {
        const response = await storage.match(cacheRequest(key));
        if (!response) return null;
        const text = await response.text();
        if (text.length > MAX_BYTES) return null;
        const data = JSON.parse(text) as { expires?: unknown; storedAt?: unknown; fares?: unknown };
        const storedAt = typeof data.storedAt === "number" ? data.storedAt : now.getTime();
        const lifetime = data.storedAt === undefined ? TTL_MS : publicFareMaximumAge(key);
        if (!Number.isFinite(storedAt) || storedAt > now.getTime() || typeof data.expires !== "number" || !Number.isFinite(data.expires) || data.expires <= now.getTime() || data.expires > storedAt + lifetime || !Array.isArray(data.fares) || data.fares.length > publicFareMaximumRows(key)) return null;
        return { fares: data.fares as T[], expires: data.expires };
      } catch { return null; }
    },
    async put<T>(key: string, fares: T[]): Promise<void> {
      try {
        if (fares.length > publicFareMaximumRows(key)) return;
        const lifetime = Math.min(ttlMs, publicFareMaximumAge(key));
        // A cache write must not reset the age of an observation captured upstream earlier.
        const captures=fares.flatMap(fare=>{
          if(typeof fare!=="object"||fare===null||!("checkedAt" in fare)||typeof fare.checkedAt!=="string")return [];
          const parsed=Date.parse(fare.checkedAt);
          return Number.isFinite(parsed)&&new Date(parsed).toISOString()===fare.checkedAt&&parsed<=now.getTime()?[parsed]:[];
        });
        const expires=Math.min(now.getTime()+lifetime,...captures.map(capturedAt=>capturedAt+publicFareMaximumAge(key)));
        // A delayed or replayed collection may never extend, or overwrite an older still-valid page with an expired capture.
        if(expires<=now.getTime())return;
        const body = JSON.stringify({ expires, storedAt: now.getTime(), fares });
        if (body.length > MAX_BYTES) return;
        await storage.put(cacheRequest(key), new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${Math.floor(lifetime / 1000)}` } }));
      } catch { /* Cache failures never turn a valid source response into a search failure. */ }
    },
  };
}
