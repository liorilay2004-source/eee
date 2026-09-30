/**
 * Wego Affiliate (Marketplace) API, flights metasearch: an OPTIONAL LIVE fare source (contracts and shared rules in
 * ../quotes.ts). Written from the vendor's documentation (developers.wego.com/docs/affiliate/...), NOT verified against
 * the live service: every field is read defensively and left null when it is missing, never guessed.
 *
 * Why this file talks to the vendor itself instead of being a quotes.ts QuoteAdapter: a Wego quote is several requests
 * (OAuth token, search creation, a few result polls) and its answer carries its own booking link (fare.handoffUrl, the
 * only link the vendor's terms allow to show), which the one-request adapter contract cannot express. So the rules
 * createQuoteSource enforces are kept here, in this one place:
 *  - one unit of the quota (table source_quota, repo.reserveQuota) is reserved BEFORE the first request of a quote; no
 *    unit, or a counter that cannot be read or written, means no request at all (fail closed). No refund, no retry;
 *  - every request has an AbortSignal.timeout, the whole quote has a deadline, redirects are never followed;
 *  - the client id travels only in the token request BODY and the token only in an Authorization header: neither is in
 *    a URL, a log line or an error (errors are a bare code, like QuoteError everywhere else).
 * Prices follow the pipeline convention: ONE adult, the vendor's ORIGINAL currency, RAW (no extras, no ILS).
 *
 * PARTY CHECK (src/partycheck.ts, partySeries below): the search takes `adultsCount` ("Must be a number greater than or equal
 * to 1 and smaller than or equal to 10"), and the Price object is documented field by field: `totalAmount` "total amount in
 * currency Code", `amount` "average amount for all passengers, inludes payment fee (if there's any)", `originalAmount`
 * "average amount without the payment fee", `amountPerAdult` "amount per adult passenger"
 * (https://developers.wego.com/docs/affiliate/references/flight-objects/, sections Search and Price; read on 2026-09-30).
 * The page does NOT say which passengers totalAmount covers: that it is the whole group's total is our INFERENCE from "total
 * amount" beside "average amount for all passengers", not a documented fact (the guide's only example is for one adult). So
 * partyPricing is "total" only together with a check on EVERY fare of a multi-adult answer: the fare must state at least one
 * per-passenger figure (amount, originalAmount, amountPerAdult) and each one it states, times the adults, must match the
 * total, or the fare is not read at all (partyTotalAgrees). Flight identity: the guide's example segments carry
 * `designatorCode` ("BA6177") and the legs `departureDateTime` (https://developers.wego.com/docs/affiliate/guides/flights/);
 * read only when present, never guessed.
 * With today's cap (30, one-off) the daily share is 1 request, so a 2-search check never fits: the party check does not pick
 * this source until the cap is raised (partycheck.ts, partyChecksPerDay). Raising it to 91 or more (with an allowance to
 * match) WOULD turn the live check on: see docs/CLOUDFLARE_SETUP.md.
 */
import {
  answerUsable,
  MAX_QUOTE_OFFERS_PER_CALL,
  QUOTE_TIMEOUT_MS,
  QuoteError,
  quotaPeriodKey,
  quotaSpecIsSafe,
  reserveUnits,
  vendorAdults,
  type FareQuoteSource,
  type PartyFare,
  type QuotaSpec,
  type QuoteQuery,
} from "../quotes";
import type { Leg, Offer, Repo } from "../types";

// --- quota -----------------------------------------------------------------------------------------------

/**
 * Wego documents NO request-count free allowance and has no self-serve free plan, so this is deliberately a small
 * LIFETIME cap (a one-off allowance, or one of unknown nature, never renews). Sources of the numbers:
 *  - developers.wego.com/docs/affiliate/get-started: "The default limit is 500 calls per hour for a regular key (can be
 *    increased by request if you maintain Search to Click ratio 5%) and 50 calls per hour for a test key." An HOURLY
 *    RATE limit on search creation, not a count; polls are documented as not limited, the token call is not mentioned.
 *  - only as search-engine extracts of company.wego.com/api-overview (the page is not readable): "A test API key can
 *    be provided for trial (up to a maximum of 2 weeks) before the purchase" and "Wego charges an annual fee of USD 1000
 *    for access to all Wego APIs". So the only free thing is a manually approved, time-boxed test key.
 * `allowance` is therefore a stand-in: 50, the only number the docs give for a test key. The cap is 30 (60% of it, so
 * even all of it inside one hour stays under that hourly limit). One unit = one quote = the metered search creation (the
 * unit is taken before the token call too, so nothing here can go unmetered). Raise it only after the owner has read
 * the API agreement that support.wan.travel would not serve.
 */
export const WEGO_QUOTA: Readonly<QuotaSpec> = Object.freeze({ period: "lifetime", cap: 30, allowance: 50 } satisfies QuotaSpec);

// --- limits ----------------------------------------------------------------------------------------------

/**
 * Date pairs one instance (one search) may quote. quotes.ts counts a quote as ONE of its 12 calls, but a Wego quote is
 * several requests, so Wego takes only the first pair it is asked (the pipeline queues the cheapest one first): the
 * pair whose cached price is worth confirming most. Every later pair gets [] without a unit and without a request.
 */
export const WEGO_MAX_QUOTES_PER_SEARCH = 1;
/** Result polls per quote. The guide needs ~7 for a complete answer; what is there after these is a live, partial one. */
export const WEGO_MAX_POLLS = 3;
/** Waits before poll 1, 2, 3 (the guide suggests 0.5, 1, 2, 3, 4 s). */
const POLL_WAITS_MS: readonly number[] = [500, 1_000, 1_500];
/** No poll is started with less than this left of the deadline (after its wait). */
const MIN_POLL_MS = 500;
/** Outbound requests per search: the token (when not cached) + per quote the search creation and its polls. */
export const WEGO_MAX_REQUESTS_PER_SEARCH = 1 + WEGO_MAX_QUOTES_PER_SEARCH * (1 + WEGO_MAX_POLLS);
/** One request, headers and body included. */
export const WEGO_REQUEST_TIMEOUT_MS = 3_000;
/** The whole quote (token, creation, waits, polls): what the pipeline allows one vendor request. */
export const WEGO_QUOTE_DEADLINE_MS = QUOTE_TIMEOUT_MS;
/** Free Workers get 10 ms of CPU per invocation: a page beyond this is refused before it is parsed. */
const MAX_BODY_CHARS = 500_000;
const MAX_ITEMS_PER_LIST = 500;
const MAX_POOL = 2_000;
const MAX_COUNT = 1_000_000;

// --- vendor facts (docs) ---------------------------------------------------------------------------------

const HOST = "https://affiliate-api.wego.com";
const TOKEN_URL = `${HOST}/apps/oauth/token`;
const SEARCH_URL = `${HOST}/metasearch/flights/searches`;
const REQUEST_CURRENCY = "USD"; // the docs' default; the fare's own price.currencyCode is what is read back
const LOCALE = "en";
/** ISO country of the site; "XX" is the documented value for unknown ("some content may be unavailable"). */
const SITE_CODE = "XX";
/** Token lifetime is ~12 h (expires_in 43199 / 43200): cached for that minus a margin, and never longer. */
const TOKEN_MAX_LIFE_S = 43_200;
const TOKEN_MARGIN_S = 600;
const TOKEN_CHARS = /^[\x21-\x7E]{1,4096}$/; // visible ASCII: nothing that could break a header
const SEARCH_ID = /^[A-Za-z0-9_-]{1,64}$/; // goes into a URL path: nothing but this

// --- token cache -----------------------------------------------------------------------------------------

/**
 * The bearer token, kept for the life of the isolate so most searches skip the token request. A plain value only (never
 * a promise: workerd cannot share I/O between requests). Dropped when the vendor answers 401.
 */
let tokenSlot: { clientId: string; token: string; expiresAt: number } | null = null;

/** For tests, and after a key rotation. */
export function resetWegoTokenCache(): void {
  tokenSlot = null;
}

// --- helpers ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const posNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const wholeNumber = (v: unknown, min: number): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : null);
const isOk = (status: number): boolean => status === 200 || status === 201; // the search creation answers 201

function validDate(s: string): boolean {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s; // the round trip rejects 2026-02-30
}

/** Local date and clock time of an ISO string that carries a numeric offset (so its digits ARE local); "Z" or none: unknown. */
const LOCAL_ISO = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/;
function localParts(iso: unknown): { date: string; time: string } | null {
  const m = typeof iso === "string" ? LOCAL_ISO.exec(iso) : null;
  return m ? { date: m[1] as string, time: m[2] as string } : null;
}

/**
 * The documented example body, for one adult in economy: only fields of the docs, unknown optional ones left out. The party
 * check may ask for more adults (QuoteQuery.adults); absent = 1, and the body is byte for byte what it was.
 */
function searchBody(q: QuoteQuery, clientCreatedAt: string): string | null {
  if (![q.origin, q.destination].every((c) => /^[A-Za-z]{3}$/.test(c)) || !validDate(q.departDate) || !validDate(q.returnDate) || q.returnDate < q.departDate) return null;
  let adults: number;
  try {
    adults = vendorAdults(q);
  } catch {
    return null;
  }
  const from = q.origin.toUpperCase();
  const to = q.destination.toUpperCase();
  return JSON.stringify({
    // paymentMethodIds is optional and its ids are site specific: omitted. `offset` (marked required in the docs' table
    // but in none of its examples) is omitted too, like in every example.
    search: {
      adultsCount: adults,
      childrenCount: 0,
      infantsCount: 0,
      cabin: "economy",
      currencyCode: REQUEST_CURRENCY,
      locale: LOCALE,
      siteCode: SITE_CODE,
      deviceType: "DESKTOP",
      appType: "WEB_APP",
      userLoggedIn: false,
      clientCreatedAt, // in the docs' examples, not in their table
      shopcashClickId: "", // same
      showWegoFares: false,
      showWegoFaresOnly: false,
      // round trip = exactly two legs, the second one the inverse of the first, dated with the RETURN date
      legs: [
        { outboundDate: q.departDate, departureAirportCode: from, arrivalAirportCode: to },
        { outboundDate: q.returnDate, departureAirportCode: to, arrivalAirportCode: from },
      ],
    },
  });
}

// --- reading the answer ----------------------------------------------------------------------------------

function readJson(text: string): unknown {
  if (text.length > MAX_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Everything the polls returned so far. Each poll is a delta whose referenced objects must be merged by id. */
interface Pool {
  fares: Map<string, Rec>;
  trips: Map<string, Rec>;
  legs: Map<string, Rec>;
}

function put(into: Map<string, Rec>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const item of list.slice(0, MAX_ITEMS_PER_LIST)) {
    if (into.size >= MAX_POOL) return;
    if (isRecord(item) && typeof item.id === "string" && item.id !== "") into.set(item.id, item);
  }
}

/** Merges one poll into the pool; returns the response's `count`, or null when the shape cannot be read. */
function absorb(pool: Pool, body: unknown): number | null {
  if (!isRecord(body)) return null;
  put(pool.fares, body.fares);
  put(pool.trips, body.trips);
  put(pool.legs, body.legs);
  const count = body.count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= MAX_COUNT ? count : null;
}

function readLeg(leg: Rec): Leg {
  const codes = Array.isArray(leg.airlineCodes) ? leg.airlineCodes.filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9]{2}$/.test(c)).map((c) => c.toUpperCase()) : [];
  return {
    departTime: localParts(leg.departureDateTime)?.time ?? null,
    arriveTime: localParts(leg.arrivalDateTime)?.time ?? null,
    stops: wholeNumber(leg.stopoversCount, 0),
    durationMin: wholeNumber(leg.durationMinutes, 1),
    airlines: [...new Set(codes)],
  };
}

/** A leg that is present must be the one that was asked for: same airports, same local date. Missing values cannot contradict. */
function isAsked(leg: Rec, from: string, to: string, date: string): boolean {
  const dep = typeof leg.departureAirportCode === "string" ? leg.departureAirportCode.toUpperCase() : from;
  const arr = typeof leg.arrivalAirportCode === "string" ? leg.arrivalAirportCode.toUpperCase() : to;
  const day = localParts(leg.departureDateTime)?.date ?? date;
  return dep === from && arr === to && day === date;
}

/** Only an https link without credentials may reach a card (a hostile value must not become a script or a login URL). */
function handoff(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2_048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === "" ? u.href : null;
  } catch {
    return null;
  }
}

interface Candidate {
  amount: number;
  currency: string;
  usd: number | null; // for ranking across currencies only
  fare: Rec;
  out: Rec;
  back: Rec;
}
const rank = (c: Candidate): number => c.usd ?? Number.POSITIVE_INFINITY;
const cheaper = (a: Candidate, b: Candidate): number => rank(a) - rank(b) || a.amount - b.amount;

/**
 * The cheapest fare of every trip (the search only returns the best fare per trip, and a later poll can bring a cheaper
 * one), the cheapest trips first. A fare without a readable price, a two-leg trip or the asked dates is dropped, and so is
 * one that `accept` (the party check's) refuses.
 */
function bestPerTrip(pool: Pool, q: QuoteQuery, accept?: (price: Rec, amount: number) => boolean): Candidate[] {
  const from = q.origin.toUpperCase();
  const to = q.destination.toUpperCase();
  const best = new Map<string, Candidate>();
  for (const fare of pool.fares.values()) {
    const price = isRecord(fare.price) ? fare.price : null;
    const amount = price ? posNumber(price.totalAmount) : null;
    const currency = price && typeof price.currencyCode === "string" ? price.currencyCode.toUpperCase() : "";
    const trip = typeof fare.tripId === "string" ? pool.trips.get(fare.tripId) : undefined;
    const legIds = trip && Array.isArray(trip.legIds) ? trip.legIds : [];
    const out = typeof legIds[0] === "string" ? pool.legs.get(legIds[0]) : undefined;
    const back = typeof legIds[1] === "string" ? pool.legs.get(legIds[1]) : undefined;
    if (!price || amount === null || !/^[A-Z]{3}$/.test(currency) || !out || !back || legIds.length !== 2) continue;
    if (!isAsked(out, from, to, q.departDate) || !isAsked(back, to, from, q.returnDate)) continue;
    if (accept && !accept(price, amount)) continue;
    const usd = posNumber(price.totalAmountUsd) ?? (currency === "USD" ? amount : null);
    const cand: Candidate = { amount, currency, usd, fare, out, back };
    const tripId = fare.tripId as string;
    const cur = best.get(tripId);
    if (!cur || cheaper(cand, cur) < 0) best.set(tripId, cand);
  }
  return [...best.values()].sort(cheaper);
}

/**
 * PARTY CHECK: "totalAmount is the price of ALL the adults asked" is our inference from the docs, not a documented fact (see the
 * header), so it is checked on every fare against the fare's OWN per-passenger figures: `amount` (the average, with the payment
 * fee), `originalAmount` (the average without it) and `amountPerAdult`. For more than one adult a fare is read only when it
 * states at least one of them AND every one it states, times the adults, matches the total within 5% or one unit per adult (the
 * figures are rounded, and a payment fee may sit in one of them only). A fare that states none cannot be checked and is not read;
 * one whose numbers disagree is not read either (never repaired): taken the wrong way round, a total that is really per person
 * would make one booking for everybody look N times cheaper. For ONE adult a total and a per-person price are the same thing, so
 * a fare without such figures is read, and one whose stated figures disagree with its total is not.
 */
export function partyTotalAgrees(price: Readonly<Record<string, unknown>>, total: number, adults: number): boolean {
  const stated = [posNumber(price.amount), posNumber(price.originalAmount), posNumber(price.amountPerAdult)].filter((v): v is number => v !== null);
  if (stated.length === 0) return adults === 1;
  const tolerance = Math.max(adults, total * 0.05);
  return stated.every((each) => Math.abs(total - each * adults) <= tolerance);
}

/** The vendor's identity of one leg: its segments' designator codes ("BA6177") and its local departure, or null when any is missing. */
function legKey(leg: Rec): string | null {
  const segs = Array.isArray(leg.segments) ? leg.segments : [];
  if (segs.length === 0) return null;
  const codes: string[] = [];
  for (const seg of segs) {
    const code = isRecord(seg) && typeof seg.designatorCode === "string" ? seg.designatorCode.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(code)) return null;
    codes.push(code);
  }
  const departs = localParts(leg.departureDateTime);
  return departs ? `${codes.join("+")}@${departs.date}T${departs.time}` : null;
}

/** PARTY CHECK: every trip's cheapest fare that passes partyTotalAgrees, as the price for all `adults` (price.totalAmount). */
function toPartyFares(pool: Pool, q: QuoteQuery, adults: number): PartyFare[] {
  return bestPerTrip(pool, q, (price, amount) => partyTotalAgrees(price, amount, adults))
    .slice(0, MAX_QUOTE_OFFERS_PER_CALL)
    .map((c) => {
      const outKey = legKey(c.out);
      const backKey = legKey(c.back);
      return {
        amount: Math.round(c.amount * 100) / 100,
        currency: c.currency,
        flightKey: outKey !== null && backKey !== null ? `${outKey}|${backKey}` : null,
        outbound: readLeg(c.out),
        inbound: readLeg(c.back),
      };
    });
}

function toOffers(pool: Pool, q: QuoteQuery, checkedAt: string): Offer[] {
  return bestPerTrip(pool, q)
    .slice(0, MAX_QUOTE_OFFERS_PER_CALL)
    .map((c) => ({
      origin: q.origin,
      destination: q.destination,
      departDate: q.departDate, // the vendor was asked for exactly these dates (and the legs were checked against them)
      returnDate: q.returnDate,
      priceAmount: Math.round(c.amount * 100) / 100, // price.totalAmount for the ONE adult that was asked for
      priceCurrency: c.currency, // what the fare says, never what was requested (the docs' own example differs)
      source: "wego" as const,
      ticketStructure: "roundtrip" as const,
      outbound: readLeg(c.out),
      inbound: readLeg(c.back),
      includes: {}, // the docs say nothing about bags
      deeplink: handoff(c.fare.handoffUrl), // Wego's own link, opens the search for one adult (the card price is scaled to the party)
      verifyLink: null,
      checkedAt,
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
    }));
}

// --- the source ------------------------------------------------------------------------------------------

export interface WegoOptions {
  /** The Wego client id (Worker secret WEGO_API_TOKEN). Missing or blank = not configured: never called, never counted. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** The shared counter (table source_quota). */
  repo: Repo;
  /** The moment of this search. */
  now: Date;
  /** Tests only: no real waiting, a controllable clock. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export function createWegoSource(opts: WegoOptions): FareQuoteSource {
  const key = (opts.apiKey ?? "").trim(); // a stray newline in a pasted secret would only break the request
  const quota: QuotaSpec = Object.freeze({ ...WEGO_QUOTA }); // the cap that was checked is the cap that is used
  const usable = key !== "" && quotaSpecIsSafe(quota);
  const doFetch: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init)); // workerd: fetch needs its global receiver
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = opts.clock ?? (() => Date.now());
  let requests = 0;
  let quotes = 0;

  /** One request, counted before it goes out. Failures of transport are a bare code; the caller looks at the status. */
  async function send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<{ status: number; text: string }> {
    requests += 1;
    try {
      const res = await doFetch(url, {
        method: init.method,
        headers: { Accept: "application/json", ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "manual", // never follow a redirect with a credential attached
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new QuoteError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
    }
  }

  /**
   * The bearer token: cached, or step 1 of the docs (client id in the body, no secret documented). null = unreadable answer.
   * `series` (party check only) holds the token of the series it belongs to: every later search of that series reuses it, so one
   * check never sends a second token request (even when the vendor's token could not be cached, e.g. without `expires_in`).
   */
  async function bearer(timeoutMs: () => number, series?: { token: string | null }): Promise<string | null> {
    if (series?.token) return series.token;
    if (tokenSlot && tokenSlot.clientId === key && tokenSlot.expiresAt > clock()) {
      if (series) series.token = tokenSlot.token;
      return tokenSlot.token;
    }
    tokenSlot = null;
    const res = await send(
      TOKEN_URL,
      { method: "POST", headers: { "Content-Type": "application/json", "X-Wego-Version": "1" }, body: JSON.stringify({ client_id: key, grant_type: "client_credentials", scope: "affiliate" }) },
      timeoutMs(),
    );
    if (!isOk(res.status)) throw new QuoteError("http", res.status);
    const body = readJson(res.text);
    const token = isRecord(body) ? body.access_token : undefined;
    if (typeof token !== "string" || !TOKEN_CHARS.test(token)) return null;
    const life = Math.min(posNumber(isRecord(body) ? body.expires_in : undefined) ?? 0, TOKEN_MAX_LIFE_S) - TOKEN_MARGIN_S;
    if (life > 0) tokenSlot = { clientId: key, token, expiresAt: clock() + life * 1000 };
    if (series) series.token = token;
    return token;
  }

  /**
   * Token, search creation, a few polls: what came back, or null when it cannot be read. Only transport and HTTP failures throw.
   * `series`: see bearer (absent for quote(), whose requests stay exactly what they were).
   */
  async function search(body: string, series?: { token: string | null }): Promise<Pool | null> {
    const deadline = clock() + WEGO_QUOTE_DEADLINE_MS;
    const timeoutMs = () => Math.min(WEGO_REQUEST_TIMEOUT_MS, deadline - clock());

    const token = await bearer(timeoutMs, series);
    if (token === null) return null;
    const auth = { Authorization: `Bearer ${token}` };
    const created = await send(SEARCH_URL, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body }, timeoutMs());
    if (!isOk(created.status)) {
      if (created.status === 401) tokenSlot = null; // a rejected token is dropped for the next search, never retried in this one
      throw new QuoteError("http", created.status);
    }
    const made = readJson(created.text);
    const id = isRecord(made) && isRecord(made.search) ? made.search.id : undefined;
    if (typeof id !== "string" || !SEARCH_ID.test(id)) return null;

    const pool: Pool = { fares: new Map(), trips: new Map(), legs: new Map() };
    let offset = 0; // the previous response's `count`: only the delta comes back
    let last = -1;
    for (let i = 0; i < WEGO_MAX_POLLS; i++) {
      const wait = POLL_WAITS_MS[i] ?? 0;
      if (deadline - clock() < wait + MIN_POLL_MS) break;
      await sleep(wait);
      let res: { status: number; text: string };
      try {
        res = await send(`${SEARCH_URL}/${id}/results?offset=${offset}&locale=${LOCALE}&currencyCode=${REQUEST_CURRENCY}`, { method: "GET", headers: auth }, timeoutMs());
        if (!isOk(res.status)) throw new QuoteError("http", res.status);
      } catch (err) {
        if (err instanceof QuoteError && err.status === 401) tokenSlot = null;
        if (pool.fares.size > 0) break; // fares in hand are live prices: a failing poll only ends the wait
        throw err;
      }
      const count = absorb(pool, readJson(res.text));
      if (count === null) break;
      // The docs stop after `count` was identical 3 times; with so few polls to spend, twice with fares in hand is enough.
      if (count === last && pool.fares.size > 0) break;
      last = count;
      offset = count;
    }
    return pool;
  }

  return {
    name: "wego",
    configured: usable,
    quota,
    // INFERRED from the docs, not stated there (see the header): totalAmount read as the whole group's price, and that reading is
    // checked on every fare of a multi-adult answer against its own per-passenger figures (partyTotalAgrees).
    partyPricing: "total",
    callCount: () => requests,
    // A quote is up to WEGO_MAX_REQUESTS_PER_SEARCH requests, and only the first pair asked is quoted: the pipeline counts requests, not quotes.
    nextQuoteRequests: () => (quotes < WEGO_MAX_QUOTES_PER_SEARCH ? WEGO_MAX_REQUESTS_PER_SEARCH : 0),

    async quote(q) {
      if (!usable) throw new QuoteError("not_configured");
      let stamp: string;
      try {
        stamp = opts.now.toISOString();
      } catch {
        return []; // a clock that cannot name a time is no reason to guess one
      }
      // Build (and so validate) the request first: a bad query must not burn a unit.
      const body = searchBody(q, stamp);
      if (body === null) return [];
      // Taken before any await, so parallel pairs cannot exceed the per-search share.
      if (quotes >= WEGO_MAX_QUOTES_PER_SEARCH) return [];
      quotes += 1;

      // RESERVE BEFORE THE FIRST REQUEST, never after: a timeout, a crash or a vendor-side retry can then only overcount.
      // Refused, unreadable or failed counter = no request at all (fail closed). There is deliberately no refund.
      let reserved = false;
      try {
        reserved = (await opts.repo.reserveQuota("wego", quotaPeriodKey(quota.period, opts.now), quota.cap, opts.now)) === true;
      } catch (err) {
        if (err instanceof QuoteError) throw err; // the daily share (withDailyShare) says why it refused
        reserved = false;
      }
      if (!reserved) throw new QuoteError("quota_exhausted");

      try {
        const pool = await search(body);
        return pool ? toOffers(pool, q, opts.now.toISOString()) : [];
      } catch (err) {
        if (err instanceof QuoteError) throw err;
        return []; // an answer whose shape broke the reader: nothing to offer, and nothing of it is kept
      }
    },

    /**
     * PARTY CHECK: one whole Wego search (creation, polls) per query, in order, all under ONE token (at most one token request per
     * series). All the units (one per search, like quote()) are reserved up front, all or none, before the first request. The
     * first failure ends the series (no later search, no retry), and so does an answer that cannot be read (token or search id:
     * QuoteError "response") or that holds no usable fare, or none the caller can compare (`comparable`, see answerUsable): the
     * series then resolves with fewer lists than queries.
     * Not limited by WEGO_MAX_QUOTES_PER_SEARCH, which is the search phase's own budget.
     */
    async partySeries(queries, comparable) {
      if (!usable) throw new QuoteError("not_configured");
      const stamp = opts.now.toISOString();
      // Build (and so validate) every body first: a bad query must not burn a unit.
      const bodies = queries.map((q) => {
        const body = searchBody(q, stamp);
        if (body === null) throw new RangeError("wego: invalid party-check query");
        return body;
      });
      if (bodies.length === 0) return [];
      await reserveUnits(opts.repo, "wego", quota, bodies.length, opts.now);
      const out: PartyFare[][] = [];
      const series: { token: string | null } = { token: null };
      for (const [i, body] of bodies.entries()) {
        const q = queries[i] as QuoteQuery;
        let pool: Pool | null;
        try {
          pool = await search(body, series);
        } catch (err) {
          throw err instanceof QuoteError ? err : new QuoteError("response"); // a failure ends the series here
        }
        // An unreadable answer (token or search id) is a failure too: nothing later is sent, nothing is retried.
        if (pool === null) throw new QuoteError("response");
        let fares: PartyFare[];
        try {
          fares = toPartyFares(pool, q, vendorAdults(q));
        } catch {
          throw new QuoteError("response");
        }
        out.push(fares);
        // Nothing usable (or comparable) in this answer: a later search could only be compared with nothing, so it is never started.
        if (!answerUsable(fares, comparable)) break;
      }
      return out;
    },
  };
}
