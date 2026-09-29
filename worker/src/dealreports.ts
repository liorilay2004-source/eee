/**
 * Deal reports: the pure detector (deals.ts) applied to the price history the hourly snapshot cron writes
 * (snapshots.ts), and the read side of GET /api/deals.
 *
 * Cost model (Workers Free: 10 ms CPU, D1 daily row limits):
 *   - Computing happens in the CRON, for the one route that run just scanned, and the result is upserted into
 *     `deal_reports` (migration 0005). The public endpoint never runs the detector and never reads `prices`: it reads
 *     at most MAX_REPORT_ROWS tiny rows and keeps the built response in isolate memory for RESPONSE_CACHE_MS.
 *   - The detector costs about 2.5 ms of CPU per 1000 rows, so a route's whole history is never loaded. Instead:
 *     (A) the route's rows of the last liveWithinHours through idx_prices_recent (the only rows a live candidate can
 *     come from; a bucket's candidate depends on its newest instant alone), then (B) the older history of just the
 *     candidate date pairs of those buckets, which is all the detector compares a candidate with. Both reads are
 *     LIMITed and a hit limit is reported as `truncated`, never hidden.
 *   - No external calls: FX comes from the fx_rates table only (today's, else the newest stored day). Rows in a
 *     currency without a stored rate are skipped and counted by the detector, never guessed.
 */
import { createRepo } from "./db";
import { assessBuckets, DEAL_CONFIG, type Deal, type DealPriceRow, type DealStats, type RatesToIls } from "./deals";
import { SNAPSHOT_ROUTES } from "./snapshots";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Newest rows of a route read by query A. One snapshot run stores at most 60 rows, so this is many runs' worth. */
export const RECENT_LIMIT = 500;
/** Query B looks back this far: longer than the trend window (21 d) plus the minimum span (7 d) with room to spare. */
export const HISTORY_DAYS = 45;
export const HISTORY_LIMIT = 1500;
/** At most this many candidate date pairs per route: 4 + 2 x 40 bound parameters stay under D1's 100. */
export const MAX_PAIRS = 40;
/** Deals kept per route in a stored report (the biggest drops first). */
export const MAX_DEALS_PER_ROUTE = 10;
/** Watched routes read from deal_reports per request (one IN list, so at most this many bound parameters). */
export const MAX_REPORT_ROWS = 64;
/** Each route is recomputed once a day (one route per hourly run); a report older than this means the cron missed it. */
export const REPORT_MAX_AGE_HOURS = 30;
export const RESPONSE_CACHE_MS = 5 * 60_000;

const PRICE_COLS = "origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, checked_at";

// --- compute (cron side) ------------------------------------------------------------------------------

export interface RouteReport {
  v: 1;
  origin: string;
  destination: string;
  computedAt: string;
  /** Biggest drops first, at most MAX_DEALS_PER_ROUTE. */
  deals: Deal[];
  dealsTotal: number;
  stats: DealStats;
  /** Live buckets with a verdict (normal, deal or error_fare). */
  judgedBuckets: number;
  /** The insufficient_data bucket closest to a verdict (most observations, then the longest span), or null. */
  readiness: { sampleSize: number; spanDays: number } | null;
  rowsRead: { recent: number; history: number };
  /** A LIMIT or the pair cap was hit: some history was not considered. */
  truncated: boolean;
  fx: { date: string; source: string } | null;
}

async function storedRates(db: D1Database, now: Date): Promise<{ rates: RatesToIls; fx: RouteReport["fx"] }> {
  const repo = createRepo(db);
  try {
    const fx = (await repo.getFxRates(now.toISOString().slice(0, 10))) ?? (await repo.getLatestFxRates());
    if (fx) return { rates: fx.ratesToIls, fx: { date: fx.date, source: fx.source } };
  } catch {
    // no rates: only ILS rows can be judged, the rest are counted as skippedNoRate
  }
  return { rates: {}, fx: null };
}

/** Reads the route's bounded history (queries A and B) and runs the detector as of `now`. Throws on D1 errors. */
export async function computeRouteReport(db: D1Database, origin: string, destination: string, now: Date): Promise<RouteReport> {
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const recentCutoff = new Date(nowMs - DEAL_CONFIG.liveWithinHours * HOUR_MS).toISOString();
  const historyFrom = new Date(nowMs - HISTORY_DAYS * DAY_MS).toISOString();
  const { rates, fx } = await storedRates(db, now);

  // (A) Every row a live candidate can come from. A trip that already departed is never a deal.
  const recent = (
    await db
      .prepare(
        `SELECT ${PRICE_COLS} FROM prices INDEXED BY idx_prices_recent ` +
          "WHERE origin = ? AND destination = ? AND checked_at >= ? AND depart_date >= ? " +
          "ORDER BY checked_at DESC, id DESC LIMIT ?",
      )
      .bind(origin, destination, recentCutoff, today, RECENT_LIMIT)
      .all<DealPriceRow>()
  ).results;
  let truncated = recent.length >= RECENT_LIMIT;
  // When (A) was cut short, (B) continues exactly where (A) stopped, so no window of history falls between the two.
  const oldestRecent = recent[recent.length - 1]?.checked_at;
  const historyUpTo = truncated && typeof oldestRecent === "string" ? oldestRecent : recentCutoff; // every (A) row is >= recentCutoff

  // The candidate pair of each live bucket (it depends only on the bucket's newest instant, which is in `recent`).
  const pairSet = new Map<string, [string, string]>();
  for (const b of assessBuckets(recent, rates, now).buckets) pairSet.set(`${b.departDate}|${b.returnDate}`, [b.departDate, b.returnDate]);
  const pairs = [...pairSet.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
  if (pairs.length > MAX_PAIRS) truncated = true;
  const used = pairs.slice(0, MAX_PAIRS);

  // (B) The older history of those pairs only: disjoint from (A) by checked_at, so no row is counted twice.
  let history: DealPriceRow[] = [];
  if (used.length > 0) {
    const ors = used.map(() => "(depart_date = ? AND return_date = ?)").join(" OR ");
    history = (
      await db
        .prepare(
          `SELECT ${PRICE_COLS} FROM prices ` +
            `WHERE origin = ? AND destination = ? AND checked_at >= ? AND checked_at < ? AND (${ors}) ` +
            "ORDER BY checked_at DESC, id DESC LIMIT ?",
        )
        .bind(origin, destination, historyFrom, historyUpTo, ...used.flat(), HISTORY_LIMIT)
        .all<DealPriceRow>()
    ).results;
    if (history.length >= HISTORY_LIMIT) truncated = true;
  }

  const result = assessBuckets([...recent, ...history], rates, now);
  let readiness: RouteReport["readiness"] = null;
  let judged = 0;
  for (const b of result.buckets) {
    if (b.verdict !== "insufficient_data") {
      judged++;
      continue;
    }
    if (!readiness || b.sampleSize > readiness.sampleSize || (b.sampleSize === readiness.sampleSize && b.spanDays > readiness.spanDays)) {
      readiness = { sampleSize: b.sampleSize, spanDays: b.spanDays };
    }
  }
  return {
    v: 1,
    origin,
    destination,
    computedAt: now.toISOString(),
    deals: result.deals.slice(0, MAX_DEALS_PER_ROUTE),
    dealsTotal: result.deals.length,
    stats: result.stats,
    judgedBuckets: judged,
    readiness,
    rowsRead: { recent: recent.length, history: history.length },
    truncated,
    fx,
  };
}

/** Cron entry: compute and upsert one route's report. Never throws (a failure keeps the previous report, which then ages into "stale"). */
export async function refreshDealReport(db: D1Database, origin: string, destination: string, now: Date): Promise<RouteReport | null> {
  try {
    const report = await computeRouteReport(db, origin, destination, now);
    await db
      .prepare(
        "INSERT INTO deal_reports (route, computed_at, report_json) VALUES (?, ?, ?) " +
          "ON CONFLICT(route) DO UPDATE SET computed_at = excluded.computed_at, report_json = excluded.report_json",
      )
      .bind(`${origin}-${destination}`, report.computedAt, JSON.stringify(report))
      .run();
    return report;
  } catch (err) {
    console.error(`deal report ${origin}-${destination} failed:`, err instanceof Error ? err.name : typeof err);
    return null;
  }
}

// --- read (GET /api/deals) ----------------------------------------------------------------------------

export type RouteDealStatus = "not_computed" | "stale" | "deals" | "no_deal" | "insufficient_data" | "no_recent_data";

/** User-facing text is Hebrew (SPEC). Each label says only what the data supports. */
export const STATUS_LABELS_HE: Readonly<Record<RouteDealStatus, string>> = {
  not_computed: "המסלול עדיין לא נבדק",
  stale: "הבדיקה האחרונה של המסלול ישנה מדי, ולכן לא מוצגים מבצעים",
  deals: "נמצאו מחירים נמוכים במיוחד ביחס להיסטוריית המחירים",
  no_deal: "לא נמצא מחיר חריג בתאריכים שיש להם מספיק היסטוריית מחירים",
  insufficient_data: "אין עדיין מספיק היסטוריית מחירים כדי לקבוע אם מחיר זול במיוחד",
  no_recent_data: "אין מחירים עדכניים למסלול הזה",
};

export const VERDICT_LABELS_HE: Readonly<Record<Deal["verdict"], string>> = {
  deal: "מחיר נמוך במיוחד ביחס להיסטוריה",
  error_fare: "מחיר נמוך בצורה חריגה: ייתכן שזו טעות תמחור שתתוקן בקרוב",
};

export interface RouteDealsView {
  origin: string;
  destination: string;
  status: RouteDealStatus;
  labelHe: string;
  computedAt: string | null;
  deals: Array<Deal & { ageHours: number; labelHe: string }>;
  /** Buckets per verdict as of computedAt; null when never computed. */
  buckets: { total: number; judged: number; insufficient: number; stale: number } | null;
  readiness: { sampleSize: number; spanDays: number } | null;
  truncated: boolean;
}

export interface DealsResponse {
  asOf: string;
  /** Prices are per traveller, round trip, base fare (no paid extras added), as stored in the history. */
  priceBasis: "per_traveller";
  noteHe: string;
  thresholds: { dealDropPct: number; errorDropPct: number; minSamples: number; minSpanDays: number; minDistinctDays: number; liveWithinHours: number };
  routes: RouteDealsView[];
}

const NOTE_HE =
  "המחירים לנוסע אחד, הלוך־חזור, מחיר בסיס ללא תוספות (כמו כבודה), לפי בדיקות קודמות ולא בזמן אמת. מחיר מסומן כזול במיוחד רק כשיש מספיק היסטוריה לאותם תאריכים. המחיר הסופי מוצג באתר ההזמנה.";

function parseReport(json: unknown, origin: string, destination: string): RouteReport | null {
  if (typeof json !== "string") return null;
  try {
    const r = JSON.parse(json) as Partial<RouteReport> | null;
    if (!r || r.v !== 1 || r.origin !== origin || r.destination !== destination || typeof r.computedAt !== "string") return null;
    if (!Array.isArray(r.deals) || !r.stats || typeof r.stats !== "object") return null;
    return r as RouteReport;
  } catch {
    return null;
  }
}

export function routeView(origin: string, destination: string, report: RouteReport | null, now: Date): RouteDealsView {
  const base = { origin, destination, deals: [] as RouteDealsView["deals"] };
  const make = (status: RouteDealStatus, extra: Partial<RouteDealsView> = {}): RouteDealsView => ({
    ...base,
    status,
    labelHe: STATUS_LABELS_HE[status],
    computedAt: report?.computedAt ?? null,
    buckets: report
      ? {
          total: report.stats.buckets,
          judged: report.judgedBuckets,
          insufficient: report.stats.insufficientBuckets,
          stale: report.stats.staleBuckets,
        }
      : null,
    readiness: report?.readiness ?? null,
    truncated: report?.truncated ?? false,
    ...extra,
  });
  if (!report) return make("not_computed");
  const nowMs = now.getTime();
  const computedMs = Date.parse(report.computedAt);
  if (!Number.isFinite(computedMs) || nowMs - computedMs > REPORT_MAX_AGE_HOURS * HOUR_MS) return make("stale");

  // A deal is live for liveWithinHours after its check, counted from NOW, not from when the report was computed.
  const live = report.deals
    .map((d) => ({ d, ms: Date.parse(d.checkedAt) }))
    .filter(({ ms }) => Number.isFinite(ms) && nowMs - ms <= DEAL_CONFIG.liveWithinHours * HOUR_MS)
    .map(({ d, ms }) => ({ ...d, ageHours: Math.max(0, Math.round(((nowMs - ms) / HOUR_MS) * 10) / 10), labelHe: VERDICT_LABELS_HE[d.verdict] }));
  if (live.length > 0) return make("deals", { deals: live });
  if (report.deals.length > 0) return make("stale"); // it was a deal, but that check is too old to show as one now
  if (report.judgedBuckets > 0) return make("no_deal");
  if (report.stats.insufficientBuckets > 0) return make("insufficient_data");
  return make("no_recent_data");
}

let cache: { at: number; body: DealsResponse } | null = null;

/** Tests only: forget the isolate's cached response. */
export function resetDealsCache(): void {
  cache = null;
}

/** Builds the GET /api/deals body from deal_reports (one bounded query), cached per isolate. Throws on D1 errors (not cached). */
export async function loadDeals(db: D1Database, now: Date, routes: ReadonlyArray<readonly [string, string]> = SNAPSHOT_ROUTES): Promise<DealsResponse> {
  const nowMs = now.getTime();
  if (cache && nowMs - cache.at >= 0 && nowMs - cache.at < RESPONSE_CACHE_MS) return cache.body;

  // Exactly the watched routes, by primary key: a leftover row of a route dropped from the watchlist is never read.
  const keys = routes.slice(0, MAX_REPORT_ROWS).map(([o, d]) => `${o}-${d}`);
  const { results } =
    keys.length === 0
      ? { results: [] as Array<{ route: string; report_json: string }> }
      : await db
          .prepare(`SELECT route, report_json FROM deal_reports WHERE route IN (${keys.map(() => "?").join(", ")})`)
          .bind(...keys)
          .all<{ route: string; report_json: string }>();
  const byRoute = new Map(results.map((r) => [r.route, r.report_json]));

  const body: DealsResponse = {
    asOf: now.toISOString(),
    priceBasis: "per_traveller",
    noteHe: NOTE_HE,
    thresholds: {
      dealDropPct: DEAL_CONFIG.dealDropPct,
      errorDropPct: DEAL_CONFIG.errorDropPct,
      minSamples: DEAL_CONFIG.minSamples,
      minSpanDays: DEAL_CONFIG.minSpanDays,
      minDistinctDays: DEAL_CONFIG.minDistinctDays,
      liveWithinHours: DEAL_CONFIG.liveWithinHours,
    },
    routes: routes.slice(0, MAX_REPORT_ROWS).map(([o, d]) => routeView(o, d, parseReport(byRoute.get(`${o}-${d}`), o, d), now)),
  };
  cache = { at: nowMs, body };
  return body;
}
