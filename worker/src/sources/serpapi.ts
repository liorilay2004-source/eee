/**
 * SerpApi (https://serpapi.com), its Google Flights engine (engine=google_flights), as an optional LIVE fare source: one
 * round-trip search per date pair, one adult, economy. Only the vendor half lives here: the request for one date pair and
 * the reading of the answer (a QuoteAdapter). The shared core (quotes.ts, createQuoteSource) owns fetch, the timeout and
 * the request counter, so nothing in this file can make a request or skip the counter. No key = not configured = never
 * called, never counted.
 *
 * Written from the vendor docs (https://serpapi.com/google-flights-api, /google-flights-results, /pricing,
 * /api-status-and-error-codes), not from a live call. What the docs say, and what they leave open:
 *  - the ONLY documented authentication is the query-string parameter `api_key` (no header form): the key is therefore in
 *    the URL this adapter hands to the core. The core passes that URL to fetch and to nothing else (an error is a bare
 *    code, never a URL, a message of fetch or a body), so it cannot be echoed, logged or shown in meta.sources;
 *  - a round-trip answer lists the OUTBOUND itinerary only: `flights[]` are its segments and `price` is documented only as
 *    "This ticket price in the selected currency". That it is the TOTAL round-trip price is an inference from a vendor
 *    tutorial, not a documented guarantee: verify it with ONE live call against the Google Flights site before relying on
 *    it (that call costs 1 of the 250 searches). The return itinerary is only reachable with a second request
 *    (`departure_token`), which would be a second counted search per date pair. This adapter never makes it (nor the
 *    `booking_token` one), so the inbound leg stays unknown (all null, no airlines): never guessed;
 *  - the answer carries no currency field, so the request asks for USD explicitly and the fares are USD;
 *  - `airline` is a NAME ("Iberia"); the IATA code is only inside `flight_number` ("IB 212"), and the code is read from
 *    there. The format of `time` is not stated: "YYYY-MM-DD HH:MM" and a bare "HH:MM" are both read, else it is unknown;
 *  - `layovers[]` key names are not confirmed, so stops are the segment count minus one and nothing else is read from it;
 *  - `carbon_emissions` has no place in an Offer and is not read; no baggage data for the price, so `checkedBag` is never
 *    set; no booking link (`booking_token` needs another counted search), so the adapter builds none and the core attaches
 *    an Aviasales search link for the same dates;
 *  - the default is a cached result, up to 1 hour old and free of charge at the vendor (`no_cache` is not sent). That is
 *    far fresher than the 2-7 days of the Travelpayouts cache this source exists to confirm.
 *  - PARTY CHECK (src/partycheck.ts): the docs list `adults` ("Parameter defines the number of adults. Default to 1.",
 *    https://serpapi.com/google-flights-api, "Number Of Passengers"), so a query may ask for more than one adult (QuoteQuery.
 *    adults; absent = 1 and the request is byte for byte what it was). But the only description of `price` is "This ticket price
 *    in the selected currency, the default currency is USD" (https://serpapi.com/google-flights-api, JSON structure; the same
 *    words on https://serpapi.com/google-flights-results): it does NOT say whether a price for several adults is per person or
 *    for all of them. So partyPricing is "unknown" and the party check never uses this source (read on 2026-09-30).
 */
import { createQuoteSource, vendorAdults, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuotaSpec, type QuoteQuery } from "../quotes";
import type { Leg, Repo } from "../types";

// --- quota ----------------------------------------------------------------------------------------------

/**
 * SerpApi's free allowance is 250 searches PER MONTH. Pricing page (https://serpapi.com/pricing): Free plan = $0, 250
 * searches per month, 50 searches per hour, month-to-month. Counting rule (pricing FAQ): "Only successful searches are
 * counted toward your monthly searches. Cached, errored, and failed searches are not." (a search with zero results is
 * "successful" and does count). Out of searches: HTTP 429 {"error": "Your account has run out of searches."}; the only
 * auto-renewal documented is opt-in ("You can set your plan to Automatic Early Renewal. It will trigger an early renewal
 * once you've used all your searches.") and the docs do not say the Free plan is immune to it, so the owner must NEVER
 * enable it and never attach a payment method: the cap below, not the vendor's 429, is what stops us.
 * The cap is 100 = 40% of the allowance, tighter than the 80% the rule allows and than the 200 the vendor notes suggest
 * (200 is 80%, above the 45% the core allows a monthly cap and would make it refuse the spec): the counter is per UTC month
 * but the vendor's month runs from a `plan_renewal_date` that may start on another day, so two of our months can fall
 * into one vendor cycle (2 x 100 = 200 < 250), and the 150 spare also cover searches made with the same key outside this
 * Worker (a dashboard playground, a test script), which this counter cannot see. We count every reserved request, failed,
 * cached and empty ones too, although the vendor counts only successful uncached ones: we can only overcount.
 * Separately the vendor limits throughput to 50 searches per hour: an HTTP 429 stops the source for the rest of that
 * search (see runQuotes) and is never retried.
 */
export const SERPAPI_QUOTA: QuotaSpec = Object.freeze({ period: "monthly", cap: 100, allowance: 250 });

// --- request --------------------------------------------------------------------------------------------

const ENDPOINT = "https://serpapi.com/search";
/** Asked for explicitly (the vendor's default is also USD), because the answer never says which currency `price` is in. */
const CURRENCY = "USD";
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: string): boolean => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- reading the answer ---------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The airport's own clock of a `time` value: "HH:MM" plus the local date when the value carries one, else null. */
function clock(v: unknown): { date: string | null; hhmm: string } | null {
  const m = typeof v === "string" ? /^(?:(\d{4}-\d{2}-\d{2})[ T])?([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(v.trim()) : null;
  return m ? { date: m[1] ?? null, hhmm: `${m[2]}:${m[3]}` } : null;
}

/** What the answer states is a different airport than the one asked for; an unstated one is no mismatch. */
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
  const departs = clock(from.time);
  if (departs?.date != null && departs.date !== q.departDate) return undefined;
  const airlines: string[] = [];
  for (const s of segs) {
    const code = carrierOf(s.flight_number);
    if (code !== null && !airlines.includes(code)) airlines.push(code);
  }
  return {
    departTime: departs?.hhmm ?? null,
    arriveTime: clock(to.time)?.hhmm ?? null,
    stops: segs.length - 1,
    durationMin: typeof total === "number" && Number.isInteger(total) && total > 0 ? total : null,
    airlines,
  };
}

/** `type` mirrors the request parameter: a stated value other than a round trip is not the price we asked for. */
const isRoundTrip = (type: unknown): boolean => type == null || type === 1 || (typeof type === "string" && /^(1|round[\s_-]?trip)$/i.test(type.trim()));

/** One entry of best_flights / other_flights, or null when it is not a fare we can vouch for (dropped, never repaired). */
function readFare(it: unknown, q: QuoteQuery): ParsedFare | null {
  if (!isRec(it)) return null;
  const price = it.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  if (!isRoundTrip(it.type)) return null;
  // The search asks for economy: a segment stated in another cabin may not be ranked next to a normal round trip.
  if (Array.isArray(it.flights) && it.flights.some((s) => isRec(s) && typeof s.travel_class === "string" && s.travel_class.trim().toLowerCase() !== "economy")) return null;
  const outbound = readOutbound(it.flights, it.total_duration, q);
  if (!outbound) return null;
  // The answer has no currency field: it is the one the request asked for.
  return { price, currency: CURRENCY, outbound, inbound: { ...UNKNOWN_LEG, airlines: [] } };
}

// --- the adapter ----------------------------------------------------------------------------------------

export const serpApiAdapter: QuoteAdapter = {
  name: "serpapi",
  quota: SERPAPI_QUOTA,
  // The docs do not say whether a multi-adult `price` is per person or for all (see the header): never guessed.
  partyPricing: "unknown",

  request(q, key) {
    // Validated here so that a bad query fails before a unit of the allowance is reserved (a bad request is a 400 that
    // wastes throughput). The messages carry no key and no URL.
    if (!IATA.test(q.origin) || !IATA.test(q.destination) || q.origin === q.destination) {
      throw new RangeError("serpapi: origin and destination must be two different IATA airport codes");
    }
    if (!isRealDate(q.departDate) || !isRealDate(q.returnDate) || q.returnDate < q.departDate) {
      throw new RangeError("serpapi: dates must be YYYY-MM-DD, the return on or after the departure");
    }
    const adults = vendorAdults(q); // 1 unless the party check asks for more (a bad value throws here, before any unit)
    // ONE adult: the pipeline scales the price to the party. Round trip (type 1), economy (travel_class 1), cheapest
    // first (sort_by 2). Not sent, on purpose: deep_search (slow), no_cache (a fresh search is never cheaper), async,
    // departure_token / booking_token (each would be a further counted search).
    const params = new URLSearchParams({
      engine: "google_flights",
      departure_id: q.origin,
      arrival_id: q.destination,
      outbound_date: q.departDate,
      return_date: q.returnDate,
      type: "1",
      currency: CURRENCY,
      hl: "en",
      adults: String(adults),
      travel_class: "1",
      sort_by: "2",
      api_key: key, // the one documented way to authenticate; see the header for why this URL never leaves the core
    });
    return { url: `${ENDPOINT}?${params.toString()}`, method: "GET", headers: {} };
  },

  parse(body, q) {
    // An error message with HTTP 200 (e.g. "no results") is no fare; neither is a search that did not finish.
    if (!isRec(body) || body.error !== undefined) return [];
    if (isRec(body.search_metadata) && typeof body.search_metadata.status === "string" && body.search_metadata.status !== "Success") return [];
    // The answer never echoes the currency of `price`; when it does state one, only the one we asked for is a fare.
    if (isRec(body.search_parameters) && typeof body.search_parameters.currency === "string" && body.search_parameters.currency.trim().toUpperCase() !== CURRENCY) return [];
    // best_flights is "not always returned": when the results are not split, they are all in other_flights.
    const lists = [body.best_flights, body.other_flights];
    if (!lists.some(Array.isArray)) return [];
    const fares: ParsedFare[] = [];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const it of list as unknown[]) {
        const fare = readFare(it, q);
        if (fare) fares.push(fare);
      }
    }
    return fares;
  },
};

/** The source the pipeline asks. `apiKey` is the SERPAPI_KEY secret: missing or blank means not configured. */
export function createSerpApiSource(opts: { apiKey?: string; fetchFn?: typeof fetch; repo: Repo; now: Date; marker?: string }): FareQuoteSource {
  return createQuoteSource(serpApiAdapter, { key: opts.apiKey, repo: opts.repo, now: opts.now, marker: opts.marker, fetchFn: opts.fetchFn });
}
