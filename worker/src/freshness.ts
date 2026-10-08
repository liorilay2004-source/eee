/**
 * How old is the FARE (not our scan of it)? CardView.ageHours is the age of OUR read of a fare: for a
 * Travelpayouts row it says when we fetched the vendor's cache, not when the vendor last saw that price.
 * These helpers say what is actually known about the fare's own age, and nothing more (SPEC P1: never guess):
 *
 *  - "live":    the fare was seen at `checkedAt` by our own scrape of the live site (the Google Flights monitor only).
 *  - "bounded": a search API that documents a result cache of at most N minutes (SerpApi: "Cache expires after 1h", and
 *               `no_cache` is not sent): the fare is at most scan age + N old. Only that upper bound is claimed.
 *  - quote vendors that promise no freshness and document no cache (Ignav, Wego, SearchApi, Duffel, HasData) are "unknown": the time of
 *    OUR search is known, the fare's own age is not, and the label says exactly that.
 *  - "source":  the vendor stated when it saw the fare (`found_at` on a Travelpayouts row). The v3 `prices_for_dates`
 *               endpoint we use does NOT send it today (verified only against third-party copies of its field list,
 *               the vendor's own help page was unreachable); v2 endpoints such as `prices/latest` do. Parsed
 *               defensively in case it appears, so a vendor change becomes visible without a code change.
 *  - "unknown": a cached fare without a vendor timestamp (every Travelpayouts fare today). The vendor documents a
 *               2-7 day cache, but a specific fare's age is not known, so no age is claimed.
 *
 * Vendor-stated expiry (`expires_at`) is honoured: the vendor advises against using expired prices, so an expired
 * fare is never ranked (see fareExpired and the pipeline).
 */
import type { AgeLabelKey, FareAgeBasis, Freshness, Offer, SourceName } from "./types";

/** A known fare age below this is "fresh". */
export const FARE_FRESH_MAX_HOURS = 24;
/** ...below this "aging", from here on "stale". */
export const FARE_AGING_MAX_HOURS = 72;
/** A vendor clock may run slightly ahead of ours; a `found_at` further in the future than this is not believed. */
export const FOUND_AT_MAX_SKEW_MS = 5 * 60_000;

/** Sources whose fare was seen at `checkedAt` by our own scrape of the live site. Travelpayouts is a cache: never here. */
export const LIVE_FARE_SOURCES: readonly SourceName[] = ["google_flights"];

/**
 * Documented upper bound of a vendor's result cache, in minutes. SerpApi (https://serpapi.com/search-api): "Cache expires
 * after 1h"; serpapi.ts does not send `no_cache`, so an answer may be up to an hour old when we get it.
 */
export const VENDOR_CACHE_MAX_MINUTES: Readonly<Partial<Record<SourceName, number>>> = { serpapi: 60 };

/**
 * Live search APIs that neither promise freshness nor document a cache. Must stay in step with QUOTE_SOURCE_NAMES
 * (quotes.ts; not imported here, to keep travelpayouts.ts free of an import cycle) minus VENDOR_CACHE_MAX_MINUTES (tested).
 */
export const UNSTATED_AGE_QUOTE_SOURCES: readonly SourceName[] = ["ignav", "wego", "searchapi", "duffel", "hasdata", "ryanair", "aegean", "air_canada", "tap", "ethiopian", "air_europa", "philippine", "virgin_atlantic", "air_new_zealand", "air_baltic", "sky_express", "gol", "aeromexico", "copa", "klm", "american", "aer_lingus", "air_serbia", "elal", "direct_combination"];

/** ISO date-time WITH an explicit zone ("Z" or "+HH:MM"): a zoneless time would have to be guessed. */
const ZONED_ISO = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A vendor timestamp as canonical UTC ISO, or null when it is missing, malformed, zoneless, or (with `notAfterMs`)
 * later than that instant plus a small clock skew.
 */
export function vendorTimestamp(v: unknown, notAfterMs?: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const g = ZONED_ISO.exec(s);
  if (!g) return null;
  // Date.parse rolls impossible dates over (Feb 30 -> Mar 2): check the calendar date first.
  const y = Number(g[1]);
  const m = Number(g[2]);
  const d = Number(g[3]);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  if (notAfterMs !== undefined && ms > notAfterMs + FOUND_AT_MAX_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** The older of two timestamps; null when either is unknown (a split is only as known as its least-known leg). */
export function olderOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b) return null;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The earlier of two expiries; a known one wins over an unknown one (either ticket expiring breaks the pair). */
export function earlierOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** True only when the vendor stated an expiry and it has passed. */
export function fareExpired(o: Pick<Offer, "fareExpiresAt">, now: Date): boolean {
  if (!o.fareExpiresAt) return false;
  const ms = Date.parse(o.fareExpiresAt);
  return Number.isFinite(ms) && ms <= now.getTime();
}

export interface FareFreshness {
  /** When the fare itself was seen, as far as known; null = unknown (never filled with our scan time). */
  fareFoundAt: string | null;
  /** Hours since fareFoundAt (one decimal); null when unknown. */
  fareAgeHours: number | null;
  /** Whole minutes since fareFoundAt; null when unknown. */
  fareAgeMinutes: number | null;
  /** Upper bound on the fare's age in whole minutes: = fareAgeMinutes when that is known, the documented bound for "bounded", else null. */
  fareAgeMaxMinutes: number | null;
  /** Whole minutes since OUR check (`checkedAt`): how old our read is, NOT how old the fare is (see fareAgeBasis). */
  scanAgeMinutes: number;
  fareAgeBasis: FareAgeBasis;
  freshness: Freshness;
  /** Which sentence ageLabelHe is, for a UI that keeps its own copy. */
  ageLabelKey: AgeLabelKey;
  /** Ready Hebrew sentence. For a fare of unknown age it says so and never presents our read as a live check. */
  ageLabelHe: string;
}

const minutesSince = (iso: string, now: Date): number | null => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
};

const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;

export function classifyAge(hours: number): Exclude<Freshness, "unknown"> {
  if (hours < FARE_FRESH_MAX_HOURS) return "fresh";
  if (hours < FARE_AGING_MAX_HOURS) return "aging";
  return "stale";
}

/** "לפני 5 דקות", "לפני שעה", "לפני 3 ימים"... ("ממש עכשיו" under a minute). Whole units, rounded down. */
export function hebrewAgo(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "ממש עכשיו";
  if (m < 60) return m === 1 ? "לפני דקה" : m === 2 ? "לפני שתי דקות" : `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "לפני שעה" : h === 2 ? "לפני שעתיים" : `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  return d === 1 ? "לפני יום" : d === 2 ? "לפני יומיים" : `לפני ${d} ימים`;
}

const EXPIRED_HE = "תוקף המחיר פג לפי מקור הנתונים";

/** What is known about the age of an offer's fare at `now`. */
export function fareFreshness(o: Offer, now: Date): FareFreshness {
  const scanMinutes = minutesSince(o.checkedAt, now);
  const scanAgeMinutes = scanMinutes ?? 0;
  const expired = fareExpired(o, now);
  const unknown = (ageLabelKey: AgeLabelKey, ageLabelHe: string): FareFreshness => ({
    fareFoundAt: null,
    fareAgeHours: null,
    fareAgeMinutes: null,
    fareAgeMaxMinutes: null,
    scanAgeMinutes,
    fareAgeBasis: "unknown",
    freshness: expired ? "stale" : "unknown",
    ageLabelKey: expired ? "fare_expired" : ageLabelKey,
    ageLabelHe: expired ? EXPIRED_HE : ageLabelHe,
  });

  // 1. A time stated by the source, or 2. our own scrape of the live site: the fare's age is known.
  const foundAt = o.fareFoundAt ? o.fareFoundAt : LIVE_FARE_SOURCES.includes(o.source) ? o.checkedAt : null;
  const fareMinutes = foundAt === null ? null : minutesSince(foundAt, now);
  if (foundAt !== null && fareMinutes !== null) {
    return {
      fareFoundAt: foundAt,
      fareAgeHours: hoursOf(fareMinutes),
      fareAgeMinutes: fareMinutes,
      fareAgeMaxMinutes: fareMinutes,
      scanAgeMinutes,
      fareAgeBasis: o.fareFoundAt ? "source" : "live",
      freshness: expired ? "stale" : classifyAge(hoursOf(fareMinutes)),
      ageLabelKey: expired ? "fare_expired" : "fare_found_ago",
      ageLabelHe: expired ? EXPIRED_HE : `המחיר נמצא ${hebrewAgo(fareMinutes)}`,
    };
  }

  // 3. A documented vendor cache: only an upper bound (our search's age + the cache's maximum) is claimed.
  const bound = VENDOR_CACHE_MAX_MINUTES[o.source];
  if (bound !== undefined && scanMinutes !== null) {
    const max = scanMinutes + bound;
    return {
      fareFoundAt: null,
      fareAgeHours: null,
      fareAgeMinutes: null,
      fareAgeMaxMinutes: max,
      scanAgeMinutes,
      fareAgeBasis: "bounded",
      freshness: expired ? "stale" : classifyAge(hoursOf(max)),
      ageLabelKey: expired ? "fare_expired" : "fare_found_within",
      ageLabelHe: expired ? EXPIRED_HE : `המחיר נמצא ${hebrewAgo(max)} לכל היותר`,
    };
  }

  // 4. A search API that states nothing about the fare's age: our search time only.
  if (UNSTATED_AGE_QUOTE_SOURCES.includes(o.source) || bound !== undefined) {
    return unknown("quote_unknown_age", `מחיר מחיפוש שבוצע ${hebrewAgo(scanAgeMinutes)}. מקור הנתונים אינו מציין מתי נמצא המחיר עצמו.`);
  }
  // 5. A cached fare without a timestamp (every Travelpayouts fare today).
  return unknown("cached_fare_unknown_age", `מחיר שמור ממאגר מחירים, נשלף ${hebrewAgo(scanAgeMinutes)}. מתי נמצא המחיר עצמו לא ידוע, וייתכן שהשתנה.`);
}
