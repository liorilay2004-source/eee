/**
 * /api/calendar meta.insights: "which departure weekday and which trip length are cheapest", computed from the fares
 * runCalendar already holds for the response. Pure: no I/O, no clock, no network, never mutates its inputs, never
 * throws (any error -> null). Zero extra subrequests and zero extra D1 work; O(fares) plus small sorts.
 *
 * Honesty: the numbers come from the source's cached fares (often 2-7 days old) of THIS response only, so labelHe and
 * basis always travel with them, and the UI must never phrase them as a guarantee (docs/WEB_APP_SPEC.md §7.9).
 */
import type { CalendarDay } from "./calendar";

/** One fitting fare (after the nights, stops and FX filters of the request), in ILS, per ONE adult round trip. */
export type InsightFare = { departDate: string; nights: number; priceIls: number };

/** Hebrew weekday short names, indexed by Date#getUTCDay (0 = Sunday). The geresh is U+05F3. */
export const WEEKDAY_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "שבת"] as const;

export const INSIGHTS_LABEL_HE = "לפי מחירים שנמצאו לאחרונה (מטמון, 2-7 ימים)";

/** Buckets needed with count >= 2 before any insight is returned. */
export const INSIGHTS_MIN_BUCKETS = 4;
/** A weekday saving below this percentage is not worth a claim: the key is then absent (never 0). */
export const INSIGHTS_MIN_SAVING_PCT = 3;

export interface CalendarInsights {
  /** Per departure weekday (0 = Sunday .. 6 = Saturday, UTC-based), sorted 0..6; empty weekdays are omitted. */
  byWeekday: { weekday: number; minIls: number; medianIls: number; count: number }[];
  /** Per trip length in nights, sorted ascending; only lengths seen at least twice. */
  byNights: { nights: number; minIls: number; count: number }[];
  cheapestWeekday: number;
  cheapestNights: number | null;
  /** Present only when the saving is at least INSIGHTS_MIN_SAVING_PCT; ABSENT otherwise (never 0). */
  savingVsDearestWeekdayPct?: number;
  summaryHe: string;
  labelHe: typeof INSIGHTS_LABEL_HE;
  basis: "cached_fares";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const WEEKDAY_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;
const cache = new WeakMap<object, WeakMap<object, CalendarInsights | null>>();

function cloneInsights(v: CalendarInsights | null): CalendarInsights | null {
  return v
    ? {
      ...v,
      byWeekday: v.byWeekday.map((x) => ({ ...x })),
      byNights: v.byNights.map((x) => ({ ...x })),
    }
    : null;
}

function cached(days: readonly CalendarDay[], fitting: readonly InsightFare[]): { hit: true; value: CalendarInsights | null } | { hit: false } {
  const inner = cache.get(days as object);
  return inner?.has(fitting as object) ? { hit: true, value: inner.get(fitting as object) ?? null } : { hit: false };
}

function remember(days: readonly CalendarDay[], fitting: readonly InsightFare[], value: CalendarInsights | null): CalendarInsights | null {
  let inner = cache.get(days as object);
  if (!inner) {
    inner = new WeakMap<object, CalendarInsights | null>();
    cache.set(days as object, inner);
  }
  inner.set(fitting as object, value);
  return cloneInsights(value);
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** 0..6 for a YYYY-MM-DD date (UTC, so independent of the process time zone), or null when malformed. */
function weekdayOf(date: unknown): number | null {
  if (typeof date !== "string" || !DAY_RE.test(date)) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const max = month === 2 && leapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (!max || day < 1 || day > max) return null;
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + (WEEKDAY_OFFSETS[month - 1] as number) + day) % 7;
}

const validPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Median rule (pinned): sort ascending; an odd count takes the middle value; an even count takes the mean of the two
 * middle values; the result is always Math.round-ed, so it is an integer ILS. Sorts a copy, never the argument.
 */
export function medianIls(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return medianSorted(s);
}

function medianSorted(s: number[]): number {
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  return Math.round(m);
}

const dayPhrase = (w: number): string => `ביום ${WEEKDAY_HE[w]}`;

/**
 * Insights for one calendar response, or null when there is too little to say (fewer than INSIGHTS_MIN_BUCKETS weekdays
 * priced at least twice) or on any bad input.
 *
 * - byWeekday: days with known === true and a fare only (a missing fare is never counted as 0).
 * - cheapest weekday: lowest median, then lower min, then lower weekday; dearest: highest median, then higher min, then
 *   lower weekday. Only weekdays with count >= 2 are candidates; singletons are listed but never chosen.
 * - saving: round((dearest - cheapest) / dearest * 100), set only when the unrounded value is at least
 *   INSIGHTS_MIN_SAVING_PCT (so 2.5% is not rounded up into a 3% claim) and the two weekdays differ.
 * - byNights: `fitting` grouped by nights, groups seen fewer than twice dropped; cheapestNights = lowest min, then fewer
 *   nights; null when no group is left.
 */
export function computeInsights(days: readonly CalendarDay[], fitting: readonly InsightFare[]): CalendarInsights | null {
  try {
    if (!Array.isArray(days) || !Array.isArray(fitting) || days.length === 0) return null;
    const hit = cached(days, fitting);
    if (hit.hit) return cloneInsights(hit.value);

    const perWeekday: number[][] = [[], [], [], [], [], [], []];
    const minByWeekday = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
    for (const d of days as readonly CalendarDay[]) {
      if (d.known !== true || d.fare === null || typeof d.fare !== "object") continue;
      const price = d.fare.priceIls;
      const w = weekdayOf(d.date);
      if (w === null || !validPrice(price)) continue;
      perWeekday[w]!.push(price);
      if (price < minByWeekday[w]!) minByWeekday[w] = price;
    }

    const byWeekday: CalendarInsights["byWeekday"] = [];
    for (let weekday = 0; weekday < perWeekday.length; weekday++) {
      const prices = perWeekday[weekday] as number[];
      if (prices.length === 0) continue;
      prices.sort((a, b) => a - b);
      byWeekday.push({ weekday, minIls: Math.round(minByWeekday[weekday] as number), medianIls: medianSorted(prices), count: prices.length });
    }
    const candidates = byWeekday.filter((b) => b.count >= 2);
    if (candidates.length < INSIGHTS_MIN_BUCKETS) return remember(days, fitting, null);

    let cheapest = candidates[0] as (typeof candidates)[number];
    let dearest = cheapest;
    for (const b of candidates) {
      // candidates are in ascending weekday order, so a full tie keeps the lower weekday already held.
      if (b.medianIls < cheapest.medianIls || (b.medianIls === cheapest.medianIls && b.minIls < cheapest.minIls)) cheapest = b;
      if (b.medianIls > dearest.medianIls || (b.medianIls === dearest.medianIls && b.minIls > dearest.minIls)) dearest = b;
    }

    const nightMins: number[] = [];
    const nightCounts: number[] = [];
    let maxNight = 0;
    for (const f of fitting as readonly InsightFare[]) {
      const n = f.nights;
      if (!Number.isInteger(n) || n <= 0 || !validPrice(f.priceIls)) continue;
      nightCounts[n] = (nightCounts[n] ?? 0) + 1;
      const min = nightMins[n];
      if (min === undefined || f.priceIls < min) nightMins[n] = f.priceIls;
      if (n > maxNight) maxNight = n;
    }
    const byNights: CalendarInsights["byNights"] = [];
    for (let nights = 1; nights <= maxNight; nights++) {
      const count = nightCounts[nights] ?? 0;
      if (count >= 2) byNights.push({ nights, minIls: Math.round(nightMins[nights] as number), count });
    }
    let cheapestNights: number | null = null;
    let cheapestNightsMin = Number.POSITIVE_INFINITY;
    for (const g of byNights) {
      // ascending nights: a tie on min keeps the fewer nights already held.
      if (g.minIls < cheapestNightsMin) {
        cheapestNightsMin = g.minIls;
        cheapestNights = g.nights;
      }
    }

    const rawPct = dearest.medianIls > 0 ? ((dearest.medianIls - cheapest.medianIls) / dearest.medianIls) * 100 : 0;
    const hasSaving = dearest !== cheapest && rawPct >= INSIGHTS_MIN_SAVING_PCT;
    const pct = Math.round(rawPct);
    const summaryHe = hasSaving
      ? `יציאה ${dayPhrase(cheapest.weekday)} זולה בממוצע ב-${pct}% מיציאה ${dayPhrase(dearest.weekday)}`
      : `המחיר הנמוך ביותר בממוצע: יציאה ${dayPhrase(cheapest.weekday)}`;

    return remember(days, fitting, {
      byWeekday,
      byNights,
      cheapestWeekday: cheapest.weekday,
      cheapestNights,
      ...(hasSaving ? { savingVsDearestWeekdayPct: pct } : {}),
      summaryHe,
      labelHe: INSIGHTS_LABEL_HE,
      basis: "cached_fares",
    });
  } catch {
    return null;
  }
}
