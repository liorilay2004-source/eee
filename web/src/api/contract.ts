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

/** One airport of a country suggestion (mirrors worker/src/countries/search.ts CountryAirport). */
export interface CountryAirport {
  code: string;
  cityCode: string;
  nameHe: string | null;
  nameEn: string;
  direct: boolean;
}

/**
 * A country in the destination autocomplete ("יוון" -> Greece's airports, best first). Sent by newer Workers in a
 * separate `countries` array next to `results`; older Workers omit it, so the web treats it as optional.
 */
export interface CountrySuggestion {
  type: "country";
  code: string;
  nameHe: string;
  nameEn: string | null;
  match?: "exact" | "partial";
  airports: string[];
  places: CountryAirport[];
}

export interface AirportLookup {
  results: AirportSuggestion[];
  countries: CountrySuggestion[];
}

export interface ApiError {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
    retryAfterSec?: number;
    /** Additive: a machine detail, e.g. why the access lock is misconfigured ("too_short"). Older APIs never send it. */
    reason?: string;
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
  /** countryHe: Hebrew country name (Unicode CLDR). Optional only for older Worker deploys. */
  destination: { code: string; nameHe: string | null; nameEn: string | null; countryCode: string | null; countryHe?: string | null; category: "beach" | "city" | "ski" | "nature" | null };
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
  /**
   * Israeli holidays between departDate and returnDate, distinct Hebrew names in date order (e.g. "סוכות, שמיני עצרת");
   * null when none is known. Optional here only so an older Worker deploy (without the field) still type-checks.
   */
  holidayHe?: string | null;
  /** Sunday-Thursday work days the trip takes off (yom tov not counted); null when unknown. */
  vacationDaysUsed?: number | null;
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
    /** Credit for results[].holidayHe and vacationDaysUsed: "Hebcal.com, CC BY 4.0". */
    holidaysAttribution?: string;
    /** Credit for results[].destination.countryHe: "Unicode CLDR, Unicode License V3". Optional only for older Worker deploys. */
    countriesAttribution?: string;
  };
}

export type CalendarLevel = "low" | "mid" | "high";

/** worker/src/calendar.ts CalendarDay */
export interface CalendarDay {
  date: string;
  known: boolean;
  /** Israeli holiday(s) on this day in Hebrew, e.g. "פסח א׳". Absent on a day without a holiday. */
  holidayHe?: string;
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

/** worker/src/calendar-insights.ts CalendarInsights */
export interface CalendarInsights {
  /** Per departure weekday (0 = Sunday .. 6 = Saturday), sorted 0..6; empty weekdays omitted. */
  byWeekday: { weekday: number; minIls: number; medianIls: number; count: number }[];
  /** Per trip length in nights, ascending; only lengths seen at least twice. */
  byNights: { nights: number; minIls: number; count: number }[];
  cheapestWeekday: number;
  cheapestNights: number | null;
  /** Present only when the saving is meaningful; absent otherwise (never 0). */
  savingVsDearestWeekdayPct?: number;
  summaryHe: string;
  labelHe: string;
  basis: "cached_fares";
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
    /** Cheapest departure weekday and trip length; absent when there is too little data. Not a guarantee. */
    insights?: CalendarInsights;
    fxSource: string;
    fxDate: string;
    source: "travelpayouts";
    noticeHe: string;
    /** Credit for the days' holidayHe: "Hebcal.com, CC BY 4.0". Optional only for older Worker deploys. */
    holidaysAttribution?: string;
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
