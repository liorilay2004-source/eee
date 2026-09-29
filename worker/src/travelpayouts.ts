/**
 * Travelpayouts / Aviasales Data API client (SPEC §6: the core engine), a port of
 * engine/tpe/sources/travelpayouts.py. Uses `prices_for_dates` with whole months so one call returns
 * many date pairs. Prices are for ONE adult; the pipeline scales by passenger count.
 *
 * The token travels ONLY in the X-Access-Token header. It never appears in a URL, a log line or an
 * error message (every message is scrubbed of it), so it cannot leak through logs or API responses.
 */

import { vendorTimestamp } from "./freshness";
import type { Leg, Offer, OneWayFare, TravelpayoutsClient } from "./types";

export const API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";
export const AVIASALES = "https://www.aviasales.com";
const REQUEST_CURRENCY = "usd";
const TIMEOUT_MS = 15_000;
/** Rows per request (the API's maximum): a page this full may have been cut off. */
const PAGE_LIMIT = 1000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Travelpayouts `market` by origin country (SPEC §7 step 3), same table as engine/tpe/config.py. */
export const MARKET_BY_COUNTRY: Readonly<Record<string, string>> = {
  IL: "il",
  US: "us",
  GB: "uk",
  DE: "de",
  FR: "fr",
  ES: "es",
  IT: "it",
};

/** Market for an ISO country code; unknown -> null (the param is then omitted). */
export function marketForCountry(countryCode: string | null | undefined): string | null {
  return (countryCode && MARKET_BY_COUNTRY[countryCode.toUpperCase()]) || null;
}

export class TravelpayoutsError extends Error {
  /** HTTP status when the failure came from a response, else null. */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TravelpayoutsError";
    this.status = status;
  }
}

// ---- links -------------------------------------------------------------------------

/** Python's urlencode/quote_plus for one value: space -> "+", only `_.-~` and alphanumerics stay bare. */
function formEncode(v: string): string {
  return encodeURIComponent(v)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

/**
 * Absolute booking URL for a row's `link` (relative to aviasales.com) with the affiliate marker appended.
 * Only http(s) absolutes pass through; anything else is treated as a path on aviasales.com, so a hostile
 * `link` cannot produce a non-web scheme.
 */
export function affiliateLink(pathOrUrl: string | null, marker?: string): string | null {
  if (!pathOrUrl) return null;
  let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : AVIASALES + (pathOrUrl.startsWith("/") ? "" : "/") + pathOrUrl;
  const m = marker?.trim();
  if (m) url += (url.includes("?") ? "&" : "?") + "marker=" + formEncode(m);
  return url;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const IATA = /^[A-Za-z0-9]{3}$/;

/** Validated calendar date parts from the first 10 chars of an ISO string, or null. */
function dateParts(iso: string): { y: number; m: number; d: number } | null {
  const g = ISO_DATE.exec(iso);
  if (!g) return null;
  const y = Number(g[1]);
  const m = Number(g[2]);
  const d = Number(g[3]);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return { y, m, d };
}

/** Party as the search form has it; `children` and `infants` default to 0. */
export interface Party {
  adults: number;
  children?: number;
  infants?: number;
}

const isCount = (n: unknown, min: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= 9;

/**
 * Aviasales passenger code that ends a search path: adults, then children, then infants, trailing zeros dropped
 * ("1" = one adult, "21" = 2 adults + 1 child, "211" = plus an infant, "201" = 2 adults + 1 infant).
 * Inferred from the single-adult links the API returns; not verified against the live service for larger parties.
 */
export function partyCode(party: Party): string {
  const { adults, children = 0, infants = 0 } = party;
  if (!isCount(adults, 1) || !isCount(children, 0) || !isCount(infants, 0)) {
    throw new RangeError("partyCode: adults must be 1-9, children and infants 0-9");
  }
  return `${adults}${children > 0 || infants > 0 ? children : ""}${infants > 0 ? infants : ""}`;
}

/**
 * Aviasales search deep link, e.g. /search/TLV1211BCN18111 (origin, DDMM, dest, [DDMM], pax).
 * Used for offers from other sources and as the fallback when a Travelpayouts row has no link, so every card
 * carries an affiliate link. `pax` is a number of adults or a full party.
 */
export function aviasalesSearchLink(
  origin: string,
  dest: string,
  departDate: string,
  returnDate: string | null,
  pax: number | Party,
  marker?: string,
): string {
  const dep = dateParts(departDate);
  const ret = returnDate ? dateParts(returnDate) : null;
  if (!dep || (returnDate && !ret)) throw new RangeError("aviasalesSearchLink: dates must be YYYY-MM-DD");
  if (!IATA.test(origin) || !IATA.test(dest)) throw new RangeError("aviasalesSearchLink: origin/dest must be IATA codes");
  if (typeof pax === "number" && (!Number.isInteger(pax) || pax < 1)) throw new RangeError("aviasalesSearchLink: pax must be an integer >= 1");
  const code = typeof pax === "number" ? String(pax) : partyCode(pax);
  const ddmm = (p: { m: number; d: number }) => String(p.d).padStart(2, "0") + String(p.m).padStart(2, "0");
  const path = `/search/${origin.toUpperCase()}${ddmm(dep)}${dest.toUpperCase()}${ret ? ddmm(ret) : ""}${code}`;
  return affiliateLink(path, marker) as string;
}

/** `https://www.aviasales.com/search/<origin><DDMM><dest><digits>` followed by the query string, if any. */
const SEARCH_LINK = /^(https:\/\/www\.aviasales\.com\/search\/[A-Za-z0-9]{3}\d{4}[A-Za-z0-9]{3})(\d+)(?=[?#]|$)/;

/**
 * Rewrites the passenger code of an Aviasales search link to the whole party. The API's links are always for one
 * adult, while the card's price is for everybody; the rest of the link (the `t=` ticket id, the marker) is kept.
 * Anything that is not a recognisable Aviasales search link comes back unchanged.
 */
export function withPartySize(link: string | null, party: Party): string | null {
  if (!link) return link;
  const m = SEARCH_LINK.exec(link);
  if (!m) return link;
  // After the destination: a one-way has just the passenger code (1-3 digits), a round trip has DDMM + code (5-7).
  const digits = m[2] as string;
  const dateLen = digits.length >= 5 && digits.length <= 7 ? 4 : digits.length <= 3 ? 0 : -1;
  if (dateLen < 0) return link;
  return m[1] + digits.slice(0, dateLen) + partyCode(party) + link.slice(m[0].length);
}

/** "YYYY-MM" for every month from start's to end's, inclusive; empty when start is after end. */
export function monthsBetween(startIso: string, endIso: string): string[] {
  const s = dateParts(startIso);
  const e = dateParts(endIso);
  if (!s || !e) throw new RangeError("monthsBetween: dates must be YYYY-MM-DD");
  const out: string[] = [];
  let y = s.y;
  let m = s.m;
  while (y < e.y || (y === e.y && m <= e.m)) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
  }
  return out;
}

// ---- defensive row parsing -----------------------------------------------------------

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number > 0 (numeric strings tolerated, like Python's float()), else null. */
function positive(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Stop counts are whole numbers >= 0; anything else is unknown (never guessed). */
function stopCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Local wall-clock "HH:MM" = chars 11-16 of the ISO string. No time-zone conversion: the offset is the airport's. */
function hhmm(iso: unknown): string | null {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d/.test(iso)) return null;
  return iso.slice(11, 16);
}

/** Local calendar date (first 10 chars) if the string starts with a real date. */
function dateOf(iso: unknown): string | null {
  return typeof iso === "string" && dateParts(iso) ? iso.slice(0, 10) : null;
}

function airlinesOf(row: Row): string[] {
  return typeof row.airline === "string" && row.airline.trim() ? [row.airline.trim()] : [];
}

function leg(departAt: unknown, stops: unknown, durationMin: number | null, airlines: string[]): Leg {
  return { departTime: hhmm(departAt), arriveTime: null, stops: stopCount(stops), durationMin, airlines };
}

/**
 * Source-stated fare timestamps. The v3 endpoint does not send them today; v2 endpoints do (`found_at`, `expires_at`).
 * Only set when present and valid, so rows without them look exactly as before. A `found_at` after our own fetch is not believed.
 */
function fareTimes(row: Row, fetchedAtMs: number): { fareFoundAt?: string; fareExpiresAt?: string } {
  const found = vendorTimestamp(row.found_at, fetchedAtMs);
  const expires = vendorTimestamp(row.expires_at);
  return { ...(found ? { fareFoundAt: found } : {}), ...(expires ? { fareExpiresAt: expires } : {}) };
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

// ---- client ------------------------------------------------------------------------------

export function createTravelpayoutsClient(opts: {
  token?: string;
  marker?: string;
  fetchFn?: typeof fetch;
  marketFor?: (origin: string) => string | null;
}): TravelpayoutsClient {
  // A stray newline in a pasted secret would make the header invalid (and the failure would echo it).
  const token = (opts.token ?? "").trim();
  const marker = (opts.marker ?? "").trim();
  // Wrapped, not stored bare: workerd throws "Illegal invocation" if fetch loses its global receiver.
  const doFetch: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
  let calls = 0;

  const redact = (s: string): string => (token ? s.split(token).join("[redacted]") : s);
  const snippet = (s: string): string => redact(s).replace(/\s+/g, " ").trim().slice(0, 200);

  function requireConfigured(): void {
    if (!token) throw new TravelpayoutsError("TRAVELPAYOUTS_TOKEN is not set");
  }

  /** Bad windows are caller bugs, but they surface as the source's own error type so the pipeline handles one kind. */
  function months(windowStart: string, windowEnd: string): string[] {
    try {
      return monthsBetween(windowStart, windowEnd);
    } catch {
      throw new TravelpayoutsError("window dates must be YYYY-MM-DD");
    }
  }

  function base(origin: string, dest: string): URLSearchParams {
    if (!IATA.test(origin) || !IATA.test(dest)) throw new TravelpayoutsError("origin/destination must be IATA codes");
    const p = new URLSearchParams({
      origin: origin.toUpperCase(),
      destination: dest.toUpperCase(),
      currency: REQUEST_CURRENCY,
      sorting: "price",
      direct: "false",
      unique: "false",
      limit: String(PAGE_LIMIT),
      page: "1",
    });
    let market: string | null = null;
    try {
      market = opts.marketFor?.(origin.toUpperCase()) ?? null;
    } catch {
      // The market only biases which cached fares come back; a lookup bug must not fail the search.
    }
    if (market && /^[A-Za-z]{2,3}$/.test(market)) p.set("market", market.toLowerCase());
    return p;
  }

  /** One HTTP call -> rows tagged with the response currency. Throws TravelpayoutsError on any failure. */
  async function get(params: URLSearchParams): Promise<{ rows: Row[]; currency: string }> {
    requireConfigured();
    calls += 1; // counted when the request is issued, so failed/timed-out attempts still show in callCount()
    let status: number;
    let text: string;
    try {
      const res = await doFetch(`${API}?${params.toString()}`, {
        method: "GET",
        headers: { "X-Access-Token": token, Accept: "application/json" },
        // Custom headers survive cross-origin redirects, so never follow one with the token attached.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError") throw new TravelpayoutsError(`request timed out after ${TIMEOUT_MS}ms`);
      if (name === "AbortError") throw new TravelpayoutsError("request aborted");
      throw new TravelpayoutsError(`network error: ${snippet(err instanceof Error ? err.message : String(err))}`);
    }
    if (status !== 200) throw new TravelpayoutsError(`HTTP ${status}: ${snippet(text)}`, status);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TravelpayoutsError(`invalid JSON in response: ${snippet(text)}`, status);
    }
    if (!isRow(body)) throw new TravelpayoutsError(`unexpected response: ${snippet(text)}`, status);
    if (!body.success) throw new TravelpayoutsError(`API error: ${snippet(text)}`, status);
    const data = body.data ?? [];
    if (!Array.isArray(data)) throw new TravelpayoutsError(`unexpected response: ${snippet(text)}`, status);
    return { rows: data.filter(isRow), currency: str(body.currency, REQUEST_CURRENCY).toUpperCase() };
  }

  /** A row without a usable `link` still gets a search link (one adult, like the API's own), never a dead card. */
  function fallbackLink(from: string, to: string, depart: string, ret: string | null): string | null {
    try {
      return aviasalesSearchLink(from, to, depart, ret, 1, marker);
    } catch {
      return null; // odd airport codes in the row: no link beats a wrong one
    }
  }

  function rowToRoundTrip(row: Row, currency: string, origin: string, dest: string, checkedAt: string): Offer | null {
    const price = positive(row.price);
    const departDate = dateOf(row.departure_at);
    const returnDate = dateOf(row.return_at);
    if (price === null || !departDate || !returnDate || returnDate < departDate) return null;
    const airlines = airlinesOf(row);
    const from = str(row.origin_airport, origin);
    const to = str(row.destination_airport, dest);
    return {
      origin: from,
      destination: to,
      departDate,
      returnDate,
      priceAmount: price,
      priceCurrency: currency,
      source: "travelpayouts",
      ticketStructure: "roundtrip",
      outbound: leg(row.departure_at, row.transfers, positive(row.duration_to), airlines),
      inbound: leg(row.return_at, row.return_transfers, positive(row.duration_back), [...airlines]),
      includes: {},
      deeplink: affiliateLink(typeof row.link === "string" ? row.link : null, marker) ?? fallbackLink(from, to, departDate, returnDate),
      verifyLink: null,
      checkedAt,
      ...fareTimes(row, Date.parse(checkedAt)),
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
    };
  }

  function rowToOneWay(row: Row, currency: string, origin: string, dest: string): OneWayFare | null {
    const price = positive(row.price);
    const date = dateOf(row.departure_at);
    if (price === null || !date) return null;
    const { fareFoundAt, fareExpiresAt } = fareTimes(row, Date.now());
    return {
      ...(fareFoundAt ? { foundAt: fareFoundAt } : {}),
      ...(fareExpiresAt ? { expiresAt: fareExpiresAt } : {}),
      date,
      priceAmount: price,
      priceCurrency: currency,
      // `duration` is the total trip time; for a one-way it equals duration_to, so it is a valid fallback.
      leg: leg(row.departure_at, row.transfers, positive(row.duration_to) ?? positive(row.duration), airlinesOf(row)),
      deeplink:
        affiliateLink(typeof row.link === "string" ? row.link : null, marker) ??
        fallbackLink(str(row.origin_airport, origin), str(row.destination_airport, dest), date, null),
    };
  }

  return {
    get configured() {
      return token !== "";
    },

    callCount: () => calls,

    /**
     * SPEC §7 step 3. One call per (departure month, return month >= departure month): a month-granular
     * `departure_at`/`return_at` returns many date pairs. Calls run one at a time (like the Python engine) to
     * stay gentle on the API's rate limit, and any failed call fails the whole scan.
     */
    async roundTrips(origin, destination, windowStart, windowEnd) {
      requireConfigured();
      const depMonths = months(windowStart, windowEnd);
      const checkedAt = new Date().toISOString();
      const offers: Offer[] = [];
      // Month pairs can return the same fare more than once. The key is finer than dates+price+airline
      // (adds airports and both departure times) so two different flights on one day are never merged.
      const seen = new Set<string>();
      for (const dm of depMonths) {
        for (const rm of depMonths) {
          if (rm < dm) continue; // "YYYY-MM" sorts chronologically
          const params = base(origin, destination);
          params.set("departure_at", dm);
          params.set("return_at", rm);
          params.set("one_way", "false");
          const { rows, currency } = await get(params);
          for (const row of rows) {
            const o = rowToRoundTrip(row, currency, origin, destination, checkedAt);
            if (!o) continue;
            const key = [o.origin, o.destination, o.departDate, o.returnDate, o.outbound.departTime, o.inbound.departTime, o.priceAmount, o.priceCurrency, o.outbound.airlines[0] ?? ""].join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            offers.push(o);
          }
        }
      }
      return offers;
    },

    /**
     * ADDITIVE (calendar, src/calendar.ts): ONE call for one (departure month, return month) pair, "YYYY-MM" each.
     * Same request and parsing as roundTrips; `truncated` is true when the page came back full (limit 1000), so the
     * caller can say the month may be incomplete. Throws TravelpayoutsError like every other call (no retries).
     */
    async monthRoundTrips(origin, destination, departMonth, returnMonth) {
      requireConfigured();
      if (!MONTH.test(departMonth) || !MONTH.test(returnMonth) || returnMonth < departMonth) {
        throw new TravelpayoutsError("months must be YYYY-MM, the return month not before the departure month");
      }
      const params = base(origin, destination);
      params.set("departure_at", departMonth);
      params.set("return_at", returnMonth);
      params.set("one_way", "false");
      const checkedAt = new Date().toISOString();
      const { rows, currency } = await get(params);
      const offers: Offer[] = [];
      for (const row of rows) {
        const o = rowToRoundTrip(row, currency, origin, destination, checkedAt);
        if (o) offers.push(o);
      }
      return { offers, truncated: rows.length >= PAGE_LIMIT };
    },

    /** One-way fares (per adult) for the split-ticket check: one call per departure month. */
    async oneWays(origin, destination, windowStart, windowEnd) {
      requireConfigured();
      const out: OneWayFare[] = [];
      const seen = new Set<string>();
      for (const dm of months(windowStart, windowEnd)) {
        const params = base(origin, destination);
        params.set("departure_at", dm);
        params.set("one_way", "true");
        const { rows, currency } = await get(params);
        for (const row of rows) {
          const f = rowToOneWay(row, currency, origin, destination);
          if (!f) continue;
          const key = [f.date, f.leg.departTime, f.priceAmount, f.priceCurrency, f.leg.airlines[0] ?? ""].join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(f);
        }
      }
      return out;
    },
  };
}
