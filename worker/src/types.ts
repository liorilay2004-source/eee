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
  /**
   * ADDITIVE: when the SOURCE says it saw this fare (Travelpayouts `found_at`), canonical UTC ISO. Absent/null = the source
   * did not say (every Travelpayouts v3 row today). Never filled with our own scan time: that is `checkedAt`.
   */
  fareFoundAt?: string | null;
  /** ADDITIVE: when the SOURCE says the fare expires (Travelpayouts `expires_at`). An expired fare is never ranked. */
  fareExpiresAt?: string | null;
  // Filled by the pipeline (SPEC §7 step 7):
  extrasAmountIls: number;
  totalIls: number | null;
  tags: string[]; // "bonus_checked_bag" | "bag_fee_unknown" | "price_suspicious" (ADDITIVE, priceguard.ts)
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
  source: string; // "bank_of_israel" | "open.er-api.com" | "ecb", with ":stale" when served from an older day
  ratesToIls: Record<string, number>; // 1 unit of CURRENCY = N ILS; always includes ILS: 1
}

/** ADDITIVE: one stored price snapshot as the price guard reads it (prices table columns, amount PER PASSENGER). */
export interface PriceHistoryRow {
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price_amount: number;
  price_currency: string;
  checked_at: string;
}

/** History line from the shared DB, in the ORIGINAL currency (SPEC §4.2, §8). */
export interface PriceContext {
  currency: string;
  weekAgoAmount: number | null;
  lowestAmount: number | null;
}

/**
 * ADDITIVE (WEB_APP_SPEC §7.8 Δ21): why a source did not answer, as a machine code. `error` keeps its developer text.
 *   no_token      the source has no API token configured, so it was not asked
 *   scan_budget   the global upstream budget (GLOBAL_SCAN_LIMIT) is spent, so it was not asked
 *   upstream_down it was asked and at least one request failed (network, HTTP error, auth or quota at the vendor)
 */
export type SourceUnavailableReason = "no_token" | "scan_budget" | "upstream_down";

/** ADDITIVE: how much of the planned Travelpayouts scan was made (the request cap can cut a long window short). */
export interface SourceCoverage {
  /** Upstream requests the scan planned for this search. */
  plannedRequests: number;
  /** Planned requests not made because of the per-search request cap. 0 = the scan covered everything it planned. */
  skippedRequests: number;
  /**
   * Planned requests not made because an earlier request failed with 401/403/429 and the scan stopped (the source then also
   * reports ok: false and reason "upstream_down"). planned - skipped - aborted = requests actually attempted.
   */
  abortedRequests: number;
}

export interface SourceStatus {
  name: SourceName;
  enabled: boolean;
  ok: boolean;
  calls: number;
  offers: number;
  error: string | null;
  /**
   * ADDITIVE (travelpayouts entry only): true when the scan behind these results skipped part of its planned requests, so
   * some dates or airport pairs were not searched. Also true on a cache hit of such a scan. Replaces parsing `error`.
   */
  truncated?: boolean;
  /** ADDITIVE (travelpayouts entry only): the scan's request counts, or null when not known (no scan, or a cache hit of a complete scan). */
  coverage?: SourceCoverage | null;
  /** ADDITIVE (travelpayouts entry only): why the source did not answer, or null when it did (see SourceUnavailableReason). */
  reason?: SourceUnavailableReason | null;
}

/**
 * ADDITIVE: how the fare's age is known. "live" = our own scrape of the live site at checkedAt; "source" = vendor timestamp;
 * "bounded" = a documented vendor cache, only an upper bound (fareAgeMaxMinutes) is known; "unknown" = not stated.
 */
export type FareAgeBasis = "live" | "source" | "bounded" | "unknown";
/** ADDITIVE: fresh < 24h, aging < 72h, stale >= 72h or vendor-expired; "unknown" when the fare's age is not known. */
export type Freshness = "fresh" | "aging" | "stale" | "unknown";
/** ADDITIVE: which sentence CardView.ageLabelHe is. */
export type AgeLabelKey = "fare_found_ago" | "fare_found_within" | "quote_unknown_age" | "cached_fare_unknown_age" | "fare_expired";

export interface CardView extends Card {
  priceContext: PriceContext | null;
  /** Hours since OUR check of the fare (checkedAt). For a cached source this is NOT the fare's age: see fareAgeHours. */
  ageHours: number;
  /**
   * ADDITIVE (WEB_APP_SPEC 7.2 `airlineNames`, gap 7): IATA code -> Hebrew display name for the airlines this card's legs
   * name. Only codes in the bundled table (src/airlines/airlines.json) appear; an unknown code is left out, never guessed.
   */
  airlineNames: Record<string, string>;
  /** ADDITIVE: the same codes with both names and the low-cost flag (see airlines.json for what `lowCost` means). */
  airlines: Record<string, { nameHe: string; nameEn: string; lowCost: boolean }>;
  /** ADDITIVE (freshness.ts): when the fare itself was seen; null = unknown. */
  fareFoundAt: string | null;
  /** ADDITIVE: hours (one decimal) since fareFoundAt; null = unknown. */
  fareAgeHours: number | null;
  /** ADDITIVE: whole minutes since fareFoundAt; null = unknown. */
  fareAgeMinutes: number | null;
  /** ADDITIVE: upper bound on the fare's age in minutes (= fareAgeMinutes when known; the documented bound for "bounded"); null = unknown. */
  fareAgeMaxMinutes: number | null;
  /** ADDITIVE: whole minutes since our own check (checkedAt). */
  scanAgeMinutes: number;
  fareAgeBasis: FareAgeBasis;
  freshness: Freshness;
  /** ADDITIVE: which sentence ageLabelHe is (AgeLabelKey). */
  ageLabelKey: AgeLabelKey;
  /** ADDITIVE: ready Hebrew sentence for the age line (never implies a live check for a cached fare). */
  ageLabelHe: string;
}

/**
 * ADDITIVE (WEB_APP_SPEC §7.2 `meta.recommendations`, bag-cost part only): drives the 💰/⚖️ gating notes (§5.3).
 * `excludedForUnknownBagFee` = offers left out of 💰 because a bag was requested and their bag fee is unknown, counted only
 * when their lower-bound total is below the shown 💰 total (0 when no offer has a known bag cost and the lower bound is shown).
 * Not yet emitted: bestValue `insufficient_data` and the `myTimes` member.
 */
export interface RecommendationsMeta {
  cheapest: { status: "shown" | "no_offers"; excludedForUnknownBagFee: number };
  bestValue: { status: "shown" | "merged" | "bag_cost_unknown" | "no_offers" };
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
    /**
     * ADDITIVE, present ONLY when the answer came from a cache row older than the cache TTL (stale-while-revalidate): the
     * fares are from an older scan. Absent on every other answer, fresh scans and in-TTL cache hits alike.
     */
    stale?: StaleInfo;
    /**
     * ADDITIVE (price guard): Travelpayouts fares found `suspicious` (far below every neighbouring date, or below their own recent
     * history; tagged "price_suspicious"), and how many were kept out of the cards (`excluded`: only those BOTH signals agree on;
     * a fare one signal doubts can still win a card, and carries the tag). `excluded` is 0 when nothing else was priced.
     * Absent when nothing was flagged.
     */
    priceGuard?: { suspicious: number; excluded: number };
    /** ADDITIVE: bag-cost pool gating of the 💰/⚖️ cards (see RecommendationsMeta). */
    recommendations: RecommendationsMeta;
  };
}

/** How old a stale-while-revalidate answer is, and whether a background refresh was started for it. */
export interface StaleInfo {
  /** When the scan behind this answer ran (the cache row's time), canonical UTC ISO. */
  cachedAt: string;
  /** Age of that scan in hours, one decimal. */
  ageHours: number;
  /** True only when this request started a background rescan; the next identical search then gets the fresh fares. */
  revalidating: boolean;
  /** User-facing Hebrew notice saying the results are older (and, when revalidating, to search again shortly). */
  messageHe: string;
}

export interface OneWayFare {
  date: string;
  priceAmount: number; // per adult, as returned by the source
  priceCurrency: string;
  leg: Leg;
  deeplink: string | null;
  /** ADDITIVE: source-stated `found_at` / `expires_at` (canonical UTC ISO); absent = not stated. */
  foundAt?: string | null;
  expiresAt?: string | null;
}

/** Travelpayouts / Aviasales Data API client (SPEC §6: the core engine). Prices are per ONE adult. */
export interface TravelpayoutsClient {
  readonly configured: boolean;
  callCount(): number;
  roundTrips(origin: string, destination: string, windowStart: string, windowEnd: string): Promise<Offer[]>;
  oneWays(origin: string, destination: string, windowStart: string, windowEnd: string): Promise<OneWayFare[]>;
  /**
   * ADDITIVE (optional so existing test doubles still type-check): one request for one (departure month, return month)
   * pair, both "YYYY-MM". Used by the cheapest-dates calendar (src/calendar.ts). Prices are per ONE adult.
   */
  monthRoundTrips?(origin: string, destination: string, departMonth: string, returnMonth: string): Promise<{ offers: Offer[]; truncated: boolean }>;
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
  /**
   * Append to the shared price history (SPEC §12 `prices`). ADDITIVE `opts.skipUnchangedSince` (canonical UTC ISO): a
   * travelpayouts row is NOT written when the newest stored row of the same fare (route, dates, source, structure) is at
   * or after that time and has the same amount and currency (a repeat look inside one deal-detection time bin). Other
   * sources are always written. Without opts every row is written, as before.
   */
  savePrices(offers: Offer[], opts?: { skipUnchangedSince?: string }): Promise<void>;
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
  /**
   * ADDITIVE (price guard, priceguard.ts): the newest stored snapshots (per passenger) of each given date pair checked after
   * `since`, at most `limitPerPair` per pair, in ONE indexed query. Optional: a repo without it simply gives the guard no history.
   */
  priceHistory?(
    pairs: ReadonlyArray<{ origin: string; destination: string; departDate: string; returnDate: string }>,
    since: Date,
    limitPerPair: number,
  ): Promise<PriceHistoryRow[]>;
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
  /**
   * ADDITIVE: claims `key` for the fixed window of `windowSeconds` that `now` falls in (table rate_limits: key + the window's
   * start). True only for the first claim of that window; false for every later one AND on any error (fail closed). A refused
   * claim writes nothing, and the next window is always free again.
   */
  claimWindowLock(key: string, windowSeconds: number, now: Date): Promise<boolean>;
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
