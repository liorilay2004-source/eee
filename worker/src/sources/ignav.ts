/**
 * Ignav (https://ignav.com) as an optional LIVE fare source: one round-trip search per date pair, one adult, economy.
 * Only the vendor half lives here: the request for one date pair and the reading of the answer (a QuoteAdapter). The
 * shared core (quotes.ts, createQuoteSource) owns fetch, the timeout and the request counter, so nothing in this file
 * can make a request or skip the counter. No key = not configured = never called, never counted.
 *
 * Written from the vendor docs, not from a live call. Assumed where the docs are silent:
 *  - price.amount of a round-trip itinerary is the total of both legs (the docs never say it, their example suggests it);
 *  - bags.checked is the number of checked bags included in that price;
 *  - the fare is live: the docs promise no freshness ("Fare data changes continuously"), so it is as live as they say.
 *
 * Only the round-trip search is used. An airport search or a booking-links lookup is billed exactly like a search, so
 * this adapter never makes one and builds no booking link of its own (the core attaches an Aviasales search link).
 *
 * PARTY CHECK (src/partycheck.ts): the docs list `adults` ("Number of passengers age 12 or older. Default: 1. Max total
 * passengers: 9.", https://ignav.com/docs/one-way; the round trip "Accepts all one-way parameters",
 * https://ignav.com/docs/round-trip; OpenAPI https://ignav.com/openapi.json RoundTripRequest.adults), so a query may ask for
 * more than one adult (QuoteQuery.adults; absent = 1 and the request is byte for byte what it was). But the docs never say
 * whether `price.amount` for several adults is per person or for all of them: "the total itinerary price" (round-trip page)
 * and "a trip-level price" (https://ignav.com/docs/faq) speak of the legs, not of the passengers, and the OpenAPI PriceModel
 * has no description. So partyPricing is "unknown" and the party check never uses this source (read on 2026-09-30).
 */
import { createQuoteSource, vendorAdults, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuotaSpec, type QuoteQuery } from "../quotes";
import type { Leg, Repo } from "../types";

// --- quota ----------------------------------------------------------------------------------------------

/**
 * Ignav's free allowance is 1,000 requests IN TOTAL, one-off, no card needed. Pricing page: "1,000 one-time free
 * requests."; FAQ: "Your first 1,000 requests are a one-time free allowance and do not reset monthly."; after it "$2 per
 * 1,000 successful requests" (HTTP 402 "billing_required" until a card is added). So the counter is lifetime, and the
 * cap is 80% of it. The 200 spare cover requests made outside this Worker with the same key, the moment the 402 starts
 * (inferred, not quoted) and anything the vendor bills that we did not count. We count every reserved request, failed
 * ones too, although the vendor bills only HTTP 200 ("Failed requests (4xx/5xx) are never billed"): we can only overcount.
 */
export const IGNAV_QUOTA: QuotaSpec = Object.freeze({ period: "lifetime", cap: 800, allowance: 1000 });

// --- request --------------------------------------------------------------------------------------------

const ENDPOINT = "https://ignav.com/api/fares/round-trip";
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: string): boolean => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- reading the answer ---------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Local wall-clock "HH:MM" of "YYYY-MM-DDTHH:MM:SS" (no time-zone conversion: the offset is the airport's), else null. */
function hhmm(iso: unknown): string | null {
  return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d/.test(iso) ? iso.slice(11, 16) : null;
}

/** Local calendar date of such a string, else null. */
const dayOf = (iso: unknown): string | null => (typeof iso === "string" && ISO_DATE.test(iso.slice(0, 10)) ? iso.slice(0, 10) : null);

/** The airport the answer says it is for: only a stated, different one counts as a mismatch. */
const echoDiffers = (v: unknown, asked: string): boolean => typeof v === "string" && v.trim().toUpperCase() !== asked;

/**
 * One direction. Needs at least one readable segment (that is what makes it a flight); inside a segment every unknown
 * value stays null / empty, never guessed. `date` is the local departure day that was asked for: a leg on another day
 * is not the pair we asked for (undefined = not this itinerary).
 */
function readLeg(v: unknown, date: string): Leg | undefined {
  if (!isRec(v) || !Array.isArray(v.segments) || v.segments.length === 0 || !v.segments.every(isRec)) return undefined;
  const segs = v.segments as Rec[];
  const first = segs[0] as Rec;
  const last = segs[segs.length - 1] as Rec;
  const day = dayOf(first.departure_time_local);
  if (day !== null && day !== date) return undefined;
  const airlines: string[] = [];
  for (const s of segs) {
    const code = typeof s.marketing_carrier_code === "string" ? s.marketing_carrier_code.trim().toUpperCase() : "";
    if (/^[A-Z0-9]{2}$/.test(code) && !airlines.includes(code)) airlines.push(code);
  }
  const minutes = v.duration_minutes;
  return {
    departTime: hhmm(first.departure_time_local),
    arriveTime: hhmm(last.arrival_time_local),
    stops: segs.length - 1,
    durationMin: typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    airlines,
  };
}

/** One itinerary, or null when it is not a fare we can vouch for (the caller drops it, never repairs it). */
function readItinerary(it: unknown, q: QuoteQuery): ParsedFare | null {
  if (!isRec(it) || !isRec(it.price)) return null;
  // "unverified means the amount has not been confirmed": no use for a source whose job is to confirm a price.
  if (it.price.status !== "verified") return null;
  const amount = it.price.amount;
  const currency = typeof it.price.currency === "string" ? it.price.currency.trim().toUpperCase() : "";
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  // Self-transfer is not one ticket, and the search asks for economy: neither may be ranked next to a normal round trip.
  if (it.requires_self_transfer === true) return null;
  if (typeof it.cabin_class === "string" && it.cabin_class !== "economy") return null;
  // A round-trip price is only usable with both directions in the answer (the docs list `inbound` as optional).
  const outbound = readLeg(it.outbound, q.departDate);
  const inbound = readLeg(it.inbound, q.returnDate);
  if (!outbound || !inbound) return null;
  const checked = isRec(it.bags) ? it.bags.checked : undefined;
  const checkedBag = typeof checked === "number" && Number.isInteger(checked) && checked >= 0 ? checked > 0 : undefined;
  return { price: amount, currency, outbound, inbound, ...(checkedBag === undefined ? {} : { checkedBag }) };
}

// --- the adapter ----------------------------------------------------------------------------------------

export const ignavAdapter: QuoteAdapter = {
  name: "ignav",
  quota: IGNAV_QUOTA,
  // The docs do not say whether a multi-adult price is per person or for all (see the header): never guessed.
  partyPricing: "unknown",

  request(q, key) {
    // Validated here so that a bad query fails before a unit of the allowance is reserved.
    if (!IATA.test(q.origin) || !IATA.test(q.destination) || q.origin === q.destination) {
      throw new RangeError("ignav: origin and destination must be two different IATA airport codes");
    }
    if (!isRealDate(q.departDate) || !isRealDate(q.returnDate) || q.returnDate < q.departDate) {
      throw new RangeError("ignav: dates must be YYYY-MM-DD, the return on or after the departure");
    }
    const adults = vendorAdults(q); // 1 unless the party check asks for more (a bad value throws here, before any unit)
    return {
      url: ENDPOINT,
      method: "POST",
      // The key is a header only (the one documented way) and never part of the URL or the body.
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      // ONE adult in the vendor's default market: the pipeline scales the price to the party. Self-transfers are excluded up front.
      body: JSON.stringify({
        origin: q.origin,
        destination: q.destination,
        departure_date: q.departDate,
        return_date: q.returnDate,
        adults,
        cabin_class: "economy",
        allow_self_transfer: false,
      }),
    };
  },

  parse(body, q) {
    if (!isRec(body) || !Array.isArray(body.itineraries)) return [];
    // The answer states which airports it is for (the dates are checked per itinerary, in readLeg).
    if (echoDiffers(body.origin, q.origin) || echoDiffers(body.destination, q.destination)) return [];
    const fares: ParsedFare[] = [];
    for (const it of body.itineraries as unknown[]) {
      const fare = readItinerary(it, q);
      if (fare) fares.push(fare);
    }
    return fares;
  },
};

/** The source the pipeline asks. `apiKey` is the IGNAV_API_KEY secret: missing or blank means not configured. */
export function createIgnavSource(opts: { apiKey?: string; fetchFn?: typeof fetch; repo: Repo; now: Date; marker?: string }): FareQuoteSource {
  return createQuoteSource(ignavAdapter, { key: opts.apiKey, repo: opts.repo, now: opts.now, marker: opts.marker, fetchFn: opts.fetchFn });
}
