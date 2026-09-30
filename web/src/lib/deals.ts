/**
 * The deals page (GET /api/deals): ordering, readiness progress and links. Pure; unit tested in deals.test.ts.
 */
import type { DealsResponse, RouteDeal, RouteDealStatus, RouteDealsView } from "../api/contract";
import { nightsBetween, placeLabel } from "./builder";
import { GENERIC_NOTICE, commonNotice, type ApiFailure, type FailureNotice } from "./failure";
import { emptyForm, searchParamsFor } from "./search";

/** Fallback Hebrew for each status (the API sends its own labelHe, which is preferred). */
export const STATUS_FALLBACK_HE: Record<RouteDealStatus, string> = {
  not_computed: "המסלול עדיין לא נבדק",
  stale: "הבדיקה האחרונה של המסלול ישנה מדי, ולכן לא מוצגים מבצעים",
  deals: "נמצאו מחירים נמוכים במיוחד ביחס להיסטוריית המחירים",
  no_deal: "לא נמצא מחיר חריג בתאריכים שיש להם מספיק היסטוריית מחירים",
  insufficient_data: "אין עדיין מספיק היסטוריית מחירים כדי לקבוע אם מחיר זול במיוחד",
  no_recent_data: "אין מחירים עדכניים למסלול הזה",
};

/** Short tag per status, shown next to the route name. */
export const STATUS_TAG_HE: Record<RouteDealStatus, string> = {
  deals: "יש מבצע",
  insufficient_data: "אוספים היסטוריה",
  no_deal: "אין מחיר חריג",
  no_recent_data: "אין מחירים עדכניים",
  stale: "בדיקה ישנה",
  not_computed: "טרם נבדק",
};

const ORDER: Record<RouteDealStatus, number> = { deals: 0, insufficient_data: 1, no_deal: 2, no_recent_data: 3, stale: 4, not_computed: 5 };

export function statusLabel(route: Pick<RouteDealsView, "status" | "labelHe">): string {
  return route.labelHe || STATUS_FALLBACK_HE[route.status] || "";
}

export interface Progress { have: number; need: number; pct: number }

export interface Readiness { samples: Progress; span: Progress; overallPct: number }

const progress = (have: number, need: number): Progress => {
  const h = Math.max(0, Math.floor(have));
  const n = Math.max(1, Math.floor(need));
  return { have: Math.min(h, n), need: n, pct: Math.round((Math.min(h, n) / n) * 100) };
};

/**
 * How close the route's best-covered dates are to a verdict: observations out of minSamples and days of history out of
 * minSpanDays. Null when the route is not collecting (any status but insufficient_data, or no readiness sent).
 */
export function readinessOf(route: Pick<RouteDealsView, "status" | "readiness">, thresholds: Pick<DealsResponse["thresholds"], "minSamples" | "minSpanDays">): Readiness | null {
  if (route.status !== "insufficient_data" || !route.readiness) return null;
  const samples = progress(route.readiness.sampleSize, thresholds.minSamples);
  const span = progress(route.readiness.spanDays, thresholds.minSpanDays);
  return { samples, span, overallPct: Math.min(samples.pct, span.pct) };
}

/** Routes with deals first, then the ones closest to having enough history, then the rest; ties keep the API order. */
export function sortRoutes(routes: readonly RouteDealsView[], thresholds: DealsResponse["thresholds"]): RouteDealsView[] {
  return routes
    .map((route, i) => ({ route, i, ready: readinessOf(route, thresholds)?.overallPct ?? 0 }))
    .sort((a, b) => ORDER[a.route.status] - ORDER[b.route.status] || b.ready - a.ready || a.i - b.i)
    .map((x) => x.route);
}

export function statusCounts(routes: readonly RouteDealsView[]): Record<RouteDealStatus, number> {
  const counts: Record<RouteDealStatus, number> = { deals: 0, insufficient_data: 0, no_deal: 0, no_recent_data: 0, stale: 0, not_computed: 0 };
  for (const r of routes) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

export function routeName(origin: string, destination: string): string {
  return `${placeLabel(origin, "")} – ${placeLabel(destination, "")}`;
}

/** "נבדק לפני 5 שעות": the age of the check the deal is based on (a stored fare, not a live price). */
export function checkedAgoText(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return "נבדק לפני פחות משעה";
  const h = Math.round(hours);
  if (h < 48) return h === 1 ? "נבדק לפני שעה" : `נבדק לפני ${h} שעות`;
  return `נבדק לפני ${Math.round(h / 24)} ימים`;
}

/**
 * A link that opens the main search on exactly the deal's dates. The deal's airports are concrete (LHR), so the
 * search uses them as they are; the watched city names the place.
 */
export function dealSearchHref(deal: Pick<RouteDeal, "origin" | "destination" | "departDate" | "returnDate">, cityOrigin: string, cityDestination: string): string {
  const nights = nightsBetween(deal.departDate, deal.returnDate);
  const params = searchParamsFor({
    ...emptyForm(),
    origin: deal.origin,
    originLabel: placeLabel(cityOrigin, ""),
    destination: deal.destination,
    destinationLabel: placeLabel(cityDestination, ""),
    windowStart: deal.departDate,
    windowEnd: deal.returnDate,
    stayMin: Math.max(1, nights),
    stayMax: Math.max(1, nights),
  });
  return `/?${params.toString()}`;
}

export function describeDealsFailure(failure: ApiFailure): FailureNotice {
  const common = commonNotice(failure);
  if (common) return common;
  if (failure.type === "http" && (failure.code === "deals_unavailable" || failure.status === 503)) {
    return { title: "המבצעים לא זמינים כרגע", body: "לא הצלחנו לקרוא את דוחות המחירים. נסו שוב בעוד כמה דקות.", retryAfterSec: null, canRetry: true };
  }
  return GENERIC_NOTICE;
}

/** "בכל 5 המסלולים" / "במסלול אחד מתוך 5" / "ב־2 מתוך 5 מסלולים": the share of routes a sentence is about. */
function routesShare(n: number, total: number): string {
  if (n === total) return total === 1 ? "במסלול שבמעקב" : `בכל ${total} המסלולים`;
  return n === 1 ? `במסלול אחד מתוך ${total}` : `ב־${n} מתוך ${total} מסלולים`;
}

/**
 * The note shown when no route has a deal, one sentence per status that is actually present, with counts (never
 * "most" or "any" unless it is true). Stale checks and missing recent prices are named for what they are, and the
 * "nothing unusual, that's normal" reassurance appears only when no route's check is too old.
 */
export function emptyStateLines(counts: Record<RouteDealStatus, number>, thresholds: Pick<DealsResponse["thresholds"], "minSamples" | "minSpanDays">): string[] {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return ["עדיין אין מסלולים במעקב."];
  const lines: string[] = [];
  if (counts.stale) {
    lines.push(`${routesShare(counts.stale, total)} הבדיקה האחרונה ישנה מדי, ולכן לא מוצגים מבצעים עד הבדיקה הבאה.`);
  }
  if (counts.insufficient_data) {
    lines.push(`${routesShare(counts.insufficient_data, total)} עדיין אין מספיק היסטוריה כדי לקבוע מה זול במיוחד. צריך לפחות ${thresholds.minSamples} בדיקות לאותם תאריכים לאורך ${thresholds.minSpanDays} ימים, ולכן כדאי לחזור בעוד כמה ימים.`);
  }
  if (counts.not_computed) lines.push(`${routesShare(counts.not_computed, total)} עוד לא בוצעה בדיקה.`);
  if (counts.no_recent_data) lines.push(`${routesShare(counts.no_recent_data, total)} אין מחירים עדכניים, ולכן אין למה להשוות.`);
  if (counts.no_deal) {
    lines.push(`${routesShare(counts.no_deal, total)} לא נמצא מחיר חריג בבדיקה האחרונה.${counts.stale ? "" : " זה מצב רגיל: מבצעים אמיתיים נדירים."}`);
  }
  return lines;
}
