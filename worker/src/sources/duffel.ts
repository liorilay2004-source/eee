/**
 * Duffel (https://duffel.com) as an optional LIVE fare source.
 *
 * Official docs used on 2026-09-30:
 *  - Offer requests: POST /air/offer_requests creates a search and, by default, returns offers. We pass
 *    return_offers=true and a supplier_timeout below the Worker request timeout.
 *    https://duffel.com/docs/api/v2/offer-requests
 *  - Requests require Authorization: Bearer and Duffel-Version: v2.
 *    https://duffel.com/docs/api/overview/making-requests/versioning
 *  - Offer total_amount is the total price for all passengers and expires_at is the offer expiry.
 *    https://duffel.com/docs/api/v2/offers
 *
 * Safety: Duffel live searches can become billable depending on account commercial terms. This source is configured by
 * default only with a test-mode token (`duffel_test_...`). A live token (`duffel_live_...`) needs DUFFEL_ALLOW_LIVE=true in
 * the Worker environment; otherwise the source is inert and spends no quota. No token or vendor body is ever returned.
 */
import { createQuoteSource, vendorAdults, type FareQuoteSource, type ParsedFare, type QuoteAdapter, type QuotaSpec, type QuoteQuery } from "../quotes";
import type { Leg, Repo } from "../types";

// Internal throttle for Duffel test mode/live-gated mode. It is deliberately tiny until a commercial agreement is explicit.
export const DUFFEL_QUOTA: QuotaSpec = { period: "lifetime", cap: 9, allowance: 10 };

const ENDPOINT = "https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=10000&view=offers";
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^[A-Z]{3}$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const upper = (v: unknown): string | null => {
  const s = str(v)?.toUpperCase() ?? null;
  return s && s !== "N/A" ? s : null;
};

function money(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hhmm(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?/.exec(s) : null;
  return m && m[1] && m[2] ? `${m[1]}:${m[2]}` : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  return m && m[1] ? m[1] : null;
}

function iataOf(place: unknown): string | null {
  return isRec(place) && typeof place.iata_code === "string" ? place.iata_code.trim().toUpperCase() : null;
}

function carrierOf(segment: Rec): string | null {
  const marketing = isRec(segment.marketing_carrier) ? upper(segment.marketing_carrier.iata_code) : null;
  const operating = isRec(segment.operating_carrier) ? upper(segment.operating_carrier.iata_code) : null;
  return marketing ?? operating;
}

function parseDurationMin(v: unknown): number | null {
  const s = str(v);
  const m = s ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/i.exec(s) : null;
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const total = days * 1440 + hours * 60 + mins;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function readLeg(slice: unknown, expectedOrigin: string, expectedDestination: string, expectedDate: string): Leg | null {
  if (!isRec(slice)) return null;
  const segments = arr(slice.segments).filter(isRec);
  if (segments.length === 0) return null;
  const first = segments[0] as Rec;
  const last = segments[segments.length - 1] as Rec;
  const origin = iataOf(first.origin ?? slice.origin);
  const destination = iataOf(last.destination ?? slice.destination);
  if (origin && origin !== expectedOrigin) return null;
  if (destination && destination !== expectedDestination) return null;
  const departingAt = str(first.departing_at);
  if (departingAt && isoDate(departingAt) !== expectedDate) return null;
  const airlines = [...new Set(segments.map(carrierOf).filter((v): v is string => !!v && /^[A-Z0-9]{2}$/.test(v)))];
  return {
    departTime: hhmm(first.departing_at),
    arriveTime: hhmm(last.arriving_at),
    stops: Math.max(0, segments.length - 1),
    durationMin: parseDurationMin(slice.duration),
    airlines,
  };
}

function checkedBagIncluded(offer: Rec): boolean | undefined {
  let saw = false;
  for (const slice of arr(offer.slices)) {
    if (!isRec(slice)) continue;
    for (const seg of arr(slice.segments)) {
      if (!isRec(seg)) continue;
      for (const p of arr(seg.passengers)) {
        if (!isRec(p)) continue;
        const rawBags = p.baggages;
        const bags = arr(rawBags).filter(isRec);
        if (bags.some((b) => str(b.type)?.toLowerCase() === "checked" && typeof b.quantity === "number" && b.quantity > 0)) return true;
        if (Array.isArray(rawBags)) saw = true;
      }
    }
  }
  return saw ? false : undefined;
}

function flightKeyOf(outbound: Leg, inbound: Leg): string | null {
  const outCarrier = outbound.airlines.join("+");
  const inCarrier = inbound.airlines.join("+");
  const parts = [outCarrier, outbound.departTime, inbound.departTime, inCarrier];
  return parts.every((p) => p) ? parts.join("|") : null;
}

function readFare(offer: unknown, q: QuoteQuery): ParsedFare | null {
  if (!isRec(offer)) return null;
  if (offer.partial === true) return null;
  const price = money(offer.total_amount);
  const currency = upper(offer.total_currency);
  if (!price || !currency || !MONEY.test(currency)) return null;
  const slices = arr(offer.slices);
  if (slices.length !== 2) return null;
  const outbound = readLeg(slices[0], q.origin, q.destination, q.departDate);
  const inbound = readLeg(slices[1], q.destination, q.origin, q.returnDate);
  if (!outbound || !inbound) return null;
  return { price, currency, outbound, inbound, checkedBag: checkedBagIncluded(offer), flightKey: flightKeyOf(outbound, inbound) };
}

function passengerList(q: QuoteQuery): Array<{ type: "adult" }> {
  return Array.from({ length: vendorAdults(q) }, () => ({ type: "adult" as const }));
}

function validTokenForUse(key: string, allowLive: boolean): boolean {
  if (key.startsWith("duffel_test_")) return true;
  if (allowLive && key.startsWith("duffel_live_")) return true;
  // Some older dashboard tokens do not use the prefix in examples; keep them inert unless live use is explicit.
  return allowLive && key.length >= 20 && !key.includes(" ");
}

export const duffelAdapter: QuoteAdapter = {
  name: "duffel",
  quota: DUFFEL_QUOTA,
  // Duffel documents total_amount as the total for all passengers.
  partyPricing: "total",

  request(q, key) {
    const origin = q.origin.trim().toUpperCase();
    const destination = q.destination.trim().toUpperCase();
    if (!IATA.test(origin) || !IATA.test(destination) || !DATE.test(q.departDate) || !DATE.test(q.returnDate)) throw new RangeError("duffel: invalid route or date");
    const body = {
      data: {
        slices: [
          { origin, destination, departure_date: q.departDate },
          { origin: destination, destination: origin, departure_date: q.returnDate },
        ],
        passengers: passengerList(q),
        cabin_class: "economy",
      },
    };
    return {
      url: ENDPOINT,
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Duffel-Version": "v2" },
      body: JSON.stringify(body),
    };
  },

  parse(body, q) {
    if (!isRec(body) || !isRec(body.data) || !Array.isArray(body.data.offers)) return [];
    const fares: ParsedFare[] = [];
    for (const offer of body.data.offers) {
      const fare = readFare(offer, q);
      if (fare) fares.push(fare);
    }
    return fares;
  },
};

export function createDuffelSource(opts: { apiToken?: string; allowLive?: boolean; fetchFn?: typeof fetch; repo: Repo; now: Date; marker?: string }): FareQuoteSource {
  const raw = (opts.apiToken ?? "").trim();
  const key = validTokenForUse(raw, opts.allowLive === true) ? raw : "";
  return createQuoteSource(duffelAdapter, { key, repo: opts.repo, now: opts.now, marker: opts.marker, fetchFn: opts.fetchFn });
}
