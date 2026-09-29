/**
 * Cheapest-dates calendar: GET /api/calendar (ADDITIVE endpoint, index.ts).
 *
 *   GET /api/calendar?origin=TLV&destination=ATH&month=2026-11[&months=1-3][&minNights=1][&maxNights=30][&maxStops=0-5]
 *
 * For every departure day of the asked months: the cheapest CACHED round trip (per ONE adult) whose stay fits
 * [minNights, maxNights], with its return date, nights, stops and the booking link of that very fare.
 *
 * Source: the free Travelpayouts Data API, `aviasales/v3/prices_for_dates`, the same endpoint and parsing the search
 * scan already uses (travelpayouts.ts). Per departure month M exactly TWO requests: (depart M, return M) and
 * (depart M, return M+1), grouped here by departure day. That is at most 2 x CALENDAR_MAX_MONTHS = 6 subrequests
 * per invocation, plus FX (0-2). The v1 `prices/calendar` and v2 `month-matrix` endpoints on the public docs page
 * (travelpayouts.github.io/slate) return one fare per day without a booking link, and month-matrix documents no
 * round-trip parameter, so they were not used: every price shown here comes with the link of the same fare.
 *
 * Cost and limits: each month is cached in D1 (table search_cache, key `calendar:v2:<o>:<d>:<YYYY-MM>`, so no
 * migration and the existing retention covers it) for the search cache TTL (an empty month for EMPTY_RESULT_TTL_HOURS).
 * A request that needs any fresh month first takes one unit of the calendar's own global share and then one unit of the
 * global scan budget (both fail CLOSED: no unit, no upstream call). Calls run one at a time and the first failure stops
 * the rest (no retries). A month that cannot be refreshed falls back to its last stored copy (up to 7 days), marked stale.
 *
 * Coverage: a departure in M is found with a return in M or M+1 only, so a long stay that ends in M+2 (e.g. 31 Jan + 30
 * nights) is not seen; such a day may show a dearer shorter stay or none. Every stay of up to 28 nights is always covered.
 *
 * Honesty: fares are the source's cached prices (often 2-7 days old); a day without a price means "no cached fare",
 * not "no flights". The response says so (meta.noticeHe).
 */
import type { Resolver } from "./airports/types";
import { EMPTY_RESULT_TTL_HOURS } from "./pipeline";
import { SCORING } from "./scoring.config";
import { dayNumber } from "./splits";
import type { FxRates, Offer, TravelpayoutsClient } from "./types";
import { MAX_ADVANCE_DAYS, MAX_PLACE_TEXT_LEN, MAX_STAY_NIGHTS, MAX_STOPS, MIN_STAY_NIGHTS } from "./validate";

// --- limits ----------------------------------------------------------------------------------------------

/** Months per request: 2 upstream requests each, so at most 6 Travelpayouts subrequests per invocation. */
export const CALENDAR_MAX_MONTHS = 3;
/** Per-client limit for /api/calendar (own counter, same window as search). */
export const CALENDAR_RATE_LIMIT_MAX = 30;
export const CALENDAR_RATE_LIMIT_WINDOW_SECONDS = 600;
/**
 * Fresh calendar fetches across ALL clients per window. Each one also takes a unit of the global scan budget
 * (GLOBAL_SCAN_LIMIT, shared with /api/search); this smaller share keeps calendar traffic from starving searches.
 */
export const CALENDAR_GLOBAL_LIMIT = 40;
export const CALENDAR_GLOBAL_WINDOW_SECONDS = 600;
/**
 * Stored fares per month. groupMonth keeps, per (departure day, return day), only fares that are cheaper than every fare
 * with fewer stops (see there), so a pair holds one fare per stop count 0..MAX_STOPS at most. Real months hold far fewer
 * (usually 1-2 per pair); this safety cap allows 3 per pair (31 days x 30 stays x 3). A month that hits it is marked
 * truncated.
 */
export const MAX_ENTRIES_PER_MONTH = 31 * 30 * 3;
/** v2: v1 rows kept only the cheapest fare per date pair, whatever its stops (wrong under maxStops); they are never read. */
export const CALENDAR_CACHE_PREFIX = "calendar:v2:";
/** A stored month older than this is not even a stale fallback (the search cache retention is 7 days too). */
const STALE_MAX_HOURS = 7 * 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const INT_RE = /^\d{1,3}$/;

export const CALENDAR_NOTICE_HE =
  "המחירים הם מחירים שמורים של מקור הנתונים (לרוב בני 2–7 ימים), הלוך-חזור למבוגר אחד. יום בלי מחיר פירושו שאין מחיר שמור, לא שאין טיסות. המחיר הסופי מאומת באתר ההזמנה.";
/** For days whose month could not be loaded (known: false). */
export const CALENDAR_UNKNOWN_HE = "לא הצלחנו לטעון את המחירים לחודש הזה כרגע. נסו שוב מאוחר יותר.";

// --- request parsing -------------------------------------------------------------------------------------

export interface CalendarQuery {
  origin: string;
  destination: string;
  months: string[]; // "YYYY-MM", consecutive
  minNights: number;
  maxNights: number;
  maxStops: number | null;
}

export type CalendarParse = { ok: true; q: CalendarQuery } | { ok: false; code: "invalid_request" | "destination_required"; fields: Record<string, string> };

/** "YYYY-MM" plus n months. */
export function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError("addMonths: month must be YYYY-MM");
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

const monthStartDay = (month: string): number => dayNumber(`${month}-01`) as number;
const monthEndDay = (month: string): number => monthStartDay(addMonths(month, 1)) - 1;
const isoOfDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * Query string -> CalendarQuery. Strict like POST /api/search: places resolve strictly (a well-formed unknown 3-letter
 * code passes as an airport code), numbers are plain decimal integers, every problem is collected in `fields`.
 */
export function parseCalendarQuery(params: URLSearchParams, deps: { resolver: Resolver; now: Date }): CalendarParse {
  const errors: Record<string, string> = {};
  const fail = (name: string, message: string): void => {
    if (!Object.hasOwn(errors, name)) errors[name] = message;
  };

  const place = (name: string): { code: string; city: string } | null => {
    const text = (params.get(name) ?? "").trim();
    if (text === "") {
      fail(name, "is required");
      return null;
    }
    if (text.length > MAX_PLACE_TEXT_LEN) {
      fail(name, `must be at most ${MAX_PLACE_TEXT_LEN} characters`);
      return null;
    }
    const match = deps.resolver.resolvePlace(text);
    // A city match asks Travelpayouts for the city code (all its airports in ONE request); an airport match for that airport.
    if (match) return { code: match.airportCode ?? match.code, city: match.code };
    if (/^[A-Za-z]{3}$/.test(text)) return { code: text.toUpperCase(), city: text.toUpperCase() };
    fail(name, "no matching city or airport");
    return null;
  };
  const origin = place("origin");
  const destination = place("destination");
  if (origin && destination && origin.city === destination.city) fail("destination", "must differ from origin");

  const int = (name: string, min: number, max: number, dflt: number | null): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === "") return dflt;
    if (!INT_RE.test(raw.trim())) {
      fail(name, "must be an integer");
      return dflt;
    }
    const v = Number(raw.trim());
    if (v < min || v > max) {
      fail(name, `must be between ${min} and ${max}`);
      return dflt;
    }
    return v;
  };
  const count = int("months", 1, CALENDAR_MAX_MONTHS, 1) as number;
  const minNights = int("minNights", MIN_STAY_NIGHTS, MAX_STAY_NIGHTS, MIN_STAY_NIGHTS) as number;
  const maxNights = int("maxNights", MIN_STAY_NIGHTS, MAX_STAY_NIGHTS, MAX_STAY_NIGHTS) as number;
  if (!Object.hasOwn(errors, "minNights") && !Object.hasOwn(errors, "maxNights") && minNights > maxNights) fail("maxNights", "must be at least minNights");
  const maxStops = int("maxStops", 0, MAX_STOPS, null);

  const month = (params.get("month") ?? "").trim();
  let months: string[] = [];
  if (month === "") fail("month", "is required");
  else if (!MONTH_RE.test(month)) fail("month", "must be a month formatted YYYY-MM");
  else {
    const today = Math.floor(deps.now.getTime() / DAY_MS);
    months = Array.from({ length: count }, (_, i) => addMonths(month, i));
    if (monthEndDay(month) < today) fail("month", "must not be in the past");
    else if (monthStartDay(months[months.length - 1] as string) > today + MAX_ADVANCE_DAYS) {
      fail(Object.hasOwn(errors, "months") || count === 1 ? "month" : "months", `must start within ${MAX_ADVANCE_DAYS} days from today`);
    }
  }

  if (Object.keys(errors).length > 0 || !origin || !destination) {
    const destinationEmpty = (params.get("destination") ?? "").trim() === "";
    return { ok: false, code: destinationEmpty ? "destination_required" : "invalid_request", fields: errors };
  }
  return { ok: true, q: { origin: origin.code, destination: destination.code, months, minNights, maxNights, maxStops } };
}

// --- stored month ----------------------------------------------------------------------------------------

/** One fare as stored per month: per ONE adult, original currency, the link of that fare. */
export interface CalendarFare {
  departDate: string;
  returnDate: string;
  price: number;
  currency: string;
  stops: number | null;
  returnStops: number | null;
  airlines: string[];
  departTime: string | null;
  returnTime: string | null;
  deeplink: string | null;
}

interface StoredMonth {
  fares: CalendarFare[];
  truncated: boolean;
  createdAt: string;
}

export const calendarCacheKey = (origin: string, destination: string, month: string): string =>
  `${CALENDAR_CACHE_PREFIX}${origin}:${destination}:${month}`;

/**
 * Stop class of a fare: the worse leg's stop count, or "u" when a leg's count is unknown or above MAX_STOPS (such a
 * fare passes no maxStops filter, only "any stops").
 */
function stopClass(f: { stops: number | null; returnStops: number | null }): number | "u" {
  if (f.stops === null || f.returnStops === null) return "u";
  const worst = Math.max(f.stops, f.returnStops);
  return worst <= MAX_STOPS ? worst : "u";
}

/**
 * Round trips of one departure month -> per (departure day, return day), the cheapest fare of every stop class that
 * some maxStops filter could pick: the cheapest overall, then each dearer fare only if it has strictly fewer stops than
 * every cheaper one kept (so maxStops=0 still finds a direct fare that a cheaper 1-stop fare undercuts). Only stays of
 * MIN..MAX_STAY_NIGHTS and only departures inside `month`. Prices of different currencies are never compared.
 */
export function groupMonth(offers: Offer[], month: string): CalendarFare[] {
  const best = new Map<string, CalendarFare>();
  for (const o of offers) {
    if (!o.departDate.startsWith(`${month}-`)) continue;
    const dep = dayNumber(o.departDate);
    const ret = dayNumber(o.returnDate);
    if (dep === null || ret === null) continue;
    const nights = ret - dep;
    if (nights < MIN_STAY_NIGHTS || nights > MAX_STAY_NIGHTS) continue;
    if (!(Number.isFinite(o.priceAmount) && o.priceAmount > 0)) continue;
    const key = `${o.departDate}|${o.returnDate}|${o.priceCurrency}|${stopClass({ stops: o.outbound.stops, returnStops: o.inbound.stops })}`;
    const prev = best.get(key);
    if (prev && prev.price <= o.priceAmount) continue;
    best.set(key, {
      departDate: o.departDate,
      returnDate: o.returnDate,
      price: o.priceAmount,
      currency: o.priceCurrency,
      stops: o.outbound.stops,
      returnStops: o.inbound.stops,
      airlines: o.outbound.airlines.slice(0, 2),
      departTime: o.outbound.departTime,
      returnTime: o.inbound.departTime,
      deeplink: o.deeplink && /^https:\/\//.test(o.deeplink) ? o.deeplink : null, // same rule as a read-back (sanitizeFare)
    });
  }
  // Pareto cut per (dates, currency): walking cheapest first, keep a fare only if it has fewer stops than all kept so far.
  const fewest = new Map<string, number>();
  const kept: CalendarFare[] = [];
  for (const f of [...best.values()].sort((a, b) => a.price - b.price)) {
    const pair = `${f.departDate}|${f.returnDate}|${f.currency}`;
    const cls = stopClass(f);
    const min = fewest.get(pair);
    if (min !== undefined && (cls === "u" || cls >= min)) continue;
    fewest.set(pair, cls === "u" ? Number.POSITIVE_INFINITY : cls);
    kept.push(f);
  }
  return kept.slice(0, MAX_ENTRIES_PER_MONTH);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nullableInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const nullableStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A stored fare read back defensively: anything malformed is dropped, never repaired. */
function sanitizeFare(v: unknown): CalendarFare | null {
  if (!isRecord(v)) return null;
  const { departDate, returnDate, price, currency } = v;
  if (typeof departDate !== "string" || typeof returnDate !== "string" || dayNumber(departDate) === null || dayNumber(returnDate) === null) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const link = nullableStr(v.deeplink);
  return {
    departDate,
    returnDate,
    price,
    currency,
    stops: nullableInt(v.stops),
    returnStops: nullableInt(v.returnStops),
    airlines: Array.isArray(v.airlines) ? v.airlines.filter((a): a is string => typeof a === "string").slice(0, 2) : [],
    departTime: nullableStr(v.departTime),
    returnTime: nullableStr(v.returnTime),
    deeplink: link && /^https:\/\//.test(link) ? link : null,
  };
}

/** ONE D1 read for all asked months. Storage trouble = nothing cached (the caller may still fetch). */
async function readMonths(db: D1Database, keys: string[]): Promise<Map<string, StoredMonth>> {
  const out = new Map<string, StoredMonth>();
  try {
    const { results } = await db
      .prepare(`SELECT search_key, offers_json, extra_json, created_at FROM search_cache WHERE search_key IN (${keys.map(() => "?").join(", ")})`)
      .bind(...keys)
      .all<{ search_key: string; offers_json: string; extra_json: string | null; created_at: string }>();
    for (const row of results) {
      let fares: unknown;
      let extra: unknown;
      try {
        fares = JSON.parse(row.offers_json);
        extra = row.extra_json === null ? null : JSON.parse(row.extra_json);
      } catch {
        continue; // a damaged row is a miss
      }
      if (!Array.isArray(fares) || !Number.isFinite(Date.parse(row.created_at))) continue;
      out.set(row.search_key, {
        fares: fares.map(sanitizeFare).filter((f): f is CalendarFare => f !== null),
        truncated: isRecord(extra) && extra.truncated === true,
        createdAt: row.created_at,
      });
    }
  } catch {
    // treated as an empty cache
  }
  return out;
}

async function writeMonths(db: D1Database, rows: { key: string; month: StoredMonth }[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map(({ key, month }) =>
      db
        .prepare(
          "INSERT INTO search_cache (search_key, offers_json, extra_json, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(search_key) DO UPDATE SET offers_json = excluded.offers_json, extra_json = excluded.extra_json, created_at = excluded.created_at",
        )
        .bind(key, JSON.stringify(month.fares), JSON.stringify({ kind: "calendar", truncated: month.truncated }), month.createdAt),
    ),
  );
}

// --- the endpoint's work -----------------------------------------------------------------------------------

export type MonthStatus = "cached" | "fresh" | "stale" | "failed" | "busy" | "unavailable";

export interface CalendarDay {
  date: string;
  /**
   * false when this day's month could not be loaded (see meta.months[].status): `fare` is then null because nothing is
   * known, NOT because the source has no cached fare. true: `fare` null really means "no cached fare that fits".
   */
  known: boolean;
  /** The cheapest fitting fare departing this day, or null when the source has none cached. */
  fare: {
    priceIls: number;
    /** ORIGINAL amount and currency, per ONE adult (what the booking link shows). */
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
    /** Relative to the other priced days of THIS response (tertiles); null with fewer than 3 priced days. */
    level: "low" | "mid" | "high" | null;
  } | null;
}

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
    months: { month: string; status: MonthStatus; checkedAt: string | null; truncated: boolean }[];
    fromCache: boolean;
    upstreamCalls: number;
    cheapest: { date: string; priceIls: number } | null;
    fxSource: string;
    fxDate: string;
    source: "travelpayouts";
    noticeHe: string;
    /** Set only when some month could not be loaded (a day with known: false). */
    unavailableHe?: string;
    generatedAt: string;
  };
}

export class CalendarError extends Error {
  constructor(
    readonly code: "source_unavailable" | "fx_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

export interface CalendarDeps {
  db: D1Database;
  tp: TravelpayoutsClient;
  fx: () => Promise<FxRates>;
  now: Date;
  /** Takes the global units for ONE fresh fetch (calendar share, then scan budget). Must fail closed. */
  reserveFetch: () => Promise<boolean>;
  waitUntil?: (p: Promise<unknown>) => void;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function freshFor(month: StoredMonth, now: Date): boolean {
  const ttlHours = month.fares.length > 0 ? SCORING.cacheTtlHours : EMPTY_RESULT_TTL_HOURS;
  return now.getTime() - Date.parse(month.createdAt) < ttlHours * HOUR_MS;
}

export async function runCalendar(deps: CalendarDeps, q: CalendarQuery): Promise<CalendarResponse> {
  const { now, tp } = deps;
  const keys = q.months.map((m) => calendarCacheKey(q.origin, q.destination, m));
  const stored = await readMonths(deps.db, keys);

  const byMonth = new Map<string, { status: MonthStatus; data: StoredMonth | null }>();
  const toFetch: string[] = [];
  for (const [i, month] of q.months.entries()) {
    const row = stored.get(keys[i] as string);
    if (row && freshFor(row, now)) byMonth.set(month, { status: "cached", data: row });
    else toFetch.push(month);
  }

  const fxLoad = deps.fx().then(
    (v) => ({ ok: true as const, v }),
    () => ({ ok: false as const }),
  );

  const callsBefore = tp.callCount();
  const written: { key: string; month: StoredMonth }[] = [];
  let why: MonthStatus = "unavailable";
  if (toFetch.length > 0 && tp.configured && tp.monthRoundTrips) {
    why = "busy";
    if (await deps.reserveFetch()) {
      why = "failed";
      for (const month of toFetch) {
        try {
          const same = await tp.monthRoundTrips(q.origin, q.destination, month, month);
          const next = await tp.monthRoundTrips(q.origin, q.destination, month, addMonths(month, 1));
          const fares = groupMonth([...same.offers, ...next.offers], month);
          const data: StoredMonth = { fares, truncated: same.truncated || next.truncated || fares.length >= MAX_ENTRIES_PER_MONTH, createdAt: now.toISOString() };
          byMonth.set(month, { status: "fresh", data });
          written.push({ key: calendarCacheKey(q.origin, q.destination, month), month: data });
        } catch {
          break; // the first failure stops the rest: no retries, no hammering a failing or rate-limiting API
        }
      }
    }
  }
  // Months that could not be refreshed: the last stored copy (up to a week old) beats an empty grid, marked stale.
  for (const [i, month] of q.months.entries()) {
    if (byMonth.has(month)) continue;
    const row = stored.get(keys[i] as string);
    if (row && now.getTime() - Date.parse(row.createdAt) < STALE_MAX_HOURS * HOUR_MS) byMonth.set(month, { status: "stale", data: row });
    else byMonth.set(month, { status: why, data: null });
  }
  const upstreamCalls = tp.callCount() - callsBefore;

  if (written.length > 0) {
    const work = writeMonths(deps.db, written).catch(() => undefined); // a failed cache write never fails the answer
    if (deps.waitUntil) deps.waitUntil(work);
    else await work;
  }

  if ([...byMonth.values()].every((m) => m.data === null)) {
    const busy = why === "busy";
    throw new CalendarError("source_unavailable", busy ? "Too many calendar requests right now, try again later" : "No fare source is available right now");
  }
  const fxResult = await fxLoad;
  if (!fxResult.ok) throw new CalendarError("fx_unavailable", "Exchange rates are unavailable");
  const fx = fxResult.v;

  // Every day of the asked months from today on, the cheapest fitting fare per day.
  const today = Math.floor(now.getTime() / DAY_MS);
  const days: CalendarDay[] = [];
  for (const month of q.months) {
    const entry = byMonth.get(month);
    const perDay = new Map<string, NonNullable<CalendarDay["fare"]>>();
    for (const f of entry?.data?.fares ?? []) {
      const nights = (dayNumber(f.returnDate) as number) - (dayNumber(f.departDate) as number);
      if (nights < q.minNights || nights > q.maxNights) continue;
      if (q.maxStops !== null && !(f.stops !== null && f.returnStops !== null && f.stops <= q.maxStops && f.returnStops <= q.maxStops)) continue;
      const rate = fx.ratesToIls[f.currency];
      if (!(typeof rate === "number" && rate > 0)) continue; // never shown in a guessed currency
      const priceIls = round2(f.price * rate);
      const prev = perDay.get(f.departDate);
      if (prev && prev.priceIls <= priceIls) continue;
      perDay.set(f.departDate, {
        priceIls,
        priceAmount: f.price,
        priceCurrency: f.currency,
        returnDate: f.returnDate,
        nights,
        stops: f.stops,
        returnStops: f.returnStops,
        airlines: f.airlines,
        departTime: f.departTime,
        returnTime: f.returnTime,
        deeplink: f.deeplink,
        checkedAt: entry?.data?.createdAt ?? now.toISOString(),
        level: null,
      });
    }
    for (let d = Math.max(today, monthStartDay(month)); d <= monthEndDay(month); d++) {
      const date = isoOfDay(d);
      days.push({ date, known: entry?.data != null, fare: perDay.get(date) ?? null });
    }
  }

  const priced = days.map((d) => d.fare).filter((f): f is NonNullable<CalendarDay["fare"]> => f !== null);
  if (priced.length >= 3) {
    const sorted = priced.map((f) => f.priceIls).sort((a, b) => a - b);
    const low = sorted[Math.floor((sorted.length - 1) / 3)] as number;
    const high = sorted[Math.floor((2 * (sorted.length - 1)) / 3)] as number;
    const flat = sorted[0] === sorted[sorted.length - 1]; // all equal: nothing is cheap or dear relative to the rest
    for (const f of priced) f.level = flat ? "mid" : f.priceIls <= low ? "low" : f.priceIls > high ? "high" : "mid";
  }
  let cheapest: CalendarResponse["meta"]["cheapest"] = null;
  for (const d of days) if (d.fare && (!cheapest || d.fare.priceIls < cheapest.priceIls)) cheapest = { date: d.date, priceIls: d.fare.priceIls };

  return {
    days,
    meta: {
      apiVersion: 1,
      origin: q.origin,
      destination: q.destination,
      minNights: q.minNights,
      maxNights: q.maxNights,
      maxStops: q.maxStops,
      priceBasis: "roundtrip_one_adult",
      months: q.months.map((month) => {
        const e = byMonth.get(month);
        return { month, status: e?.status ?? "unavailable", checkedAt: e?.data?.createdAt ?? null, truncated: e?.data?.truncated ?? false };
      }),
      fromCache: toFetch.length === 0,
      upstreamCalls,
      cheapest,
      fxSource: fx.source,
      fxDate: fx.date,
      source: "travelpayouts",
      noticeHe: CALENDAR_NOTICE_HE,
      ...(days.some((d) => !d.known) ? { unavailableHe: CALENDAR_UNKNOWN_HE } : {}),
      generatedAt: now.toISOString(),
    },
  };
}
