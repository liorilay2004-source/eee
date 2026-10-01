/**
 * HasData (https://hasdata.com), its Google Flights API, as an optional LIVE fare source: one round-trip search per date pair,
 * one adult, economy. Only the vendor half lives here: the request for one date pair and the reading of the answer (a
 * QuoteAdapter). The shared core (quotes.ts, createQuoteSource) owns fetch, the timeout and the request counter, so nothing in
 * this file can make a request or skip the counter. No key = not configured = never called, never counted.
 *
 * Written from the vendor docs (https://docs.hasdata.com/apis/google-travel/flights.md and the vendor's own scraping guide,
 * https://hasdata.com/blog/how-to-scrape-google-flights, both read on 2026-10-01), NOT from a live call: the owner has not set a
 * key yet. What the docs say, and what they leave open:
 *  - endpoint `GET https://api.hasdata.com/scrape/google/flights`, key in the `x-api-key` header; required parameters are
 *    `departureId`, `arrivalId`, `outboundDate` (and `returnDate` for a round trip);
 *  - the answer lists `bestFlights` / `otherFlights`; each entry has `price`, `type` ("Round trip" / "One way"), `totalDuration`
 *    and `flights[]` (the OUTBOUND segments). The return itinerary needs a second request (`departureToken`), a second billed
 *    request per date pair, which this adapter never makes: the inbound leg stays unknown (all null, no airlines), never guessed;
 *  - the docs show no currency field in the answer, so the request asks for USD explicitly and the fares are USD;
 *  - the docs never say whether `price` is per passenger or for the party; the request asks for ONE adult, so it is one adult's
 *    price either way (the pipeline scales it to the party);
 *  - `airline` is a NAME, the IATA code is only inside `flightNumber` ("IB 212"): the code is read from there;
 *  - the docs do not state the format of a segment's `time`: it is read only when it is "HH:MM" (optionally after a date), else
 *    left null, never guessed; there is no baggage data and no booking link for the price (only opaque tokens for a further
 *    billed request), so `checkedBag` is never set and the core attaches an Aviasales search link.
 */
import { createQuoteSource, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuotaSpec, type QuoteQuery } from "../quotes";
import type { Leg, Repo } from "../types";

// --- quota ----------------------------------------------------------------------------------------------

/**
 * HasData's free plan is 1,000 credits a month, renewing, no card (the vendor's onboarding page says "no credit card required").
 * A Google Flights request costs 15 credits ("Cost per request: 15 API Credits", charged "only for successful requests"), so the
 * month holds 1000 / 15 = 66 requests. The cap is 55: 11 requests (about 17%) spare, because (a) the pricing page was not read
 * for what happens at 0 credits (stop, or an overage bill: unknown, hence the margin), (b) requests made with the same key outside
 * this Worker (the vendor's dashboard playground) cannot be seen by this counter. Every reserved request is counted, failed ones
 * too, although the vendor charges only successful ones: we can only overcount. The monthly counter is per UTC month (the
 * vendor's own reset day is not stated).
 */
export const HASDATA_QUOTA: QuotaSpec = Object.freeze({ period: "monthly", cap: 55, allowance: 66 });

// --- request --------------------------------------------------------------------------------------------

const ENDPOINT = "https://api.hasdata.com/scrape/google/flights";
/** Asked for explicitly, because the answer shows no currency field. */
const CURRENCY = "USD";
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: string): boolean => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- reading the answer ---------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** "HH:MM", alone or after a date ("2026-11-10 08:15" / "...T08:15"), as the airport's own clock; anything else is null. */
const timeOf = (v: unknown): string | null => {
  const m = typeof v === "string" ? /(?:^|[ T])([01]\d|2[0-3]):([0-5]\d)(?::\d{2})?$/.exec(v.trim()) : null;
  return m ? `${m[1]}:${m[2]}` : null;
};
/** The date part of a segment time when it has one, else null (an unstated date is no mismatch). */
const dateOf = (v: unknown): string | null => {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/.exec(v.trim()) : null;
  return m ? (m[1] as string) : null;
};

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
 * The outbound itinerary: `flights` are its segments in order. Needs at least one readable segment; inside a segment every
 * unknown value stays null / empty. A flight at another airport, or on another stated day, is not the pair we asked for
 * (undefined = not this fare).
 */
function readOutbound(flights: unknown, total: unknown, q: QuoteQuery): Leg | undefined {
  if (!Array.isArray(flights) || flights.length === 0 || !flights.every(isRec)) return undefined;
  const segs = flights as Rec[];
  const first = segs[0] as Rec;
  const last = segs[segs.length - 1] as Rec;
  const from = isRec(first.departureAirport) ? first.departureAirport : {};
  const to = isRec(last.arrivalAirport) ? last.arrivalAirport : {};
  if (differs(from.id, q.origin) || differs(to.id, q.destination)) return undefined;
  const day = dateOf(from.time);
  if (day !== null && day !== q.departDate) return undefined;
  const airlines: string[] = [];
  for (const s of segs) {
    const code = carrierOf(s.flightNumber);
    if (code !== null && !airlines.includes(code)) airlines.push(code);
  }
  return {
    departTime: timeOf(from.time),
    arriveTime: timeOf(to.time),
    stops: segs.length - 1,
    durationMin: typeof total === "number" && Number.isInteger(total) && total > 0 ? total : null,
    airlines,
  };
}

/** One entry of bestFlights / otherFlights, or null when it is not a fare we can vouch for (dropped, never repaired). */
function readFare(it: unknown, q: QuoteQuery): ParsedFare | null {
  if (!isRec(it)) return null;
  const price = it.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  // The search asks for a round trip, so the price must be one ("Round trip"); a stated other type is not.
  if (typeof it.type === "string" && it.type.trim().toLowerCase() !== "round trip") return null;
  // The search asks for economy: a segment stated in another cabin may not be ranked next to a normal round trip.
  if (Array.isArray(it.flights) && it.flights.some((s) => isRec(s) && typeof s.travelClass === "string" && s.travelClass.trim().toLowerCase() !== "economy")) return null;
  const outbound = readOutbound(it.flights, it.totalDuration, q);
  if (!outbound) return null;
  // The answer has no currency field: it is the one the request asked for.
  return { price, currency: CURRENCY, outbound, inbound: { ...UNKNOWN_LEG, airlines: [] } };
}

// --- the adapter ----------------------------------------------------------------------------------------

export const hasDataAdapter: QuoteAdapter = {
  name: "hasdata",
  quota: HASDATA_QUOTA,

  request(q, key) {
    // Validated here so that a bad query fails before a unit of the allowance is reserved.
    if (!IATA.test(q.origin) || !IATA.test(q.destination) || q.origin === q.destination) {
      throw new RangeError("hasdata: origin and destination must be two different IATA airport codes");
    }
    if (!isRealDate(q.departDate) || !isRealDate(q.returnDate) || q.returnDate < q.departDate) {
      throw new RangeError("hasdata: dates must be YYYY-MM-DD, the return on or after the departure");
    }
    // ONE adult: the pipeline scales the price to the party. Cheapest first. deepSearch stays off (it is slower and the docs do
    // not say it costs the same credits).
    const params = new URLSearchParams({
      departureId: q.origin,
      arrivalId: q.destination,
      outboundDate: q.departDate,
      returnDate: q.returnDate,
      type: "roundTrip",
      adults: "1",
      travelClass: "Economy",
      currency: CURRENCY,
      sortBy: "Price",
    });
    return {
      url: `${ENDPOINT}?${params.toString()}`,
      method: "GET",
      // The key is a header only (the docs: "All requests must include your key in the x-api-key header"), never in the URL.
      headers: { "x-api-key": key },
    };
  },

  parse(body, q) {
    if (!isRec(body)) return [];
    const fares: ParsedFare[] = [];
    for (const list of [body.bestFlights, body.otherFlights]) {
      if (!Array.isArray(list)) continue;
      for (const it of list as unknown[]) {
        const fare = readFare(it, q);
        if (fare) fares.push(fare);
      }
    }
    return fares;
  },
};

/** The source the pipeline asks. `apiKey` is the HASDATA_API_KEY secret: missing or blank means not configured. */
export function createHasDataSource(opts: { apiKey?: string; fetchFn?: typeof fetch; repo: Repo; now: Date; marker?: string }): FareQuoteSource {
  return createQuoteSource(hasDataAdapter, { key: opts.apiKey, repo: opts.repo, now: opts.now, marker: opts.marker, fetchFn: opts.fetchFn });
}
