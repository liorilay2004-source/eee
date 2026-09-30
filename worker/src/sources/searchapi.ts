/**
 * SearchApi.io (https://www.searchapi.io), its Google Flights engine, as an optional LIVE fare source: one round-trip
 * search per date pair, one adult, economy. Only the vendor half lives here: the request for one date pair and the
 * reading of the answer (a QuoteAdapter). The shared core (quotes.ts, createQuoteSource) owns fetch, the timeout and the
 * request counter, so nothing in this file can make a request or skip the counter. No key = not configured = never
 * called, never counted.
 *
 * Written from the vendor docs (https://www.searchapi.io/docs/google-flights-api, read on 2026-09-29), not from a live
 * call. What the docs say, and what they leave open:
 *  - a round-trip answer lists the OUTBOUND itinerary only: `best_flights[].flights[]` are its segments and `price` is
 *    the round-trip price. The return itinerary is only reachable with a second request (`departure_token`), which
 *    would be a second billed request per date pair. This adapter never makes it, so the inbound leg stays unknown
 *    (all null, no airlines): never guessed. The core accepts an unknown return departure;
 *  - the answer carries no currency field, so the request asks for USD explicitly and the fares are USD;
 *  - the docs never say whether `price` is per passenger or for the party; the request asks for ONE adult, so it is one
 *    adult's price either way (the pipeline scales it to the party);
 *  - `airline` is a NAME ("Iberia"), the IATA code is only inside `flight_number` ("IB 212"): the code is read from there;
 *  - the docs give no baggage data for the price, so `checkedBag` is never set, and no booking link (only opaque tokens
 *    for a further billed request), so the adapter builds none (the core attaches an Aviasales search link).
 *  - PARTY CHECK (src/partycheck.ts): the docs list `adults` ("Defines the number of adults. Default is 1. Note: Maximum number
 *    of passengers is 9.", https://www.searchapi.io/docs/google-flights-api, "Number of Passengers"), so a query may ask for
 *    more than one adult (QuoteQuery.adults; absent = 1 and the request is byte for byte what it was). But `price` has no
 *    description at all there, only example values: whether a price for several adults is per person or for all of them is
 *    UNKNOWN, so partyPricing is "unknown" and the party check never uses this source (read on 2026-09-30).
 */
import { createQuoteSource, vendorAdults, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuotaSpec, type QuoteQuery } from "../quotes";
import type { Leg, Repo } from "../types";

// --- quota ----------------------------------------------------------------------------------------------

/**
 * SearchApi.io's free allowance is 100 requests, once. Pricing page (https://www.searchapi.io/pricing): "Sign up for 100
 * free requests" / "No credit card required. No commitment. Cancel anytime."; no monthly reset is stated anywhere, so the
 * counter is lifetime. Terms (https://www.searchapi.io/legal/terms): "For paid Services that offer a free trial, we
 * explain the length of trial when you sign up. After the trial period, you need to pay in advance to keep using the
 * Service. If you do not pay, we will freeze your account": prepaid, no overage bill, and a card is charged only when the
 * owner upgrades by hand ("If you are upgrading from a free plan to a paid plan, we will charge your card immediately").
 * The cap is 50% of the allowance, tighter than the 80% the rule allows, because the pages say nothing about (a) how many
 * credits one Google Flights request costs, (b) how long the trial lasts (it is "explained at sign-up"), and (c) requests
 * made with the same key outside this Worker (a dashboard playground), which this counter cannot see. We count every
 * reserved request, failed ones too, although the vendor bills only HTTP 200 ("Only successful searches with a 200 status
 * code incur charges"): we can only overcount. Separately the vendor lets a plan use "only up to 20% of your plan's credits
 * each hour": an HTTP 429 or 403 then stops the source for the rest of that search (see runQuotes) and costs nothing.
 */
export const SEARCHAPI_QUOTA: QuotaSpec = Object.freeze({ period: "lifetime", cap: 50, allowance: 100 });

// --- request --------------------------------------------------------------------------------------------

const ENDPOINT = "https://www.searchapi.io/api/v1/search";
/** Asked for explicitly (the vendor's default is also USD), because the answer never says which currency `price` is in. */
const CURRENCY = "USD";
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: string): boolean => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- reading the answer ---------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** "HH:MM" exactly as the docs print it (the airport's own clock, no time-zone conversion), else null. */
const hhmm = (v: unknown): string | null => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);

/** What the answer states is a different airport (or day) than the one asked for; an unstated one is no mismatch. */
const differs = (v: unknown, asked: string): boolean => typeof v === "string" && v.trim().toUpperCase() !== asked;

/** IATA airline code from a flight number such as "IB 212" or "9W 1234"; the `airline` field is only a name. */
function carrierOf(flightNumber: unknown): string | null {
  const m = typeof flightNumber === "string" ? /^([A-Z0-9]{2})\s?\d{1,4}[A-Z]?$/.exec(flightNumber.trim().toUpperCase()) : null;
  return m ? (m[1] as string) : null;
}

/** The return itinerary is not part of a round-trip answer (see the header): everything about it is unknown. */
const UNKNOWN_LEG: Leg = { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] };

/**
 * The outbound itinerary: `flights` are its segments in order. Needs at least one readable segment; inside a segment
 * every unknown value stays null / empty, never guessed. A flight that starts on another day, at another airport or that
 * ends at another airport is not the pair we asked for (undefined = not this fare).
 */
function readOutbound(flights: unknown, total: unknown, q: QuoteQuery): Leg | undefined {
  if (!Array.isArray(flights) || flights.length === 0 || !flights.every(isRec)) return undefined;
  const segs = flights as Rec[];
  const first = segs[0] as Rec;
  const last = segs[segs.length - 1] as Rec;
  const from = isRec(first.departure_airport) ? first.departure_airport : {};
  const to = isRec(last.arrival_airport) ? last.arrival_airport : {};
  if (differs(from.id, q.origin) || differs(to.id, q.destination)) return undefined;
  if (typeof from.date === "string" && ISO_DATE.test(from.date) && from.date !== q.departDate) return undefined;
  const airlines: string[] = [];
  for (const s of segs) {
    const code = carrierOf(s.flight_number);
    if (code !== null && !airlines.includes(code)) airlines.push(code);
  }
  return {
    departTime: hhmm(from.time),
    arriveTime: hhmm(to.time),
    stops: segs.length - 1,
    durationMin: typeof total === "number" && Number.isInteger(total) && total > 0 ? total : null,
    airlines,
  };
}

/** One entry of best_flights, or null when it is not a fare we can vouch for (the caller drops it, never repairs it). */
function readFare(it: unknown, q: QuoteQuery): ParsedFare | null {
  if (!isRec(it)) return null;
  const price = it.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  // The search asks for a round trip, so the price must be one ("type": "Round trip"); a stated other type is not.
  if (typeof it.type === "string" && it.type.trim().toLowerCase() !== "round trip") return null;
  // The search asks for economy: a segment stated in another cabin may not be ranked next to a normal round trip.
  if (Array.isArray(it.flights) && it.flights.some((s) => isRec(s) && typeof s.travel_class === "string" && s.travel_class.trim().toLowerCase() !== "economy")) return null;
  const outbound = readOutbound(it.flights, it.total_duration, q);
  if (!outbound) return null;
  // The answer has no currency field: it is the one the request asked for.
  return { price, currency: CURRENCY, outbound, inbound: { ...UNKNOWN_LEG, airlines: [] } };
}

// --- the adapter ----------------------------------------------------------------------------------------

export const searchApiAdapter: QuoteAdapter = {
  name: "searchapi",
  quota: SEARCHAPI_QUOTA,
  // The docs do not say whether a multi-adult `price` is per person or for all (see the header): never guessed.
  partyPricing: "unknown",

  request(q, key) {
    // Validated here so that a bad query fails before a unit of the allowance is reserved.
    if (!IATA.test(q.origin) || !IATA.test(q.destination) || q.origin === q.destination) {
      throw new RangeError("searchapi: origin and destination must be two different IATA airport codes");
    }
    if (!isRealDate(q.departDate) || !isRealDate(q.returnDate) || q.returnDate < q.departDate) {
      throw new RangeError("searchapi: dates must be YYYY-MM-DD, the return on or after the departure");
    }
    const adults = vendorAdults(q); // 1 unless the party check asks for more (a bad value throws here, before any unit)
    // ONE adult: the pipeline scales the price to the party. Cheapest first, and no separate / self-transfer tickets.
    const params = new URLSearchParams({
      engine: "google_flights",
      flight_type: "round_trip",
      departure_id: q.origin,
      arrival_id: q.destination,
      outbound_date: q.departDate,
      return_date: q.returnDate,
      adults: String(adults),
      travel_class: "economy",
      currency: CURRENCY,
      sort_by: "price",
      separate_tickets: "1",
    });
    return {
      url: `${ENDPOINT}?${params.toString()}`,
      method: "GET",
      // The key is a header only (the docs allow it: "in the Authorization header (Bearer YOUR_API_KEY)"), never in the URL.
      headers: { Authorization: `Bearer ${key}` },
    };
  },

  parse(body, q) {
    if (!isRec(body) || !Array.isArray(body.best_flights)) return [];
    const fares: ParsedFare[] = [];
    for (const it of body.best_flights as unknown[]) {
      const fare = readFare(it, q);
      if (fare) fares.push(fare);
    }
    return fares;
  },
};

/** The source the pipeline asks. `apiKey` is the SEARCHAPI_KEY secret: missing or blank means not configured. */
export function createSearchApiSource(opts: { apiKey?: string; fetchFn?: typeof fetch; repo: Repo; now: Date; marker?: string }): FareQuoteSource {
  return createQuoteSource(searchApiAdapter, { key: opts.apiKey, repo: opts.repo, now: opts.now, marker: opts.marker, fetchFn: opts.fetchFn });
}
