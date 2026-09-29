/**
 * Shared contracts for the Worker. Mirrors engine/tpe/models.py (Python) so both engines
 * produce the same recommendations. Extend additively; do not rename or remove fields.
 *
 * Conventions
 *  - Dates are ISO "YYYY-MM-DD" strings, timestamps are ISO-8601 UTC strings.
 *  - Money: `priceAmount` + `priceCurrency` are ORIGINAL values and are never overwritten (SPEC §4.2).
 *    `totalIls` is computed at comparison time from the original amount + extras.
 *  - Hours are 0-23 local departure hours; a window [start, end) with start > end wraps midnight.
 */

export type TicketStructure = "roundtrip" | "split";
export type SourceName = "travelpayouts" | "google_flights" | "ignav" | "wego" | "searchapi" | "serpapi";
export type Cabin = "economy" | "premium-economy" | "business" | "first";
export type RecKind = "cheapest" | "best_value" | "my_times";

/** One direction of a trip. Unknown values stay null (never guessed). */
export interface Leg {
  departTime: string | null; // "HH:MM" local
  arriveTime: string | null;
  stops: number | null;
  durationMin: number | null;
  airlines: string[]; // IATA airline codes
}

export interface Offer {
  origin: string; // airport IATA
  destination: string;
  departDate: string;
  returnDate: string;
  /** Total for ALL passengers, in the original currency. */
  priceAmount: number;
  priceCurrency: string;
  source: SourceName;
  ticketStructure: TicketStructure;
  outbound: Leg;
  inbound: Leg;
  includes: { checkedBag?: boolean };
  deeplink: string | null; // affiliate booking link (for a split ticket: the OUTBOUND one-way)
  /**
   * ADDITIVE (fix pass): the RETURN one-way's booking link, set only for ticketStructure "split" so the card can
   * offer two buttons. `undefined` on round trips and on splits stored before this field existed.
   */
  returnDeeplink?: string | null;
  verifyLink: string | null;
  checkedAt: string;
  // Filled by the pipeline (SPEC §7 step 7):
  extrasAmountIls: number;
  totalIls: number | null;
  tags: string[]; // "bonus_checked_bag" | "bag_fee_unknown"
}

export interface SearchRequest {
  origin: string; // airport or city IATA (already resolved)
  destination: string;
  windowStart: string;
  windowEnd: string;
  stayMin: number;
  stayMax: number;
  adults: number;
  children: number;
  infants: number;
  cabin: Cabin;
  checkedBag: boolean;
  outHours: [number, number] | null;
  retHours: [number, number] | null;
  maxStops: number | null;
  nearbyAirports: boolean;
}

export interface Card {
  offer: Offer;
  kinds: RecKind[];
  /** Set only when a split ticket beats every round trip (SPEC §16). */
  savingsVsRoundtripIls: number | null;
}

export interface FxRates {
  date: string; // YYYY-MM-DD the rates were fetched for
  source: string; // "bank_of_israel" | "open.er-api.com"
  ratesToIls: Record<string, number>; // 1 unit of CURRENCY = N ILS; always includes ILS: 1
}

/** History line from the shared DB, in the ORIGINAL currency (SPEC §4.2, §8). */
export interface PriceContext {
  currency: string;
  weekAgoAmount: number | null;
  lowestAmount: number | null;
}

export interface SourceStatus {
  name: SourceName;
  enabled: boolean;
  ok: boolean;
  calls: number;
  offers: number;
  error: string | null;
}

export interface CardView extends Card {
  priceContext: PriceContext | null;
  ageHours: number;
  /**
   * ADDITIVE (WEB_APP_SPEC 7.2 `airlineNames`, gap 7): IATA code -> Hebrew display name for the airlines this card's legs
   * name. Only codes in the bundled table (src/airlines/airlines.json) appear; an unknown code is left out, never guessed.
   */
  airlineNames: Record<string, string>;
  /** ADDITIVE: the same codes with both names and the low-cost flag (see airlines.json for what `lowCost` means). */
  airlines: Record<string, { nameHe: string; nameEn: string; lowCost: boolean }>;
}

export interface SearchResponse {
  cards: CardView[];
  meta: {
    /** ADDITIVE: contract version (WEB_APP_SPEC 7.1). */
    apiVersion: 1;
    searchKey: string;
    fromCache: boolean;
    fxSource: string;
    fxDate: string;
    sources: SourceStatus[];
    candidatePairs: number;
    generatedAt: string;
  };
}

export interface OneWayFare {
  date: string;
  priceAmount: number; // per adult, as returned by the source
  priceCurrency: string;
  leg: Leg;
  deeplink: string | null;
}

/** Travelpayouts / Aviasales Data API client (SPEC §6: the core engine). Prices are per ONE adult. */
export interface TravelpayoutsClient {
  readonly configured: boolean;
  callCount(): number;
  roundTrips(origin: string, destination: string, windowStart: string, windowEnd: string): Promise<Offer[]>;
  oneWays(origin: string, destination: string, windowStart: string, windowEnd: string): Promise<OneWayFare[]>;
}

export interface CachedOffers {
  offers: Offer[];
  createdAt: string;
  /** ADDITIVE (fix pass): raw one-way fares, so split tickets are rebuilt for each request's filters. */
  oneWayPairs?: OneWayPair[];
  /** ADDITIVE (fix pass): notes of the scan that produced the row (e.g. truncation), shown again on every hit. */
  notes?: string[];
  /**
   * ADDITIVE: the RAW live quotes (whole party, original currency) the scan that wrote the row got from the optional fare sources.
   * A hit ranks them exactly as that scan did, so a repeat of the search answers the same as the first one. Absent = none.
   */
  quotes?: Offer[];
}

/** ADDITIVE (fix pass): both directions' one-way fares (per adult, original currency) of one airport pair. */
export interface OneWayPair {
  origin: string;
  destination: string;
  outs: OneWayFare[];
  backs: OneWayFare[];
}

/** Persistence layer over D1. */
export interface Repo {
  getCachedOffers(searchKey: string, maxAgeHours: number, now: Date): Promise<CachedOffers | null>;
  /** `extra` is ADDITIVE (fix pass): one-way fares + scan notes stored beside the offers. */
  putCachedOffers(searchKey: string, offers: Offer[], now: Date, extra?: { oneWayPairs: OneWayPair[]; notes: string[]; quotes?: Offer[] }): Promise<void>;
  /** Append to the shared price history (SPEC §12 `prices`). */
  savePrices(offers: Offer[]): Promise<void>;
  /** Recent offers already in the shared DB (e.g. written by the background monitor). */
  loadRecentOffers(
    origin: string,
    destination: string,
    departFrom: string,
    returnTo: string,
    maxAgeHours: number,
    now: Date,
    sources?: SourceName[],
  ): Promise<Offer[]>;
  priceContext(origin: string, destination: string, departDate: string, returnDate: string, now: Date): Promise<PriceContext | null>;
  saveSearch(req: SearchRequest, searchKey: string, now: Date): Promise<void>;
  getFxRates(date: string): Promise<FxRates | null>;
  saveFxRates(fx: FxRates): Promise<void>;
  /** Added by db agent: newest stored FX day of any date, the last-resort "stale" source (SPEC §4.2). */
  getLatestFxRates(): Promise<FxRates | null>;
  checkRateLimit(key: string, limit: number, windowSeconds: number, now: Date): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }>;
  recordSourceHealth(source: SourceName, ok: boolean, error: string | null, now: Date): Promise<void>;
  /**
   * ADDITIVE: reserves ONE request of a vendor's free allowance (table source_quota). True only when this call
   * raised the counter and the new value is <= cap; false when the cap is reached AND on any error (fail closed).
   * `period` is "lifetime" or a UTC month like "2026-09" (see quotaPeriodKey in quotes.ts).
   */
  reserveQuota(source: SourceName, period: string, cap: number, now: Date): Promise<boolean>;
  /**
   * ADDITIVE: reserves ONE unit of a per-UTC-day share (table rate_limits: `key` + the day's start). True only when this call raised
   * the day's counter and the new value is <= cap; false when the share is spent AND on any error (fail closed). See withDailyShare.
   */
  reserveDaily(key: string, cap: number, now: Date): Promise<boolean>;
}

export interface Env {
  DB: D1Database;
  TRAVELPAYOUTS_TOKEN?: string;
  TRAVELPAYOUTS_MARKER?: string;
  ALLOWED_ORIGIN?: string; // CORS allow-origin for the Pages frontend
  /** Secret salt for hashing client addresses in rate limiting; without it a value derived from the Travelpayouts token is used (see ratelimit.ts). */
  RATE_LIMIT_SALT?: string;
  /** Optional live fare sources (quotes.ts): no key = not configured = never called, never counted. */
  IGNAV_API_KEY?: string;
  WEGO_API_TOKEN?: string;
  SEARCHAPI_KEY?: string;
  SERPAPI_KEY?: string;
}
