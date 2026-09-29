/**
 * How old is the FARE (not our scan of it)? CardView.ageHours is the age of OUR read of a fare: for a
 * Travelpayouts row it says when we fetched the vendor's cache, not when the vendor last saw that price.
 * These helpers say what is actually known about the fare's own age, and nothing more (SPEC P1: never guess):
 *
 *  - "live":    the fare comes from a live search (the Google Flights monitor or a live quote vendor, see quotes.ts),
 *               so it was seen at `checkedAt`: the fare's age IS the check's age.
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

/**
 * Sources whose fares come from a live search at `checkedAt`. Must stay in step with QUOTE_SOURCE_NAMES (quotes.ts;
 * not imported here to keep travelpayouts.ts free of an import cycle) plus the google_flights monitor. Travelpayouts is
 * a cache and is never on this list.
 */
export const LIVE_FARE_SOURCES: readonly SourceName[] = ["google_flights", "ignav", "wego", "searchapi", "serpapi"];

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

/** What is known about the age of an offer's fare at `now`. */
export function fareFreshness(o: Offer, now: Date): FareFreshness {
  let foundAt: string | null = null;
  let basis: FareAgeBasis = "unknown";
  if (o.fareFoundAt) {
    foundAt = o.fareFoundAt;
    basis = "source";
  } else if (LIVE_FARE_SOURCES.includes(o.source)) {
    foundAt = o.checkedAt;
    basis = "live";
  }
  const scanAgeMinutes = minutesSince(o.checkedAt, now) ?? 0;
  const fareMinutes = foundAt === null ? null : minutesSince(foundAt, now);
  const expired = fareExpired(o, now);
  if (fareMinutes === null || foundAt === null) {
    return {
      fareFoundAt: null,
      fareAgeHours: null,
      fareAgeMinutes: null,
      scanAgeMinutes,
      fareAgeBasis: "unknown",
      freshness: expired ? "stale" : "unknown",
      ageLabelKey: expired ? "fare_expired" : "cached_fare_unknown_age",
      ageLabelHe: expired
        ? "תוקף המחיר פג לפי מקור הנתונים"
        : `מחיר שמור ממאגר מחירים, נשלף ${hebrewAgo(scanAgeMinutes)}. מתי נמצא המחיר עצמו לא ידוע, וייתכן שהשתנה.`,
    };
  }
  const hours = hoursOf(fareMinutes);
  return {
    fareFoundAt: foundAt,
    fareAgeHours: hours,
    fareAgeMinutes: fareMinutes,
    scanAgeMinutes,
    fareAgeBasis: basis,
    freshness: expired ? "stale" : classifyAge(hours),
    ageLabelKey: expired ? "fare_expired" : "fare_found_ago",
    ageLabelHe: expired ? "תוקף המחיר פג לפי מקור הנתונים" : `המחיר נמצא ${hebrewAgo(fareMinutes)}`,
  };
}
