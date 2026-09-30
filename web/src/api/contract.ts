export type {
  CardView,
  Leg,
  Offer,
  RecKind,
  SearchRequest,
  SearchResponse,
  SourceStatus,
  StaleInfo,
} from "../../../worker/src/types";

import type { SearchRequest } from "../../../worker/src/types";

export interface AirportSuggestion {
  code: string;
  nameHe: string | null;
  nameEn: string | null;
  countryCode: string;
  kind: "city" | "airport";
  airportCode?: string;
  airportNameHe?: string;
  airportNameEn?: string;
  airports: string[];
}

export interface ApiError {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
    retryAfterSec?: number;
  };
}

/*
 * The shapes below mirror the Worker's newer endpoint modules. They are copied (types only) rather than imported,
 * because those modules pull in Worker-only code that the web app's stricter compiler settings do not accept.
 * Keep them in sync with the named source when the Worker changes (all Worker changes are additive).
 */

/** worker/src/explore-text.ts NightsRange */
export interface NightsRange { min: number; max: number }

/** worker/src/explore.ts ScoreBreakdown */
export interface ExploreScore {
  total: number;
  price: number;
  weather: number | null;
  attractiveness: number | null;
  flightTime: number | null;
  weights: { price: number; weather: number; attractiveness: number; flightTime: number };
}

/** worker/src/explore.ts ExploreResult */
export interface ExploreResult {
  destination: { code: string; nameHe: string | null; nameEn: string | null; countryCode: string | null; category: "beach" | "city" | "ski" | "nature" | null };
  departDate: string;
  returnDate: string;
  nights: number;
  price: { amount: number; currency: "USD"; ils: number };
  stops: number | null;
  departTime: string | null;
  foundAt: string | null;
  expiresAt: string | null;
  links: { book: string | null };
  search: { origin: string; destination: string; windowStart: string; windowEnd: string; stayMin: number; stayMax: number };
  score: ExploreScore;
  climate: { month: number; tmaxC: number; rainDays: number; approximate: true } | null;
}

export interface ExploreUnderstood {
  text: string;
  nights: NightsRange | null;
  month: string | null;
  missing: ("nights" | "month")[];
  message: string | null;
}

/** worker/src/explore.ts ExploreResponse */
export interface ExploreResponse {
  results: ExploreResult[];
  meta: {
    origin: { code: string; nameHe: string | null };
    window: { start: string; end: string };
    nights: NightsRange | null;
    maxPriceIls: number | null;
    sort: "price" | "score";
    understood: ExploreUnderstood | null;
    destinationsFound: number;
    destinationsMatching: number;
    cached: boolean;
    stale: boolean;
    partial: boolean;
    checkedAt: string;
    sources: string[];
    fx: { date: string; source: string };
    climateSource: string;
    notes: string[];
  };
}

export type CalendarLevel = "low" | "mid" | "high";

/** worker/src/calendar.ts CalendarDay */
export interface CalendarDay {
  date: string;
  known: boolean;
  fare: {
    priceIls: number;
    priceAmount: number;
    priceCurrency: string;
    returnDate: string;
    nights: number;
    stops: number | null;
    returnStops: number | null;
    airlines: string[];
    departTime: string | null;
    returnTime: string | null;
    deeplink: string | null;
    checkedAt: string;
    level: CalendarLevel | null;
  } | null;
}

/** worker/src/calendar.ts CalendarResponse */
export interface CalendarResponse {
  days: CalendarDay[];
  meta: {
    apiVersion: 1;
    origin: string;
    destination: string;
    minNights: number;
    maxNights: number;
    maxStops: number | null;
    priceBasis: "roundtrip_one_adult";
    months: { month: string; status: "cached" | "fresh" | "stale" | "failed" | "busy" | "unavailable"; checkedAt: string | null; truncated: boolean }[];
    fromCache: boolean;
    upstreamCalls: number;
    cheapest: { date: string; priceIls: number } | null;
    fxSource: string;
    fxDate: string;
    source: "travelpayouts";
    noticeHe: string;
    unavailableHe?: string;
    generatedAt: string;
  };
}

/** worker/src/dealreports.ts RouteDealStatus */
export type RouteDealStatus = "not_computed" | "stale" | "deals" | "no_deal" | "insufficient_data" | "no_recent_data";

/** worker/src/deals.ts Deal, plus the fields routeView adds */
export interface RouteDeal {
  verdict: "deal" | "error_fare";
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  ticketStructure: string;
  source: string;
  airlines: string[];
  priceAmount: number;
  priceCurrency: string;
  priceIls: number;
  dropPct: number;
  checkedAt: string;
  bucket: string;
  evidence: { baselineIls: number; madIls: number; robustZ: number; sampleSize: number; spanDays: number };
  reason: string;
  ageHours: number;
  labelHe: string;
}

/** worker/src/dealreports.ts RouteDealsView */
export interface RouteDealsView {
  origin: string;
  destination: string;
  status: RouteDealStatus;
  labelHe: string;
  computedAt: string | null;
  deals: RouteDeal[];
  buckets: { total: number; judged: number; insufficient: number; stale: number } | null;
  readiness: { sampleSize: number; spanDays: number } | null;
  truncated: boolean;
  fx: { date: string; source: string; stale: boolean } | null;
}

/** worker/src/dealreports.ts DealsResponse */
export interface DealsResponse {
  asOf: string;
  priceBasis: "per_traveller";
  noteHe: string;
  thresholds: { dealDropPct: number; errorDropPct: number; minSamples: number; minSpanDays: number; minDistinctDays: number; liveWithinHours: number };
  routes: RouteDealsView[];
}

/** worker/src/watches.ts WatchView */
export interface WatchView {
  status: "pending" | "active" | "expired";
  telegramLinked: boolean;
  origin: string;
  destination: string;
  windowStart: string;
  windowEnd: string;
  stayMin: number;
  stayMax: number;
  adults: number;
  children: number;
  infants: number;
  checkedBag: boolean;
  targetPriceIls: number | null;
  dropPct: number;
  createdAt: string | null;
  expiresAt: string;
  lastCheckedAt: string | null;
  lastPriceIls: number | null;
  lastPriceCheckedAt: string | null;
  baselinePriceIls: number | null;
  lastAlertAt: string | null;
}

/** POST /api/watches body: exactly the search body plus the optional alert rules. */
export type CreateWatchRequest = SearchRequest & { targetPriceIls?: number; dropPct?: number };

/** POST /api/watches 201 */
export interface CreateWatchResponse {
  token: string;
  telegramLink: string;
  watch: WatchView;
}

/** GET /api/watches/<token> 200 */
export interface GetWatchResponse {
  watch: WatchView;
  telegramLink?: string;
}
