/**
 * GET /api/explore end to end through the Worker's fetch handler, with a stubbed network and the in-memory D1
 * (all migrations applied, so the airports table holds the real seed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import { CLIMATE, weatherFit } from "../src/explore-climate";
import {
  CHEAP_API,
  combineScore,
  EXPLORE_CACHE_TTL_HOURS,
  EXPLORE_MAX_ROWS_PER_MONTH,
  EXPLORE_PARTIAL_TTL_HOURS,
  EXPLORE_RATE_LIMIT_MAX,
  exploreCacheKey,
  flightTimeScore,
  israelTime,
  LATEST_API,
  mergeCandidates,
  parseExploreParams,
  runExplore,
  type Candidate,
  type ExploreResponse,
} from "../src/explore";
import { bundledHolidays, buildHolidayIndex, HOLIDAYS_ATTRIBUTION } from "../src/holidays";
import { COUNTRIES_ATTRIBUTION, countryNameHe } from "../src/countries/countries";
import { defaultResolver } from "../src/pipeline";
import type { Env } from "../src/types";
import { GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS } from "../src/validate";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const TOKEN = "tp-SECRET-token-0123456789abcdef";
const BASE = "https://api.example.test";
const IP = "203.0.113.9";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Rows for TLV, November 2026. See the expectations in the first test.
const LATEST = {
  success: true,
  currency: "usd",
  data: [
    { origin: "TLV", destination: "ATH", depart_date: "2026-11-05", return_date: "2026-11-09", number_of_changes: 0, value: 120, found_at: "2026-09-30T10:00:00+03:00", actual: true, trip_class: 0 },
    { origin: "TLV", destination: "ATH", depart_date: "2026-11-10", return_date: "2026-11-13", number_of_changes: 0, value: 99, found_at: "2026-09-30T10:00:00+03:00", actual: true, trip_class: 0 },
    { origin: "TLV", destination: "BUD", depart_date: "2026-11-12", return_date: "2026-11-16", number_of_changes: 1, value: 150, found_at: "2026-09-29T08:00:00Z", actual: true, trip_class: 0 },
    { origin: "TLV", destination: "ETM", depart_date: "2026-11-03", return_date: "2026-11-05", number_of_changes: 0, value: 40, actual: true, trip_class: 0 }, // domestic
    { origin: "TLV", destination: "PRG", depart_date: "2026-11-20", return_date: "2026-11-24", number_of_changes: 0, value: 30, actual: false, trip_class: 0 }, // no longer valid
    { origin: "TLV", destination: "VIE", depart_date: "2026-11-20", return_date: "2026-11-24", number_of_changes: 0, value: 20, actual: true, trip_class: 1 }, // business
    { origin: "TLV", destination: "ROM", depart_date: "2026-11-20", return_date: "2026-11-24", number_of_changes: 0, value: 25, actual: true, trip_class: 0, extra: "x" },
    { origin: "TLV", destination: "QQQ", depart_date: "2026-11-06", return_date: "2026-11-10", number_of_changes: 2, value: 200, actual: true, trip_class: 0 }, // not in any dataset
    { origin: "TLV", destination: "MIL", depart_date: "2026-11-06", return_date: "2026-11-06", value: 10, actual: true }, // same-day return: no nights
    { origin: "TLV", destination: "PAR", depart_date: "2026-11-06", value: 10, actual: true }, // one-way
    "junk",
  ],
};
const CHEAP = {
  success: true,
  currency: "usd",
  data: {
    LCA: { "0": { price: 70, airline: "W6", flight_number: 1, departure_at: "2026-11-07T04:30:00Z", return_at: "2026-11-11T20:00:00Z", expires_at: "2026-10-05T00:00:00Z" } },
    BCN: { "1": { price: 60, airline: "LY", departure_at: "2026-11-14T10:00:00Z", return_at: "2026-11-18T10:00:00Z", expires_at: "2026-09-30T00:00:00Z" } }, // expired
    // Same dates as a latest row for ROM but pricier: the cheaper one wins.
    ROM: { "0": { price: 26, departure_at: "2026-11-20T08:00:00Z", return_at: "2026-11-24T10:00:00Z", expires_at: "2026-10-09T00:00:00Z" } },
  },
};

interface Stub {
  latest?: (url: URL) => Response | Promise<Response>;
  cheap?: (url: URL) => Response | Promise<Response>;
}

function stubUpstream(opts: Stub = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init: init ?? {} });
      if (url.href.startsWith(LATEST_API)) return (opts.latest ?? (() => json(LATEST)))(url);
      if (url.href.startsWith(CHEAP_API)) return (opts.cheap ?? (() => json(CHEAP)))(url);
      if (url.hostname === "boi.org.il") return json({ exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }] });
      if (url.hostname === "open.er-api.com") return json({ result: "success", rates: { USD: 0.2778 } });
      throw new Error(`unexpected outbound call to ${url.href}`);
    }),
  );
  return { calls, tp: () => calls.filter((c) => c.url.hostname === "api.travelpayouts.com") };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: TOKEN, TRAVELPAYOUTS_MARKER: "12345", ...over };
}

async function call(env: Env, path: string, ip = IP): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, { headers: { "CF-Connecting-IP": ip } }), env, ctx);
  await Promise.all(pending);
  return res;
}

type Body = ExploreResponse & { error?: { code: string; message: string; fields?: Record<string, string> } };
const explore = async (env: Env, query: string, ip = IP) => {
  const res = await call(env, `/api/explore?${query}`, ip);
  return { res, data: (await res.json()) as Body };
};
const codes = (d: Body) => d.results.map((r) => r.destination.code);

async function spendGlobalBudget(env: Env): Promise<void> {
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const start = Math.floor(nowSec / GLOBAL_SCAN_WINDOW_SECONDS) * GLOBAL_SCAN_WINDOW_SECONDS;
  await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?) ON CONFLICT(key, window_start) DO UPDATE SET count = excluded.count")
    .bind(start, GLOBAL_SCAN_LIMIT + 5)
    .run();
}

async function ageCache(env: Env, hours: number): Promise<void> {
  const at = new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  await env.DB.prepare("UPDATE search_cache SET created_at = ? WHERE search_key LIKE 'explore:%'").bind(at).run();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/explore: results", () => {
  it("cheapest round trip per destination abroad, by price, with Hebrew names from the airports table and a booking link", async () => {
    const up = stubUpstream();
    const { res, data } = await explore(makeEnv(), "origin=TLV&month=2026-11");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // ROM 25 (latest beats cheap's 26 on the same dates), LCA 70, ATH 99 (cheaper of two), BUD 150, QQQ 200.
    // Out: ETM (Israel), PRG (actual=false), VIE (business), BCN (expired), MIL (0 nights), PAR (one-way).
    expect(codes(data)).toEqual(["ROM", "LCA", "ATH", "BUD", "QQQ"]);
    const [rom, lca, ath, bud, qqq] = data.results;
    expect(ath).toMatchObject({
      destination: { code: "ATH", nameHe: "אתונה", nameEn: "Athens", countryCode: "GR", countryHe: "יוון", category: "city" },
      departDate: "2026-11-10",
      returnDate: "2026-11-13",
      nights: 3,
      price: { amount: 99, currency: "USD", ils: Math.round(99 * 3.6) },
      stops: 0,
      departTime: null,
      search: { origin: "TLV", destination: "ATH", windowStart: "2026-11-10", windowEnd: "2026-11-13", stayMin: 3, stayMax: 3 },
    });
    expect(ath?.links.book).toBe("https://www.aviasales.com/search/TLV1011ATH13111?marker=12345");
    expect(lca).toMatchObject({ destination: { nameHe: "לרנקה" }, departTime: "06:30", stops: null, expiresAt: "2026-10-05T00:00:00.000Z" });
    expect(bud?.stops).toBe(1);
    expect(rom?.price.amount).toBe(25);
    expect(qqq?.destination).toEqual({ code: "QQQ", nameHe: null, nameEn: null, countryCode: null, countryHe: null, category: null });
    expect(data.meta).toMatchObject({
      origin: { code: "TLV", nameHe: "תל אביב" },
      window: { start: "2026-11-01", end: "2026-11-30" },
      sort: "price",
      cached: false,
      stale: false,
      partial: false,
      destinationsFound: 5,
      destinationsMatching: 5,
      fx: { source: "bank_of_israel" },
    });
    expect(data.meta.notes[0]).toMatch(/למבוגר אחד/);
    // Exactly one call per endpoint, token in the header only, never in a URL; no redirect following.
    expect(up.tp()).toHaveLength(2);
    for (const c of up.tp()) {
      expect(c.url.href).not.toContain(TOKEN);
      expect((c.init.headers as Record<string, string>)["X-Access-Token"]).toBe(TOKEN);
      expect(c.init.redirect).toBe("manual");
    }
    const latest = up.tp().find((c) => c.url.pathname === "/v2/prices/latest")?.url.searchParams;
    expect(Object.fromEntries(latest ?? [])).toMatchObject({ origin: "TLV", period_type: "month", beginning_of_period: "2026-11-01", one_way: "false", currency: "usd", limit: "1000" });
    const cheap = up.tp().find((c) => c.url.pathname === "/v1/prices/cheap")?.url.searchParams;
    expect(Object.fromEntries(cheap ?? [])).toEqual({ origin: "TLV", destination: "-", depart_date: "2026-11", currency: "usd" });
  });

  it("serves the second request from the D1 cache: no upstream call, no scan budget taken", async () => {
    const env = makeEnv();
    const up = stubUpstream();
    await explore(env, "month=2026-11");
    const first = await env.DB.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE key = 'global:scan'").first<{ n: number }>();
    expect(first?.n).toBe(1);
    const { data } = await explore(env, "month=2026-11&nights=4");
    expect(up.tp()).toHaveLength(2);
    expect(data.meta.cached).toBe(true);
    const second = await env.DB.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE key = 'global:scan'").first<{ n: number }>();
    expect(second?.n).toBe(1);
    const row = await env.DB.prepare("SELECT search_key FROM search_cache").all<{ search_key: string }>();
    expect(row.results.map((r) => r.search_key)).toEqual([exploreCacheKey("TLV", "2026-11")]);
  });

  it("refreshes a cache row older than the TTL", async () => {
    const env = makeEnv();
    const up = stubUpstream();
    await explore(env, "month=2026-11");
    await ageCache(env, EXPLORE_CACHE_TTL_HOURS + 1);
    const { data } = await explore(env, "month=2026-11");
    expect(up.tp()).toHaveLength(4);
    expect(data.meta.cached).toBe(false);
  });

  it("nights=4 keeps only 4-night trips (ATH switches to its 4-night fare)", async () => {
    stubUpstream();
    const { data } = await explore(makeEnv(), "month=2026-11&nights=4");
    expect(codes(data)).toEqual(["ROM", "LCA", "ATH", "BUD", "QQQ"]);
    expect(data.results.every((r) => r.nights === 4)).toBe(true);
    expect(data.results.find((r) => r.destination.code === "ATH")?.price.amount).toBe(120);
    expect(data.meta.destinationsFound).toBe(5);
  });

  it("nights=3 range and a budget: over-budget destinations are counted in a Hebrew note, not hidden silently", async () => {
    stubUpstream();
    const { data } = await explore(makeEnv(), "month=2026-11&nights=3-4&maxPrice=400");
    // ILS at 3.6: ROM 90, LCA 252, ATH 356 (99$), BUD 540, QQQ 720.
    expect(codes(data)).toEqual(["ROM", "LCA", "ATH"]);
    expect(data.meta.maxPriceIls).toBe(400);
    expect(data.meta.notes.some((n) => n.includes("2 יעדים נוספים"))).toBe(true);
  });

  it("free text q: 'יש לי 5 ימים בנובמבר' = 4 nights in November, and what was understood is echoed", async () => {
    stubUpstream();
    const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent("יש לי 5 ימים בנובמבר")}`);
    expect(res.status).toBe(200);
    expect(data.meta.understood).toEqual({ text: "יש לי 5 ימים בנובמבר", nights: { min: 4, max: 4 }, month: "2026-11", missing: [], message: null });
    expect(data.meta.nights).toEqual({ min: 4, max: 4 });
    expect(data.results.every((r) => r.nights === 4)).toBe(true);
  });

  it("free text that says nothing usable -> 400 with a Hebrew explanation, and no upstream call", async () => {
    const up = stubUpstream();
    const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent("משהו זול")}`);
    expect(res.status).toBe(400);
    expect(data.error?.code).toBe("query_not_understood");
    expect(data.error?.message).toMatch(/לא הצלחנו להבין/);
    expect(up.calls).toHaveLength(0);
  });

  it.each(["40 לילות בנובמבר", "יום אחד בנובמבר", "0 לילות בנובמבר", "5 שבועות בנובמבר"])(
    "free text with a month but a length that makes no trip (%s) -> 400, never a silently dropped filter",
    async (text) => {
      const up = stubUpstream();
      const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent(text)}`);
      expect(res.status).toBe(400);
      expect(data.error?.code).toBe("query_not_understood");
      expect(data.error?.fields?.q).toMatch(/בין 1 ל-30 לילות/);
      expect(up.calls).toHaveLength(0);
    },
  );

  it("'3 שבועות בדצמבר' = 21 nights in December", async () => {
    stubUpstream();
    const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent("3 שבועות בדצמבר")}`);
    expect(res.status).toBe(200);
    expect(data.meta.nights).toEqual({ min: 21, max: 21 });
    expect(data.meta.window.start).toBe("2026-12-01");
  });

  it("free text with a month but no readable length: answered, and the response says no length filter was applied", async () => {
    stubUpstream();
    const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent("כמה ימים בנובמבר")}`);
    expect(res.status).toBe(200);
    expect(data.meta.nights).toBeNull();
    expect(data.meta.understood).toMatchObject({ month: "2026-11", nights: null, missing: ["nights"] });
    expect(data.meta.understood?.message).toMatch(/לכמה לילות/);
    expect(data.meta.notes.some((n) => n.includes("אינן מסוננות לפי אורך הטיול"))).toBe(true);
    // An explicit nights= fills the gap, and then there is nothing to warn about.
    const withNights = (await explore(makeEnv(), `q=${encodeURIComponent("כמה ימים בנובמבר")}&nights=4`)).data;
    expect(withNights.meta.nights).toEqual({ min: 4, max: 4 });
    expect(withNights.meta.notes.some((n) => n.includes("אינן מסוננות"))).toBe(false);
  });

  it("free text without a month -> 400 asking for the month (never a guessed month)", async () => {
    stubUpstream();
    const { res, data } = await explore(makeEnv(), `q=${encodeURIComponent("4 לילות")}`);
    expect(res.status).toBe(400);
    expect(data.error?.fields?.month).toBeDefined();
    expect(data.error?.fields?.q).toMatch(/באיזה חודש/);
  });

  it("explicit parameters win over free text", async () => {
    stubUpstream();
    const { data } = await explore(makeEnv(), `q=${encodeURIComponent("שבוע בדצמבר")}&month=2026-11&nights=4`);
    expect(data.meta.window.start).toBe("2026-11-01");
    expect(data.meta.nights).toEqual({ min: 4, max: 4 });
  });

  it("sort=score ranks by the transparent breakdown; sort=price (default) never hides the cheapest", async () => {
    stubUpstream();
    const env = makeEnv();
    const byScore = (await explore(env, "month=2026-11&sort=score")).data;
    const scores = byScore.results.map((r) => r.score.total);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const r of byScore.results) {
      expect(r.score.weights).toEqual({ price: 0.55, weather: 0.25, attractiveness: 0.15, flightTime: 0.05 });
      expect(r.score.total).toBe(combineScore(r.score));
    }
    const lca = byScore.results.find((r) => r.destination.code === "LCA");
    expect(lca?.score.flightTime).toBe(60); // 06:30 Israel time
    expect(lca?.climate).toEqual({ month: 11, tmaxC: 23, rainDays: 4, approximate: true });
    const qqq = byScore.results.find((r) => r.destination.code === "QQQ");
    expect(qqq?.score).toMatchObject({ weather: null, attractiveness: null, flightTime: null });
    const byPrice = (await explore(env, "month=2026-11")).data;
    expect(byPrice.results[0]?.destination.code).toBe("ROM");
    expect(byPrice.results[0]?.score.price).toBe(100);
  });

  it("limit caps the list but destinationsMatching still counts every match", async () => {
    stubUpstream();
    const { data } = await explore(makeEnv(), "month=2026-11&limit=2");
    expect(codes(data)).toEqual(["ROM", "LCA"]);
    expect(data.meta.destinationsMatching).toBe(5);
  });

  it("a window over two months makes one call pair per month and filters to the window", async () => {
    const up = stubUpstream({
      latest: (url) =>
        json(
          url.searchParams.get("beginning_of_period") === "2026-12-01"
            ? { success: true, data: [{ origin: "TLV", destination: "SOF", depart_date: "2026-12-02", return_date: "2026-12-05", value: 50, actual: true }] }
            : LATEST,
        ),
      cheap: (url) => json(url.searchParams.get("depart_date") === "2026-12" ? { success: true, data: {} } : CHEAP),
    });
    const { data } = await explore(makeEnv(), "start=2026-11-15&end=2026-12-03");
    expect(up.tp()).toHaveLength(4);
    // Only departures from 11-15 to 12-03: ROM (11-20) and SOF (12-02).
    expect(codes(data)).toEqual(["ROM", "SOF"]);
    expect(data.results.find((r) => r.destination.code === "SOF")?.destination.nameHe).toBe("סופיה");
  });

  it("ETM as origin", async () => {
    const up = stubUpstream({ latest: () => json({ success: true, data: [{ origin: "ETM", destination: "ATH", depart_date: "2026-11-05", return_date: "2026-11-09", value: 80, actual: true }] }), cheap: () => json({ success: true, data: {} }) });
    const { data } = await explore(makeEnv(), "origin=etm&month=2026-11");
    expect(codes(data)).toEqual(["ATH"]);
    expect(data.meta.origin).toEqual({ code: "ETM", nameHe: "אילת" });
    expect(up.tp()[0]?.url.searchParams.get("origin")).toBe("ETM");
    expect(data.results[0]?.links.book).toContain("/search/ETM0511ATH09111");
  });

  it("drops rows of another origin, and rows 'found' in the future", async () => {
    stubUpstream({
      latest: () =>
        json({
          success: true,
          data: [
            { origin: "HFA", destination: "ATH", depart_date: "2026-11-05", return_date: "2026-11-09", value: 10, actual: true },
            { origin: "TLV", destination: "BUD", depart_date: "2026-11-05", return_date: "2026-11-09", value: 11, actual: true, found_at: "2027-01-01T00:00:00Z" },
          ],
        }),
      cheap: () => json({ success: true, data: {} }),
    });
    const { data } = await explore(makeEnv(), "month=2026-11");
    expect(data.results).toEqual([]);
  });
});

describe("GET /api/explore: cost, limits and failures", () => {
  it("counts in the global scan budget: when it is spent, no upstream call is made and 503 is returned", async () => {
    const env = makeEnv();
    await spendGlobalBudget(env);
    const up = stubUpstream();
    const { res, data } = await explore(env, "month=2026-11");
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("source_unavailable");
    expect(up.tp()).toHaveLength(0);
  });

  it("budget spent but a cache row under 48 hours exists: served, marked stale, with a Hebrew note", async () => {
    const env = makeEnv();
    const up = stubUpstream();
    await explore(env, "month=2026-11");
    await ageCache(env, 30);
    await spendGlobalBudget(env);
    const { res, data } = await explore(env, "month=2026-11");
    expect(res.status).toBe(200);
    expect(up.tp()).toHaveLength(2);
    expect(data.meta).toMatchObject({ stale: true, cached: true });
    expect(data.meta.checkedAt).toBe(new Date(NOW.getTime() - 30 * 3_600_000).toISOString());
    expect(data.meta.notes.some((n) => n.includes("ישנים יותר"))).toBe(true);
  });

  it("a cache row older than 48 hours is never served", async () => {
    const env = makeEnv();
    stubUpstream();
    await explore(env, "month=2026-11");
    await ageCache(env, 49);
    await spendGlobalBudget(env);
    expect((await explore(env, "month=2026-11")).res.status).toBe(503);
  });

  it("one endpoint failing still answers from the other, marked partial, cached for one hour only", async () => {
    const env = makeEnv();
    const up = stubUpstream({ cheap: () => new Response("boom", { status: 500 }) });
    const { res, data } = await explore(env, "month=2026-11");
    expect(res.status).toBe(200);
    expect(codes(data)).toEqual(["ROM", "ATH", "BUD", "QQQ"]);
    expect(data.meta.partial).toBe(true);
    expect(data.meta.notes.some((n) => n.includes("ייתכן שיש יעדים זולים נוספים"))).toBe(true);
    expect(up.tp()).toHaveLength(2); // no retry within a request
    // Within the hour: served from the cache, so a lasting outage cannot drain the shared scan budget.
    await explore(env, "month=2026-11");
    expect(up.tp()).toHaveLength(2);
    await ageCache(env, EXPLORE_PARTIAL_TTL_HOURS + 0.5);
    await explore(env, "month=2026-11");
    expect(up.tp()).toHaveLength(4);
  });

  it("both endpoints failing, nothing cached -> 503 without leaking upstream text or the token", async () => {
    stubUpstream({ latest: () => new Response(`bad ${TOKEN}`, { status: 502 }), cheap: () => json({ success: false, error: "x" }) });
    const { res, data } = await explore(makeEnv(), "month=2026-11");
    expect(res.status).toBe(503);
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(JSON.stringify(data)).not.toContain("bad");
  });

  it("a response in another currency is refused, never relabelled as USD", async () => {
    stubUpstream({ latest: () => json({ ...LATEST, currency: "rub" }), cheap: () => json({ ...CHEAP, currency: "rub" }) });
    expect((await explore(makeEnv(), "month=2026-11")).res.status).toBe(503);
  });

  it("no Travelpayouts token -> 503, no call", async () => {
    const up = stubUpstream();
    const { res } = await explore(makeEnv({ TRAVELPAYOUTS_TOKEN: "  " }), "month=2026-11");
    expect(res.status).toBe(503);
    expect(up.tp()).toHaveLength(0);
  });

  it("FX unavailable -> 503 fx_unavailable (a price without its shekel value is not shown)", async () => {
    stubUpstream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.href.startsWith(LATEST_API)) return json(LATEST);
        if (url.href.startsWith(CHEAP_API)) return json(CHEAP);
        return new Response("down", { status: 500 });
      }),
    );
    const { res, data } = await explore(makeEnv(), "month=2026-11");
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("fx_unavailable");
  });

  it("per-client rate limit: 429 with Retry-After after the limit, separate from /api/search's counter", async () => {
    const env = makeEnv();
    stubUpstream();
    for (let i = 0; i < EXPLORE_RATE_LIMIT_MAX; i++) expect((await call(env, "/api/explore?month=bad")).status).toBe(400);
    const res = await call(env, "/api/explore?month=2026-11");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call(env, "/api/explore?month=2026-11", "198.51.100.1")).status).toBe(200);
    const keys = await env.DB.prepare("SELECT DISTINCT key FROM rate_limits").all<{ key: string }>();
    expect(keys.results.some((r) => r.key.startsWith("explore:"))).toBe(true);
    expect(keys.results.some((r) => r.key.startsWith("search:"))).toBe(false);
  });

  it("the route is GET only and answers 405 to POST", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request(`${BASE}/api/explore?month=2026-11`, { method: "POST" }), env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("cached names are only taken for IATA-code keys (no prototype pollution from a tampered row)", async () => {
    const env = makeEnv();
    const payload = { v: 1, partial: false, rows: [["ATH", "2026-11-05", "2026-11-09", 50, 0, null, null, null]], names: { __proto__: ["x", "x", "GR", 1], ATH: ["אתונה", "Athens", "GR", 96] } };
    const raw = JSON.stringify(payload).replace('"names":{', '"names":{"__proto__":["x","x","GR",1],');
    await env.DB.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind(exploreCacheKey("TLV", "2026-11"), raw, NOW.toISOString()).run();
    const up = stubUpstream();
    const { data } = await explore(env, "month=2026-11");
    expect(up.tp()).toHaveLength(0);
    expect(data.results[0]?.destination).toMatchObject({ code: "ATH", nameHe: "אתונה" });
    expect(({} as Record<string, unknown>).length).toBeUndefined();
  });

  it("a corrupt cache row is ignored, not trusted", async () => {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind(exploreCacheKey("TLV", "2026-11"), "{not json", NOW.toISOString()).run();
    const up = stubUpstream();
    const { res } = await explore(env, "month=2026-11");
    expect(res.status).toBe(200);
    expect(up.tp()).toHaveLength(2);
  });
});

describe("parseExploreParams", () => {
  const parse = (q: string) => parseExploreParams(new URLSearchParams(q), NOW);
  const fields = (q: string) => {
    const r = parse(q);
    return r.ok ? {} : r.fields;
  };

  it("defaults: TLV, price sort, 20 results; the window never starts before tomorrow", () => {
    const r = parse("month=2026-10");
    expect(r).toMatchObject({ ok: true, params: { origin: "TLV", windowStart: "2026-10-02", windowEnd: "2026-10-31", months: ["2026-10"], sort: "price", limit: 20, nights: null, maxPriceIls: null } });
  });

  it.each([
    ["origin=HFA&month=2026-11", "origin"],
    ["origin=LHR&month=2026-11", "origin"],
    ["month=2026-13", "month"],
    ["month=2026-9", "month"],
    ["month=2026-09", "month"], // in the past
    ["month=2028-01", "month"], // more than a year ahead
    ["", "month"],
    ["month=2026-11&start=2026-11-01&end=2026-11-10", "month"],
    ["start=2026-11-01", "end"],
    ["start=2026-11-10&end=2026-11-01", "end"],
    ["start=2026-11-01&end=2027-01-15", "end"], // longer than 61 days
    ["start=2026-12-31&end=2027-03-02", "end"], // 61 days, but 4 calendar months -> would be 8 upstream calls
    ["start=2026-02-30&end=2026-03-10", "start"],
    ["month=2026-11&nights=0", "nights"],
    ["month=2026-11&nights=31", "nights"],
    ["month=2026-11&nights=5-3", "nights"],
    ["month=2026-11&nights=abc", "nights"],
    ["month=2026-11&maxPrice=-5", "maxPrice"],
    ["month=2026-11&maxPrice=1e3", "maxPrice"],
    ["month=2026-11&maxPrice=1000000", "maxPrice"],
    ["month=2026-11&sort=weather", "sort"],
    ["month=2026-11&limit=0", "limit"],
    ["month=2026-11&limit=2.5", "limit"],
    [`month=2026-11&q=${"א".repeat(201)}`, "q"],
  ])("%s -> error on %s", (q, field) => {
    expect(Object.keys(fields(q))).toContain(field);
  });

  it("limit above the maximum is clamped, not refused", () => {
    expect(parse("month=2026-11&limit=500")).toMatchObject({ ok: true, params: { limit: 50 } });
  });

  it("a window that started in the past is clamped to tomorrow; one ending after the horizon is clamped to it", () => {
    expect(parse("start=2026-09-20&end=2026-10-20")).toMatchObject({ ok: true, params: { windowStart: "2026-10-02", windowEnd: "2026-10-20" } });
    expect(parse("month=2027-10")).toMatchObject({ ok: true, params: { windowStart: "2027-10-01", windowEnd: "2027-10-01" } });
  });

  it("a three-month window touches three months, never more", () => {
    const r = parse("start=2026-11-30&end=2027-01-29");
    expect(r).toMatchObject({ ok: true, params: { months: ["2026-11", "2026-12", "2027-01"] } });
    // Boundary: 61 days straddling 4 months is refused with a message on `end`; 60 days in 3 months passes.
    const four = parse("start=2026-12-31&end=2027-03-02");
    expect(four).toMatchObject({ ok: false, fields: { end: expect.stringMatching(/3 calendar months/) } });
    expect(parse("start=2027-01-01&end=2027-03-02")).toMatchObject({ ok: true, params: { months: ["2027-01", "2027-02", "2027-03"] } });
  });

  it("no accepted window ever needs more than 3 months (6 upstream calls)", () => {
    for (let d = 0; d < 400; d += 3) {
      const start = new Date(Date.UTC(2026, 9, 2) + d * 86_400_000).toISOString().slice(0, 10);
      for (const len of [59, 60, 61]) {
        const end = new Date(Date.parse(start) + len * 86_400_000).toISOString().slice(0, 10);
        const r = parse(`start=${start}&end=${end}`);
        if (r.ok) expect(r.params.months.length, `${start}..${end}`).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("helpers", () => {
  it("israelTime: an instant with an offset becomes Israel wall-clock time (winter +2, summer +3); no offset -> null", () => {
    expect(israelTime("2026-11-07T04:30:00Z")).toBe("06:30");
    expect(israelTime("2026-07-07T04:30:00Z")).toBe("07:30");
    expect(israelTime("2026-11-07T06:30:00+02:00")).toBe("06:30");
    expect(israelTime("2026-11-07T06:30:00")).toBeNull();
    expect(israelTime("2026-11-07")).toBeNull();
    expect(israelTime(null)).toBeNull();
  });

  it("flightTimeScore bands", () => {
    expect([flightTimeScore("07:00"), flightTimeScore("21:59"), flightTimeScore("06:30"), flightTimeScore("22:10"), flightTimeScore("23:59"), flightTimeScore("02:00"), flightTimeScore(null)]).toEqual([100, 100, 60, 60, 60, 20, null]);
  });

  it("combineScore renormalizes over the known parts only", () => {
    expect(combineScore({ price: 80, weather: null, attractiveness: null, flightTime: null })).toBe(80);
    expect(combineScore({ price: 100, weather: 0, attractiveness: null, flightTime: null })).toBe(Math.round((0.55 * 100) / 0.8));
  });

  it("mergeCandidates keeps the cheapest per dates, prefers the better-known fare at equal price, and caps the month", () => {
    const base: Candidate = { dest: "ATH", depart: "2026-11-05", ret: "2026-11-09", usd: 100, stops: null, departTime: null, foundAt: null, expiresAt: null };
    const merged = mergeCandidates([base, { ...base, departTime: "10:00" }, { ...base, usd: 120 }]);
    expect(merged).toEqual([{ ...base, departTime: "10:00" }]);
    const many = Array.from({ length: EXPLORE_MAX_ROWS_PER_MONTH + 50 }, (_, i) => ({ ...base, dest: `A${String(i % 100).padStart(2, "0")}`, depart: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, usd: 1000 - (i % 900) }));
    expect(mergeCandidates(many).length).toBeLessThanOrEqual(EXPLORE_MAX_ROWS_PER_MONTH);
  });

  it("every climate row has 12 months of plausible values and a city the dataset knows", () => {
    for (const [code, row] of Object.entries(CLIMATE)) {
      expect(row.tmax, code).toHaveLength(12);
      expect(row.rain, code).toHaveLength(12);
      for (const t of row.tmax) expect(t, code).toBeGreaterThan(-30);
      for (const t of row.tmax) expect(t, code).toBeLessThan(50);
      for (const d of row.rain) expect(d >= 0 && d <= 31, code).toBe(true);
      expect(defaultResolver.cityNameHe(code), code).not.toBeNull();
    }
  });

  it("weatherFit: beach in August beats beach in January; unknown city or month -> null", () => {
    expect((weatherFit("LCA", 8)?.score ?? 0) > (weatherFit("LCA", 1)?.score ?? 100)).toBe(true);
    expect((weatherFit("INN", 1)?.score ?? 0) > (weatherFit("INN", 7)?.score ?? 100)).toBe(true);
    expect(weatherFit("QQQ", 5)).toBeNull();
    expect(weatherFit("LCA", 13)).toBeNull();
    expect(weatherFit("LCA", 8)).toMatchObject({ approximate: true, category: "beach" });
  });
});

describe("holidays (holidays.ts): results[].holidayHe, vacationDaysUsed and meta.holidaysAttribution", () => {
  const FIXTURE = buildHolidayIndex({
    range: { start: "2026-10-01", end: "2026-11-30" },
    holidays: [
      { date: "2026-11-09", titleHe: "חג הסיגד", yomtov: false, category: "modern" },
      { date: "2026-11-15", titleHe: "חג בדיקה א׳", yomtov: true, category: "major" },
      { date: "2026-11-16", titleHe: "חג בדיקה ב׳ (חוה״מ)", yomtov: false, category: "major" },
    ],
  });

  async function direct(holidays = FIXTURE) {
    const up = stubUpstream();
    const params = parseExploreParams(new URLSearchParams("month=2026-11"), NOW);
    if (!params.ok) throw new Error("bad params");
    const data = await runExplore(
      {
        db: createTestD1(),
        token: TOKEN,
        marker: "12345",
        fetchFn: (input, init) => globalThis.fetch(input, init),
        now: NOW,
        resolver: defaultResolver,
        scanBudget: async () => true,
        fx: async () => ({ date: "2026-10-01", source: "t", ratesToIls: { ILS: 1, USD: 3.6 } }),
        holidays,
      },
      params.params,
    );
    return { data, up };
  }
  const byCode = (d: ExploreResponse, code: string) => d.results.find((r) => r.destination.code === code);

  it("names the holidays inside each trip and counts Sunday-Thursday work days that are not yom tov", async () => {
    const { data, up } = await direct();
    // BUD 2026-11-12 (Thu) .. 11-16 (Mon): Thu, Sun (yom tov in the fixture: not counted), Mon (chol hamoed: counted).
    expect(byCode(data, "BUD")).toMatchObject({ departDate: "2026-11-12", returnDate: "2026-11-16", holidayHe: "חג בדיקה", vacationDaysUsed: 2 });
    // LCA 2026-11-07 (Sat) .. 11-11 (Wed): Sun-Wed = 4, with a modern (not yom tov) day inside.
    expect(byCode(data, "LCA")).toMatchObject({ departDate: "2026-11-07", returnDate: "2026-11-11", holidayHe: "חג הסיגד", vacationDaysUsed: 4 });
    // ROM 2026-11-20 (Fri) .. 11-24 (Tue): Sun, Mon, Tue.
    expect(byCode(data, "ROM")).toMatchObject({ holidayHe: null, vacationDaysUsed: 3 });
    expect(data.meta.holidaysAttribution).toBe(HOLIDAYS_ATTRIBUTION);
    expect(up.calls.every((c) => c.url.hostname !== "www.hebcal.com")).toBe(true);
  });

  it("outside the table's range nothing is guessed: holidayHe null and vacationDaysUsed null", async () => {
    const { data } = await direct(buildHolidayIndex({ range: { start: "2026-10-01", end: "2026-11-11" }, holidays: [] }));
    expect(byCode(data, "BUD")).toMatchObject({ holidayHe: null, vacationDaysUsed: null });
    expect(byCode(data, "LCA")).toMatchObject({ vacationDaysUsed: 4 });
  });

  it("the endpoint uses the bundled table", async () => {
    stubUpstream();
    const { res, data } = await explore(makeEnv(), "month=2026-11");
    expect(res.status).toBe(200);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.meta.holidaysAttribution).toBe("Hebcal.com, CC BY 4.0");
    for (const r of data.results) {
      expect(r.holidayHe, r.destination.code).toBe(bundledHolidays.holidayHeBetween(r.departDate, r.returnDate));
      expect(r.vacationDaysUsed, r.destination.code).toBe(bundledHolidays.vacationDaysUsed(r.departDate, r.returnDate));
    }
  });
});

describe("countries (countries/countries.ts): results[].destination.countryHe and meta.countriesAttribution", () => {
  it("names each result's country in Hebrew from the bundled CLDR table (null when the country is unknown), with credit", async () => {
    const up = stubUpstream();
    const { res, data } = await explore(makeEnv(), "origin=TLV&month=2026-11");
    expect(res.status).toBe(200);
    expect(data.meta.countriesAttribution).toBe("Unicode CLDR, Unicode License V3");
    expect(data.meta.countriesAttribution).toBe(COUNTRIES_ATTRIBUTION);
    const byCode = new Map(data.results.map((r) => [r.destination.code, r.destination]));
    expect(byCode.get("ATH")).toMatchObject({ countryCode: "GR", countryHe: "יוון" });
    expect(byCode.get("QQQ")).toMatchObject({ countryCode: null, countryHe: null });
    for (const r of data.results) expect(r.destination.countryHe, r.destination.code).toBe(countryNameHe(r.destination.countryCode));
    expect(up.calls.every((c) => !c.url.hostname.includes("jsdelivr") && !c.url.hostname.includes("unicode"))).toBe(true);
  });
});
