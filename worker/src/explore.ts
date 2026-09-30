/**
 * GET /api/explore: "I don't know where to go" (SPEC goal 4, WEB_APP_SPEC W5). Cheapest round trips from Israel
 * (TLV or ETM) to ANY destination in a month or a date window, optionally for a trip length in nights and under a
 * budget, with Hebrew city names, a booking/search link, and a transparent price/weather/attractiveness score.
 *
 * Data: two FREE Travelpayouts Data API endpoints that are documented to work WITHOUT a destination
 * (https://travelpayouts.github.io/slate/), one call each per calendar month of the window (at most 3 months, so
 * at most 6 upstream requests plus the FX lookup):
 *   - v2/prices/latest  origin only, period_type=month, one_way=false, limit=1000: many date pairs per destination
 *                       with the number of changes. Documented as prices found in the last 48 hours.
 *   - v1/prices/cheap   destination "-" ("for all routes"): the cheapest tickets per destination, with the
 *                       departure instant and an `expires_at`.
 * Both are cached fares (days old), for ONE adult, in USD as requested; the response says so in Hebrew.
 *
 * Cost and limits: per-client rate limit (its own key), one unit of the SAME global scan budget as /api/search per
 * request that needs any upstream call, results cached per (origin, month) in the existing search_cache table under
 * an "explore:" key (no migration; pruned by the daily retention job like every cache row), no retries.
 */
import type { Resolver } from "./airports/types";
import { CLIMATE_SOURCE, weatherFit, type DestinationCategory } from "./explore-climate";
import { MAX_NIGHTS, MIN_NIGHTS, MAX_TEXT_LEN, parseExploreQuery, type NightsRange } from "./explore-text";
import { COUNTRIES_ATTRIBUTION, countryNameHe } from "./countries/countries";
import { bundledHolidays, HOLIDAYS_ATTRIBUTION, type HolidayIndex } from "./holidays";
import { aviasalesSearchLink } from "./travelpayouts";
import type { FxRates } from "./types";

export const LATEST_API = "https://api.travelpayouts.com/v2/prices/latest";
export const CHEAP_API = "https://api.travelpayouts.com/v1/prices/cheap";

export const EXPLORE_ORIGINS: readonly string[] = ["TLV", "ETM"];
export const EXPLORE_MAX_WINDOW_DAYS = 61; // end - start
/** Calendar months a window may touch (checked separately: 61 days can straddle 4). 2 upstream calls per month. */
export const EXPLORE_MAX_MONTHS = 3;
export const EXPLORE_MAX_ADVANCE_DAYS = 365;
export const EXPLORE_DEFAULT_LIMIT = 20;
export const EXPLORE_MAX_LIMIT = 50;
export const EXPLORE_MAX_BUDGET_ILS = 100_000;
export const EXPLORE_CACHE_TTL_HOURS = 6;
/** A month where one of the two endpoints failed is cached this long only, so a lasting outage of one endpoint
 * cannot make every request refetch (and spend the shared scan budget), while the other endpoint's fares return soon. */
export const EXPLORE_PARTIAL_TTL_HOURS = 1;
/** When a refresh is impossible (budget spent, source down) a cached month up to this old is served, marked stale. */
export const EXPLORE_STALE_MAX_HOURS = 48;
/** Per client, like /api/search but counted separately (key "explore:<hash>"). */
export const EXPLORE_RATE_LIMIT_MAX = 30;
export const EXPLORE_RATE_LIMIT_WINDOW_SECONDS = 600;
/** Rows kept per cached month (cheapest first): bounds the D1 row size and the per-request CPU. */
export const EXPLORE_MAX_ROWS_PER_MONTH = 2000;
export const EXPLORE_CACHE_PREFIX = "explore:v1:";

const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const IATA = /^[A-Z0-9]{3}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Score weights (transparent; renormalized over the parts that are known for a result). */
export const SCORE_WEIGHTS = { price: 0.55, weather: 0.25, attractiveness: 0.15, flightTime: 0.05 } as const;

// ---- request parameters ----------------------------------------------------------------------------------

export type ExploreSort = "price" | "score";

export interface ExploreParams {
  origin: string;
  windowStart: string;
  windowEnd: string;
  /** Calendar months ("YYYY-MM") the window touches: one upstream call pair and one cache row each. */
  months: string[];
  nights: NightsRange | null;
  maxPriceIls: number | null;
  sort: ExploreSort;
  limit: number;
  /**
   * Set when the request came with free text (`q`): what was read from it. `missing` / `message` (ADDITIVE) say what
   * could not be read, so the client can tell the user that e.g. no length filter was applied.
   */
  understood: { text: string; nights: NightsRange | null; month: string | null; missing: ("nights" | "month")[]; message: string | null } | null;
}

export type ExploreParamsResult =
  | { ok: true; params: ExploreParams }
  | { ok: false; code: "invalid_request" | "query_not_understood"; message: string; fields: Record<string, string> };

function validDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

function monthsOf(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
  }
  return out;
}

function parseNightsParam(v: string): NightsRange | null {
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a > b || a < MIN_NIGHTS || b > MAX_NIGHTS) return null;
  return { min: a, max: b };
}

/**
 * Query string -> validated parameters. Explicit parameters win over what free text (`q`) says. The window never
 * starts before tomorrow (UTC): today's departures are gone from any cache worth showing.
 */
export function parseExploreParams(sp: URLSearchParams, now: Date): ExploreParamsResult {
  const fields: Record<string, string> = {};
  const get = (k: string): string | null => {
    const v = sp.get(k);
    return v === null || v.trim() === "" ? null : v.trim();
  };

  // Free text first: it only supplies defaults.
  let understood: ExploreParams["understood"] = null;
  const q = sp.get("q");
  if (q !== null && q.trim() !== "") {
    if (q.length > MAX_TEXT_LEN) fields.q = `must be at most ${MAX_TEXT_LEN} characters`;
    else {
      const parsed = parseExploreQuery(q, now);
      // A length that was written but makes no trip is refused, never silently dropped (the filter would vanish).
      if (!parsed.ok || parsed.invalidNights) {
        return { ok: false, code: "query_not_understood", message: parsed.message ?? "", fields: { q: parsed.message ?? "" } };
      }
      understood = { text: q.trim(), nights: parsed.nights, month: parsed.month, missing: parsed.missing, message: parsed.message };
    }
  }

  const origin = (get("origin") ?? "TLV").toUpperCase();
  if (!EXPLORE_ORIGINS.includes(origin)) fields.origin = `must be one of ${EXPLORE_ORIGINS.join(", ")}`;

  const tomorrow = isoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
  const lastDay = isoDay(dayMs(tomorrow) + (EXPLORE_MAX_ADVANCE_DAYS - 1) * DAY_MS);

  let start: string | null = null;
  let end: string | null = null;
  const month = get("month");
  const startP = get("start");
  const endP = get("end");
  if (month !== null) {
    if (startP !== null || endP !== null) fields.month = "send either month or start and end, not both";
    const m = MONTH.exec(month);
    if (!m) fields.month = "must be YYYY-MM";
    else {
      start = `${month}-01`;
      end = isoDay(Date.UTC(Number(m[1]), Number(m[2]), 0));
    }
  } else if (startP !== null || endP !== null) {
    if (startP === null || !validDate(startP)) fields.start = "must be a date YYYY-MM-DD";
    if (endP === null || !validDate(endP)) fields.end = "must be a date YYYY-MM-DD";
    if (!fields.start && !fields.end) {
      start = startP;
      end = endP;
      if ((end as string) < (start as string)) fields.end = "must not be before start";
      else if ((dayMs(end as string) - dayMs(start as string)) / DAY_MS > EXPLORE_MAX_WINDOW_DAYS) {
        fields.end = `the window may span at most ${EXPLORE_MAX_WINDOW_DAYS} days`;
      } else if (monthsOf(start as string, end as string).length > EXPLORE_MAX_MONTHS) {
        // 61 days can straddle 4 calendar months (Dec 31 - Mar 2): that would be 8 upstream calls for one budget unit.
        fields.end = `the window may touch at most ${EXPLORE_MAX_MONTHS} calendar months`;
      }
    }
  } else if (understood?.month) {
    const m = MONTH.exec(understood.month) as RegExpExecArray;
    start = `${understood.month}-01`;
    end = isoDay(Date.UTC(Number(m[1]), Number(m[2]), 0));
  } else {
    fields.month = "month (YYYY-MM) or start and end (YYYY-MM-DD) is required";
    if (understood) fields.q = "לא הבנו באיזה חודש. נסו למשל: \"בנובמבר\" או \"בחודש הבא\".";
  }
  if (start !== null && end !== null && !fields.month && !fields.start && !fields.end) {
    if (end < tomorrow) fields[month !== null || startP === null ? "month" : "end"] = "the window is in the past";
    else if (start > lastDay) fields[month !== null || startP === null ? "month" : "start"] = `must start within ${EXPLORE_MAX_ADVANCE_DAYS} days`;
    else {
      if (start < tomorrow) start = tomorrow;
      if (end > lastDay) end = lastDay;
    }
  }

  let nights: NightsRange | null = understood?.nights ?? null;
  const nightsP = get("nights");
  if (nightsP !== null) {
    nights = parseNightsParam(nightsP);
    if (!nights) fields.nights = `must be N or N-M nights, ${MIN_NIGHTS}-${MAX_NIGHTS}`;
  }

  let maxPriceIls: number | null = null;
  const budget = get("maxPrice");
  if (budget !== null) {
    const n = Number(budget);
    if (!/^\d+$/.test(budget) || !Number.isSafeInteger(n) || n < 1 || n > EXPLORE_MAX_BUDGET_ILS) {
      fields.maxPrice = `must be a whole number of shekels, 1-${EXPLORE_MAX_BUDGET_ILS}`;
    } else maxPriceIls = n;
  }

  const sortP = get("sort") ?? "price";
  if (sortP !== "price" && sortP !== "score") fields.sort = "must be price or score";

  let limit = EXPLORE_DEFAULT_LIMIT;
  const limitP = get("limit");
  if (limitP !== null) {
    const n = Number(limitP);
    if (!/^\d+$/.test(limitP) || n < 1) fields.limit = `must be 1-${EXPLORE_MAX_LIMIT}`;
    else limit = Math.min(n, EXPLORE_MAX_LIMIT);
  }

  if (Object.keys(fields).length > 0) return { ok: false, code: "invalid_request", message: "The explore request is invalid", fields };
  return {
    ok: true,
    params: {
      origin,
      windowStart: start as string,
      windowEnd: end as string,
      months: monthsOf(start as string, end as string),
      nights,
      maxPriceIls,
      sort: sortP as ExploreSort,
      limit,
      understood,
    },
  };
}

// ---- upstream --------------------------------------------------------------------------------------------

export class ExploreError extends Error {
  readonly code: "source_unavailable" | "fx_unavailable";
  constructor(code: "source_unavailable" | "fx_unavailable", message: string) {
    super(message);
    this.name = "ExploreError";
    this.code = code;
  }
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

function positive(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const dateOf = (v: unknown): string | null => (typeof v === "string" && validDate(v.slice(0, 10)) ? v.slice(0, 10) : null);
const code = (v: unknown): string | null => (typeof v === "string" && IATA.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);
const stopsOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5 ? v : null);

const ISRAEL_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Departure wall-clock time in Israel ("HH:MM") for an instant WITH an explicit offset ("Z" or +hh:mm). Explore
 * departures are all from Israel, so this is the local departure time. No offset = ambiguous = null.
 */
export function israelTime(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const out = ISRAEL_TIME.format(new Date(ms));
  return /^\d{2}:\d{2}$/.test(out) ? out : null;
}

/** One cached candidate fare. Compact on purpose: a month holds up to EXPLORE_MAX_ROWS_PER_MONTH of them. */
export interface Candidate {
  dest: string;
  depart: string;
  ret: string;
  usd: number;
  stops: number | null;
  /** Outbound departure time in Israel, when the source gave an instant. */
  departTime: string | null;
  foundAt: string | null;
  expiresAt: string | null;
}

export interface CityInfo {
  nameHe: string | null;
  nameEn: string | null;
  countryCode: string | null;
  popularity: number | null;
}

interface MonthData {
  rows: Candidate[];
  names: Record<string, CityInfo>;
  createdAt: string;
  /** One of the two endpoints failed for this month. */
  partial: boolean;
}

export interface ExploreDeps {
  db: D1Database;
  token?: string;
  marker?: string;
  fetchFn: typeof fetch;
  now: Date;
  resolver: Resolver;
  /** Takes one unit of the global scan budget; false = spent (no upstream call is made). */
  scanBudget: () => Promise<boolean>;
  fx: () => Promise<FxRates>;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Holiday table; defaults to the bundled one (tests inject a fixture). */
  holidays?: HolidayIndex;
}

async function getJson(deps: ExploreDeps, token: string, url: string): Promise<Row> {
  let res: Response;
  let text: string;
  try {
    res = await deps.fetchFn(url, {
      method: "GET",
      headers: { "X-Access-Token": token, Accept: "application/json" },
      redirect: "manual", // never follow a redirect with the token attached
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new Error("network");
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
  if (!isRow(body) || body.success !== true) throw new Error("API error");
  // We ask for USD; anything else would be mislabelled, so it is refused rather than guessed.
  if (typeof body.currency === "string" && body.currency.toLowerCase() !== "usd") throw new Error("unexpected currency");
  return body;
}

function latestRows(body: Row, origin: string, now: Date): Candidate[] {
  if (!Array.isArray(body.data)) throw new Error("unexpected response");
  const out: Candidate[] = [];
  for (const r of body.data) {
    if (!isRow(r)) continue;
    if (r.actual === false) continue; // the API's own "no longer valid" marker
    if (r.trip_class !== undefined && r.trip_class !== 0) continue; // economy only
    const from = code(r.origin);
    if (from !== null && from !== origin) continue;
    const dest = code(r.destination);
    const depart = dateOf(r.depart_date);
    const ret = dateOf(r.return_date);
    const usd = positive(r.value);
    if (!dest || !depart || !ret || usd === null || ret <= depart) continue;
    const foundAt = typeof r.found_at === "string" && Number.isFinite(Date.parse(r.found_at)) ? new Date(Date.parse(r.found_at)).toISOString() : null;
    if (foundAt !== null && foundAt > now.toISOString()) continue;
    out.push({ dest, depart, ret, usd, stops: stopsOf(r.number_of_changes), departTime: null, foundAt, expiresAt: null });
  }
  return out;
}

function cheapRows(body: Row): Candidate[] {
  if (!isRow(body.data)) throw new Error("unexpected response");
  const out: Candidate[] = [];
  for (const [key, byIndex] of Object.entries(body.data)) {
    const dest = code(key);
    if (!dest || !isRow(byIndex)) continue;
    // The keys "0", "1", "2" are documented as sequence numbers, so they are NOT read as stop counts.
    for (const r of Object.values(byIndex)) {
      if (!isRow(r)) continue;
      const depart = dateOf(r.departure_at);
      const ret = dateOf(r.return_at);
      const usd = positive(r.price);
      if (!depart || !ret || usd === null || ret <= depart) continue;
      const exp = typeof r.expires_at === "string" && Number.isFinite(Date.parse(r.expires_at)) ? new Date(Date.parse(r.expires_at)).toISOString() : null;
      out.push({ dest, depart, ret, usd, stops: null, departTime: israelTime(r.departure_at), foundAt: null, expiresAt: exp });
    }
  }
  return out;
}

/** One fare per (destination, dates): the cheapest; at equal price the one that knows more wins. Cheapest rows kept. */
export function mergeCandidates(rows: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  const known = (c: Candidate) => (c.departTime ? 1 : 0) + (c.stops !== null ? 1 : 0);
  for (const c of rows) {
    const key = `${c.dest}|${c.depart}|${c.ret}`;
    const cur = best.get(key);
    if (!cur || c.usd < cur.usd || (c.usd === cur.usd && known(c) > known(cur))) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => a.usd - b.usd || a.dest.localeCompare(b.dest) || a.depart.localeCompare(b.depart)).slice(0, EXPLORE_MAX_ROWS_PER_MONTH);
}

/** Hebrew/English names, country and popularity from the D1 airports table; the bundled resolver fills gaps. */
export async function cityInfo(db: D1Database, resolver: Resolver, codes: string[]): Promise<Record<string, CityInfo>> {
  const out: Record<string, CityInfo> = {};
  const list = [...new Set(codes)];
  if (list.length === 0) return out;
  try {
    const json = JSON.stringify(list);
    const res = await db
      .prepare(
        "SELECT iata, city_iata, city_he, city_en, country_code, popularity FROM airports " +
          "WHERE city_iata IN (SELECT value FROM json_each(?)) OR iata IN (SELECT value FROM json_each(?))",
      )
      .bind(json, json)
      .all<{ iata: string; city_iata: string | null; city_he: string | null; city_en: string | null; country_code: string | null; popularity: number | null }>();
    const wanted = new Set(list);
    // A city-code match beats an airport-code match; within a city the most popular airport row wins.
    const rank = new Map<string, number>();
    for (const r of res.results ?? []) {
      for (const [c, score] of [
        [r.city_iata, 2],
        [r.iata, 1],
      ] as const) {
        if (!c || !wanted.has(c)) continue;
        const s = score * 1000 + (r.popularity ?? 0);
        if ((rank.get(c) ?? -1) >= s) continue;
        rank.set(c, s);
        out[c] = {
          nameHe: r.city_he && r.city_he.trim() ? r.city_he : null,
          nameEn: r.city_en && r.city_en.trim() ? r.city_en : null,
          countryCode: r.country_code ?? null,
          popularity: typeof r.popularity === "number" ? r.popularity : null,
        };
      }
    }
  } catch {
    // The table is a convenience: the bundled dataset below still names every city it knows.
  }
  for (const c of list) {
    const got = out[c];
    const he = got?.nameHe ?? resolver.cityNameHe(c);
    const en = got?.nameEn ?? resolver.cityNameEn(c);
    const cc = got?.countryCode ?? resolver.countryOfAirport(c);
    out[c] = { nameHe: he ?? null, nameEn: en ?? null, countryCode: cc ?? null, popularity: got?.popularity ?? null };
  }
  return out;
}

async function fetchMonth(deps: ExploreDeps, token: string, origin: string, month: string): Promise<MonthData> {
  const latest = new URLSearchParams({
    origin,
    currency: "usd",
    period_type: "month",
    beginning_of_period: `${month}-01`,
    one_way: "false",
    page: "1",
    limit: "1000",
    show_to_affiliates: "false",
    sorting: "price",
    trip_class: "0",
  });
  const cheap = new URLSearchParams({ origin, destination: "-", depart_date: month, currency: "usd" });
  // Sequential, no retries. Either endpoint alone is a usable answer; both failing fails the month.
  const rows: Candidate[] = [];
  let ok = 0;
  try {
    rows.push(...latestRows(await getJson(deps, token, `${LATEST_API}?${latest.toString()}`), origin, deps.now));
    ok += 1;
  } catch {
    /* counted below */
  }
  try {
    rows.push(...cheapRows(await getJson(deps, token, `${CHEAP_API}?${cheap.toString()}`)));
    ok += 1;
  } catch {
    /* counted below */
  }
  if (ok === 0) throw new Error("both endpoints failed");
  const merged = mergeCandidates(rows.filter((r) => r.dest !== origin && r.depart.startsWith(month)));
  const names = await cityInfo(deps.db, deps.resolver, merged.map((r) => r.dest));
  const data: MonthData = { rows: merged, names, createdAt: deps.now.toISOString(), partial: ok < 2 };
  // A half answer is cached too, but only for EXPLORE_PARTIAL_TTL_HOURS (see there).
  const write = writeCache(deps.db, origin, month, data).catch(() => undefined);
  if (deps.waitUntil) deps.waitUntil(write);
  else await write;
  return data;
}

// ---- cache (search_cache rows under an "explore:" key) -----------------------------------------------------

type PackedRow = [string, string, string, number, number | null, string | null, string | null, string | null];
type PackedName = [string | null, string | null, string | null, number | null];

export const exploreCacheKey = (origin: string, month: string): string => `${EXPLORE_CACHE_PREFIX}${origin}:${month}`;

async function writeCache(db: D1Database, origin: string, month: string, data: MonthData): Promise<void> {
  const payload = {
    v: 1,
    partial: data.partial,
    rows: data.rows.map((r): PackedRow => [r.dest, r.depart, r.ret, r.usd, r.stops, r.departTime, r.foundAt, r.expiresAt]),
    names: Object.fromEntries(Object.entries(data.names).map(([k, n]): [string, PackedName] => [k, [n.nameHe, n.nameEn, n.countryCode, n.popularity]])),
  };
  await db
    .prepare(
      "INSERT INTO search_cache (search_key, offers_json, extra_json, created_at) VALUES (?, ?, NULL, ?) " +
        "ON CONFLICT(search_key) DO UPDATE SET offers_json = excluded.offers_json, extra_json = NULL, created_at = excluded.created_at",
    )
    .bind(exploreCacheKey(origin, month), JSON.stringify(payload), data.createdAt)
    .run();
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A cached month, or null when absent/unreadable. Every field is re-checked: the row is data, not trusted code. */
async function readCache(db: D1Database, origin: string, month: string): Promise<MonthData | null> {
  try {
    const row = await db
      .prepare("SELECT offers_json, created_at FROM search_cache WHERE search_key = ?")
      .bind(exploreCacheKey(origin, month))
      .first<{ offers_json: string; created_at: string }>();
    if (!row || !Number.isFinite(Date.parse(row.created_at))) return null;
    const payload: unknown = JSON.parse(row.offers_json);
    if (!isRow(payload) || payload.v !== 1 || !Array.isArray(payload.rows) || !isRow(payload.names)) return null;
    const rows: Candidate[] = [];
    for (const p of payload.rows) {
      if (!Array.isArray(p)) continue;
      const dest = code(p[0]);
      const depart = dateOf(p[1]);
      const ret = dateOf(p[2]);
      const usd = positive(p[3]);
      if (!dest || !depart || !ret || usd === null) continue;
      const t = str(p[5]);
      rows.push({ dest, depart, ret, usd, stops: stopsOf(p[4]), departTime: t && /^\d{2}:\d{2}$/.test(t) ? t : null, foundAt: str(p[6]), expiresAt: str(p[7]) });
    }
    const names: Record<string, CityInfo> = {};
    for (const [k, v] of Object.entries(payload.names)) {
      const c = code(k); // only IATA codes: a key like "__proto__" is never written
      if (!c || c !== k || !Array.isArray(v)) continue;
      names[c] = { nameHe: str(v[0]), nameEn: str(v[1]), countryCode: str(v[2]), popularity: num(v[3]) };
    }
    return { rows, names, createdAt: row.created_at, partial: payload.partial === true };
  } catch {
    return null;
  }
}

// ---- ranking ------------------------------------------------------------------------------------------------

export interface ScoreBreakdown {
  /** Weighted mean of the known parts, 0-100 (higher is better). */
  total: number;
  /** 100 x cheapest price / this price, among the results after filters. */
  price: number;
  /** null when the city is not in the bundled climate table. */
  weather: number | null;
  /** The city dataset's popularity rank 1-100 (airports table; hand-assigned, used to order search suggestions), null when unknown. */
  attractiveness: number | null;
  /** Outbound departure hour in Israel: 100 for 07:00-21:59, 60 for 05:00-06:59 and 22:00-23:59, 20 at night. null when unknown. */
  flightTime: number | null;
  weights: typeof SCORE_WEIGHTS;
}

export function flightTimeScore(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const h = Number(hhmm.slice(0, 2));
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (h >= 7 && h <= 21) return 100;
  if (h === 5 || h === 6 || h === 22 || h === 23) return 60;
  return 20;
}

export function combineScore(parts: Omit<ScoreBreakdown, "total" | "weights">): number {
  let sum = 0;
  let weight = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as (keyof typeof SCORE_WEIGHTS)[]) {
    const v = parts[k];
    if (v === null) continue;
    sum += SCORE_WEIGHTS[k] * v;
    weight += SCORE_WEIGHTS[k];
  }
  return weight > 0 ? Math.round(sum / weight) : 0;
}

export interface ExploreResult {
  /** countryHe: Hebrew name of countryCode from Unicode CLDR (countries/countries.ts), e.g. "יוון". additive; null when unknown. */
  destination: { code: string; nameHe: string | null; nameEn: string | null; countryCode: string | null; countryHe: string | null; category: DestinationCategory | null };
  departDate: string;
  returnDate: string;
  nights: number;
  /** For ONE adult, round trip, as the cached fare was found. `ils` is converted at today's rate. */
  price: { amount: number; currency: "USD"; ils: number };
  stops: number | null;
  /** Outbound departure time in Israel ("HH:MM"), null when the source did not give it. */
  departTime: string | null;
  foundAt: string | null;
  expiresAt: string | null;
  links: { book: string | null };
  /** Ready-made body for POST /api/search on exactly these dates, to check live prices for the whole party. */
  search: { origin: string; destination: string; windowStart: string; windowEnd: string; stayMin: number; stayMax: number };
  score: ScoreBreakdown;
  climate: { month: number; tmaxC: number; rainDays: number; approximate: true } | null;
  /**
   * Israeli holidays between departDate and returnDate (both included), distinct Hebrew names in date order, e.g.
   * "סוכות, שמיני עצרת" (holidays.ts, Hebcal Israel schedule). additive; null when none is known (days outside the
   * bundled table's range are unknown, never assumed holiday-free for vacationDaysUsed).
   */
  holidayHe: string | null;
  /**
   * Work days the trip takes off: Sunday-Thursday days from departDate to returnDate (both included) that are not yom
   * tov. Other days off (e.g. Yom HaAtzmaut, erev chag half days, chol hamoed) are NOT subtracted. additive; null when
   * any day of the trip is outside the bundled table's range.
   */
  vacationDaysUsed: number | null;
}

export interface ExploreResponse {
  results: ExploreResult[];
  meta: {
    origin: { code: string; nameHe: string | null };
    window: { start: string; end: string };
    nights: NightsRange | null;
    maxPriceIls: number | null;
    sort: ExploreSort;
    understood: ExploreParams["understood"];
    /** Destinations with at least one fare in the window, before the nights/budget filters. */
    destinationsFound: number;
    /** Destinations left after every filter (results holds at most `limit` of them). */
    destinationsMatching: number;
    cached: boolean;
    stale: boolean;
    partial: boolean;
    /** Oldest data used (the cache row's time, or now for a fresh fetch). */
    checkedAt: string;
    sources: string[];
    fx: { date: string; source: string };
    climateSource: string;
    /** Credit for results[].holidayHe and vacationDaysUsed (additive): "Hebcal.com, CC BY 4.0". */
    holidaysAttribution: string;
    /** Credit for results[].destination.countryHe (additive): "Unicode CLDR, Unicode License V3". */
    countriesAttribution: string;
    notes: string[];
  };
}

const NOTE = {
  basis: "המחירים הם מחירי מטמון שנמצאו בחיפושים של משתמשים בימים האחרונים, הלוך-חזור למבוגר אחד. המחיר העדכני ייבדק בקישור ההזמנה ועשוי להיות שונה.",
  weather: "נתוני מזג האוויר הם ממוצעים רב-שנתיים משוערים לחודש, לא תחזית.",
  stale: "לא ניתן היה לרענן את כל הנתונים כעת, ולכן חלק מהתוצאות מבוססות על נתונים ישנים יותר (עד 48 שעות).",
  partial: "לא הצלחנו לבדוק את כל הטווח שביקשת, ולכן ייתכן שיש יעדים זולים נוספים.",
  noNights: "לא הבנו מהטקסט לכמה לילות, ולכן התוצאות אינן מסוננות לפי אורך הטיול.",
  budget: (n: number) => `${n} יעדים נוספים נמצאו מעל התקציב שהגדרת.`,
} as const;

const ageHours = (iso: string, now: Date): number => (now.getTime() - Date.parse(iso)) / 3_600_000;

/** Throws ExploreError when no month has any data (fresh, cached or stale) or when FX is unavailable. */
export async function runExplore(deps: ExploreDeps, params: ExploreParams): Promise<ExploreResponse> {
  const { now } = deps;
  const token = (deps.token ?? "").trim();
  const marker = (deps.marker ?? "").trim();

  const months: (MonthData | null)[] = [];
  const cachedRows: (MonthData | null)[] = [];
  const need: number[] = [];
  for (const [i, m] of params.months.entries()) {
    const hit = await readCache(deps.db, params.origin, m);
    cachedRows.push(hit);
    const ttl = hit?.partial ? EXPLORE_PARTIAL_TTL_HOURS : EXPLORE_CACHE_TTL_HOURS;
    const fresh = hit && ageHours(hit.createdAt, now) <= ttl && ageHours(hit.createdAt, now) >= -0.1;
    months.push(fresh ? hit : null);
    if (!fresh) need.push(i);
  }

  let stale = false;
  let fetched = false;
  if (need.length > 0) {
    const allowed = token !== "" && (await deps.scanBudget());
    for (const i of need) {
      let data: MonthData | null = null;
      if (allowed) {
        try {
          data = await fetchMonth(deps, token, params.origin, params.months[i] as string);
          fetched = true;
        } catch {
          data = null;
        }
      }
      if (!data) {
        const old = cachedRows[i];
        if (old && ageHours(old.createdAt, now) <= EXPLORE_STALE_MAX_HOURS) {
          data = old;
          stale = true;
        }
      }
      months[i] = data;
    }
  }
  const available = months.filter((m): m is MonthData => m !== null);
  if (available.length === 0) throw new ExploreError("source_unavailable", "No fare source is available right now");
  const partial = available.length < months.length || available.some((m) => m.partial);

  let fx: FxRates;
  try {
    fx = await deps.fx();
  } catch {
    throw new ExploreError("fx_unavailable", "Exchange rates are unavailable");
  }
  const usdRate = fx.ratesToIls.USD;
  if (typeof usdRate !== "number" || !(usdRate > 0)) throw new ExploreError("fx_unavailable", "Exchange rates are unavailable");

  const names: Record<string, CityInfo> = {};
  for (const m of available) Object.assign(names, m.names);
  const info = (c: string): CityInfo =>
    names[c] ?? { nameHe: deps.resolver.cityNameHe(c), nameEn: deps.resolver.cityNameEn(c), countryCode: deps.resolver.countryOfAirport(c), popularity: null };

  const nowIso = now.toISOString();
  const originCountry = "IL";
  // Cheapest valid fare per destination inside the window (and the nights range, when set).
  const inWindow = new Map<string, true>();
  const bestPerDest = new Map<string, Candidate>();
  for (const m of available) {
    for (const c of m.rows) {
      if (c.depart < params.windowStart || c.depart > params.windowEnd || c.ret <= c.depart) continue;
      if (c.expiresAt !== null && c.expiresAt < nowIso) continue;
      if (c.dest === params.origin || info(c.dest).countryCode === originCountry) continue; // abroad only
      inWindow.set(c.dest, true);
      const nights = Math.round((dayMs(c.ret) - dayMs(c.depart)) / DAY_MS);
      if (params.nights && (nights < params.nights.min || nights > params.nights.max)) continue;
      const cur = bestPerDest.get(c.dest);
      if (!cur || c.usd < cur.usd || (c.usd === cur.usd && (c.depart < cur.depart || (c.depart === cur.depart && c.ret < cur.ret)))) bestPerDest.set(c.dest, c);
    }
  }

  const ils = (usd: number): number => Math.round(usd * usdRate);
  let picked = [...bestPerDest.values()];
  let overBudget = 0;
  if (params.maxPriceIls !== null) {
    const within = picked.filter((c) => ils(c.usd) <= (params.maxPriceIls as number));
    overBudget = picked.length - within.length;
    picked = within;
  }
  const holidays = deps.holidays ?? bundledHolidays;
  const minUsd = picked.reduce((m, c) => Math.min(m, c.usd), Number.POSITIVE_INFINITY);

  const results: ExploreResult[] = picked.map((c) => {
    const city = info(c.dest);
    const departMonth = Number(c.depart.slice(5, 7));
    const w = weatherFit(c.dest, departMonth);
    const nights = Math.round((dayMs(c.ret) - dayMs(c.depart)) / DAY_MS);
    const parts = {
      price: Math.round((100 * minUsd) / c.usd),
      weather: w ? w.score : null,
      attractiveness: city.popularity !== null && city.popularity >= 1 && city.popularity <= 100 ? city.popularity : null,
      flightTime: flightTimeScore(c.departTime),
    };
    let book: string | null = null;
    try {
      book = aviasalesSearchLink(params.origin, c.dest, c.depart, c.ret, 1, marker);
    } catch {
      book = null;
    }
    return {
      destination: { code: c.dest, nameHe: city.nameHe, nameEn: city.nameEn, countryCode: city.countryCode, countryHe: countryNameHe(city.countryCode), category: w ? w.category : null },
      departDate: c.depart,
      returnDate: c.ret,
      nights,
      price: { amount: c.usd, currency: "USD", ils: ils(c.usd) },
      stops: c.stops,
      departTime: c.departTime,
      foundAt: c.foundAt,
      expiresAt: c.expiresAt,
      links: { book },
      search: { origin: params.origin, destination: c.dest, windowStart: c.depart, windowEnd: c.ret, stayMin: nights, stayMax: nights },
      score: { total: combineScore(parts), ...parts, weights: SCORE_WEIGHTS },
      climate: w ? { month: departMonth, tmaxC: w.tmaxC, rainDays: w.rainDays, approximate: true } : null,
      holidayHe: holidays.holidayHeBetween(c.depart, c.ret),
      vacationDaysUsed: holidays.vacationDaysUsed(c.depart, c.ret),
    };
  });

  results.sort((a, b) =>
    params.sort === "score"
      ? b.score.total - a.score.total || a.price.amount - b.price.amount || a.destination.code.localeCompare(b.destination.code)
      : a.price.amount - b.price.amount || a.destination.code.localeCompare(b.destination.code),
  );

  const notes: string[] = [NOTE.basis];
  // Free text whose length could not be read: say that no length filter was applied (explicit nights= overrides).
  if (params.understood?.missing.includes("nights") && params.nights === null) notes.push(NOTE.noNights);
  if (results.some((r) => r.climate)) notes.push(NOTE.weather);
  if (stale) notes.push(NOTE.stale);
  if (partial) notes.push(NOTE.partial);
  if (overBudget > 0) notes.push(NOTE.budget(overBudget));

  const oldest = available.reduce((o, m) => (m.createdAt < o ? m.createdAt : o), nowIso);
  return {
    results: results.slice(0, params.limit),
    meta: {
      origin: { code: params.origin, nameHe: deps.resolver.cityNameHe(params.origin) },
      window: { start: params.windowStart, end: params.windowEnd },
      nights: params.nights,
      maxPriceIls: params.maxPriceIls,
      sort: params.sort,
      understood: params.understood,
      destinationsFound: inWindow.size,
      destinationsMatching: results.length,
      cached: !fetched,
      stale,
      partial,
      checkedAt: oldest,
      sources: ["travelpayouts:v2/prices/latest", "travelpayouts:v1/prices/cheap"],
      fx: { date: fx.date, source: fx.source },
      climateSource: CLIMATE_SOURCE,
      holidaysAttribution: HOLIDAYS_ATTRIBUTION,
      countriesAttribution: COUNTRIES_ATTRIBUTION,
      notes,
    },
  };
}
