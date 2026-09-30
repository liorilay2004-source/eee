/**
 * GET /api/calendar (src/calendar.ts): unit tests of the parsing and grouping, and end-to-end tests through worker.fetch
 * with the D1 shim and a stubbed global fetch (every outbound call is counted). Date is frozen like in e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import {
  addMonths,
  CALENDAR_GLOBAL_LIMIT,
  CALENDAR_MAX_MONTHS,
  CALENDAR_NOTICE_HE,
  CALENDAR_RATE_LIMIT_MAX,
  CALENDAR_UNKNOWN_HE,
  calendarCacheKey,
  groupMonth,
  parseCalendarQuery,
  runCalendar,
  type CalendarResponse,
} from "../src/calendar";
import { defaultResolver } from "../src/pipeline";
import { createTravelpayoutsClient } from "../src/travelpayouts";
import type { Env, Offer } from "../src/types";
import { GLOBAL_SCAN_LIMIT } from "../src/validate";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const TOKEN = "tp-SECRET-token-0123456789abcdef";
const BASE = "https://api.example.test";
const ORIGIN = "https://app.example.test";
const IP = "203.0.113.9";
const HOUR = 3_600_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface RowSpec {
  dep: string; // YYYY-MM-DD
  ret: string;
  price: number;
  transfers?: number | null;
  returnTransfers?: number | null;
  airline?: string;
}

const row = (r: RowSpec) => ({
  origin: "TLV",
  destination: "BCN",
  origin_airport: "TLV",
  destination_airport: "BCN",
  price: r.price,
  airline: r.airline ?? "W6",
  flight_number: "1",
  departure_at: `${r.dep}T06:15:00+02:00`,
  return_at: `${r.ret}T21:40:00+01:00`,
  transfers: r.transfers === undefined ? 0 : r.transfers,
  return_transfers: r.returnTransfers === undefined ? 0 : r.returnTransfers,
  duration_to: 300,
  duration_back: 300,
  link: `/search/TLV${r.dep.slice(8, 10)}${r.dep.slice(5, 7)}BCN${r.ret.slice(8, 10)}${r.ret.slice(5, 7)}1?t=${r.price}`,
});

/** Default upstream: rows chosen by the (departure_at, return_at) month pair asked. */
const NOV_SAME: RowSpec[] = [
  { dep: "2026-11-05", ret: "2026-11-10", price: 200 },
  { dep: "2026-11-05", ret: "2026-11-08", price: 180, transfers: 1 }, // cheaper, 3 nights, 1 stop out
  { dep: "2026-11-05", ret: "2026-11-10", price: 250 }, // duplicate pair, dearer: dropped
  { dep: "2026-11-12", ret: "2026-11-19", price: 150 },
  { dep: "2026-11-20", ret: "2026-11-21", price: 90, transfers: null }, // stops unknown
];
const NOV_NEXT: RowSpec[] = [
  { dep: "2026-11-28", ret: "2026-12-04", price: 300 },
  { dep: "2026-12-02", ret: "2026-12-06", price: 50 }, // departs in December: not part of November's month
  { dep: "2026-11-01", ret: "2026-12-15", price: 40 }, // 44 nights: never a stay the API allows
];

function tpResponder(table: Record<string, RowSpec[]> = { "2026-11|2026-11": NOV_SAME, "2026-11|2026-12": NOV_NEXT }) {
  return (url: URL): Response => {
    const k = `${url.searchParams.get("departure_at")}|${url.searchParams.get("return_at")}`;
    return json({ success: true, currency: "usd", data: (table[k] ?? []).map(row) });
  };
}

const BOI = { exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }, { key: "EUR", currentExchangeRate: 4, unit: 1 }] };

function stubUpstream(tp: (url: URL) => Response = tpResponder(), boi: () => Response = () => json(BOI)) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init: init ?? {} });
    if (url.hostname === "api.travelpayouts.com") return tp(url);
    if (url.hostname === "boi.org.il") return boi();
    if (url.hostname === "open.er-api.com") return json({ result: "error" }, 500);
    throw new Error(`unexpected outbound call to ${url.hostname}`);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn, tpCalls: () => calls.filter((c) => c.url.hostname === "api.travelpayouts.com") };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: TOKEN, TRAVELPAYOUTS_MARKER: "12345", ...over };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await Promise.all(pending);
  return res;
}

type Body = CalendarResponse & { error?: { code: string; message: string; fields?: Record<string, string>; retryAfterSec?: number } };

async function cal(env: Env, query: string, headers: Record<string, string> = {}) {
  const res = await call(env, `/api/calendar?${query}`, { headers: { "CF-Connecting-IP": IP, ...headers } });
  return { res, data: (await res.clone().json()) as Body };
}

const Q = "origin=TLV&destination=BCN&month=2026-11";
const day = (data: CalendarResponse, date: string) => data.days.find((d) => d.date === date);
const rows = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;

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

// --- units ----------------------------------------------------------------------------------------------

describe("addMonths", () => {
  it("rolls over years and keeps the YYYY-MM format", () => {
    expect(addMonths("2026-11", 1)).toBe("2026-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", 0)).toBe("2026-01");
    expect(addMonths("2026-11", 14)).toBe("2028-01");
  });
  it("rejects anything that is not YYYY-MM", () => {
    expect(() => addMonths("2026-13", 1)).toThrow(RangeError);
    expect(() => addMonths("2026-1", 1)).toThrow(RangeError);
  });
});

describe("parseCalendarQuery", () => {
  const parse = (q: string) => parseCalendarQuery(new URLSearchParams(q), { resolver: defaultResolver, now: NOW });

  it("defaults: one month, 1-30 nights, any stops", () => {
    const r = parse(Q);
    expect(r).toEqual({ ok: true, q: { origin: "TLV", destination: "BCN", months: ["2026-11"], minNights: 1, maxNights: 30, maxStops: null } });
  });

  it("a range of months crosses the year", () => {
    const r = parse("origin=TLV&destination=BCN&month=2026-11&months=3&minNights=3&maxNights=7&maxStops=0");
    expect(r.ok && r.q).toMatchObject({ months: ["2026-11", "2026-12", "2027-01"], minNights: 3, maxNights: 7, maxStops: 0 });
  });

  it.each([
    ["origin=TLV&destination=BCN", "month", "is required"],
    ["origin=TLV&destination=BCN&month=2026-11-01", "month", "must be a month formatted YYYY-MM"],
    ["origin=TLV&destination=BCN&month=2026-13", "month", "must be a month formatted YYYY-MM"],
    ["origin=TLV&destination=BCN&month=2026-09", "month", "must not be in the past"],
    ["origin=TLV&destination=BCN&month=2027-11", "month", "must start within 365 days from today"],
    [`origin=TLV&destination=BCN&month=2027-09&months=3`, "months", "must start within 365 days from today"],
    [`${Q}&months=${CALENDAR_MAX_MONTHS + 1}`, "months", `must be between 1 and ${CALENDAR_MAX_MONTHS}`],
    [`${Q}&months=0`, "months", `must be between 1 and ${CALENDAR_MAX_MONTHS}`],
    [`${Q}&minNights=1.5`, "minNights", "must be an integer"],
    [`${Q}&minNights=1e1`, "minNights", "must be an integer"],
    [`${Q}&minNights=-1`, "minNights", "must be an integer"],
    [`${Q}&maxNights=31`, "maxNights", "must be between 1 and 30"],
    [`${Q}&minNights=8&maxNights=7`, "maxNights", "must be at least minNights"],
    [`${Q}&maxStops=6`, "maxStops", "must be between 0 and 5"],
    ["origin=TLV&destination=TLV&month=2026-11", "destination", "must differ from origin"],
    ["origin=Xqzzy&destination=BCN&month=2026-11", "origin", "no matching city or airport"],
    [`origin=${"a".repeat(65)}&destination=BCN&month=2026-11`, "origin", "must be at most 64 characters"],
  ])("%s -> fields.%s", (query, field, message) => {
    const r = parse(query);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_request");
      expect(r.fields[field]).toBe(message);
    }
  });

  it("an empty destination is destination_required, with every other problem still listed", () => {
    const r = parse("origin=TLV&destination=&month=bad");
    expect(r).toEqual({ ok: false, code: "destination_required", fields: { destination: "is required", month: "must be a month formatted YYYY-MM" } });
  });

  it("the current month is allowed (its remaining days), and the advance limit is inclusive", () => {
    expect(parse("origin=TLV&destination=BCN&month=2026-10").ok).toBe(true);
    expect(parse("origin=TLV&destination=BCN&month=2027-08&months=3").ok).toBe(true); // 2027-10-01 = today + 365
  });
});

const offer = (dep: string, ret: string, price: number, currency = "USD"): Offer => ({
  origin: "TLV",
  destination: "BCN",
  departDate: dep,
  returnDate: ret,
  priceAmount: price,
  priceCurrency: currency,
  source: "travelpayouts",
  ticketStructure: "roundtrip",
  outbound: { departTime: "06:15", arriveTime: null, stops: 0, durationMin: 300, airlines: ["W6"] },
  inbound: { departTime: "21:40", arriveTime: null, stops: 0, durationMin: 300, airlines: ["W6"] },
  includes: {},
  deeplink: "https://www.aviasales.com/search/x",
  verifyLink: null,
  checkedAt: NOW.toISOString(),
  extrasAmountIls: 0,
  totalIls: null,
  tags: [],
});

describe("groupMonth", () => {
  it("keeps the cheapest fare per (departure, return) pair, only inside the month and only 1-30 nights, cheapest first", () => {
    const fares = groupMonth(
      [
        offer("2026-11-05", "2026-11-10", 200),
        offer("2026-11-05", "2026-11-10", 150),
        offer("2026-11-05", "2026-11-12", 170),
        offer("2026-12-01", "2026-12-05", 10), // other month
        offer("2026-11-05", "2026-11-05", 10), // 0 nights
        offer("2026-11-01", "2026-12-02", 10), // 31 nights
        offer("2026-11-06", "2026-11-09", Number.NaN),
      ],
      "2026-11",
    );
    expect(fares.map((f) => [f.departDate, f.returnDate, f.price])).toEqual([
      ["2026-11-05", "2026-11-10", 150],
      ["2026-11-05", "2026-11-12", 170],
    ]);
  });

  it("keeps a dearer fare when it has fewer stops than every cheaper one (maxStops must still find it)", () => {
    const withStops = (price: number, out: number | null, back: number | null) => {
      const o = offer("2026-11-05", "2026-11-10", price);
      o.outbound.stops = out;
      o.inbound.stops = back;
      return o;
    };
    const fares = groupMonth(
      [
        withStops(100, 1, 0), // cheapest, 1 stop
        withStops(150, 0, 0), // direct: kept
        withStops(120, 0, 1), // 1 stop, dearer than the 1-stop 100: dropped
        withStops(90, null, 0), // unknown stops, cheapest overall: kept
        withStops(200, 0, 0), // direct but dearer than the direct 150: dropped
        withStops(95, 2, 2), // 2 stops: the only cheaper fare has unknown stops, so kept
      ],
      "2026-11",
    );
    expect(fares.map((f) => [f.price, f.stops, f.returnStops])).toEqual([
      [90, null, 0],
      [95, 2, 2],
      [100, 1, 0],
      [150, 0, 0],
    ]);
  });

  it("keeps only https booking links, like a cache read-back does", () => {
    const o = offer("2026-11-05", "2026-11-10", 200);
    o.deeplink = "http://www.aviasales.com/search/x";
    expect(groupMonth([o], "2026-11")[0]?.deeplink).toBeNull();
  });

  it("never compares prices of different currencies", () => {
    const fares = groupMonth([offer("2026-11-05", "2026-11-10", 200, "USD"), offer("2026-11-05", "2026-11-10", 150, "EUR")], "2026-11");
    expect(fares).toHaveLength(2);
  });
});

// --- end to end -----------------------------------------------------------------------------------------

describe("GET /api/calendar: happy path", () => {
  it("asks Travelpayouts exactly twice per month, token in the header only, and returns the cheapest fare per day", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const { res, data } = await cal(env, Q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const tp = up.tpCalls();
    expect(tp).toHaveLength(2);
    expect(tp.map((c) => `${c.url.searchParams.get("departure_at")}|${c.url.searchParams.get("return_at")}`)).toEqual(["2026-11|2026-11", "2026-11|2026-12"]);
    for (const c of tp) {
      expect(c.url.pathname).toBe("/aviasales/v3/prices_for_dates");
      expect(c.url.searchParams.get("one_way")).toBe("false");
      expect(c.url.searchParams.get("market")).toBe("il");
      expect(c.url.toString()).not.toContain(TOKEN);
      expect((c.init.headers as Record<string, string>)["X-Access-Token"]).toBe(TOKEN);
    }
    expect(await res.text()).not.toContain(TOKEN);

    // Every day of November (all in the future on 2026-10-01), in order.
    expect(data.days).toHaveLength(30);
    expect(data.days[0]?.date).toBe("2026-11-01");
    expect(data.days[29]?.date).toBe("2026-11-30");

    expect(day(data, "2026-11-05")?.fare).toMatchObject({
      priceAmount: 180,
      priceCurrency: "USD",
      priceIls: 648,
      returnDate: "2026-11-08",
      nights: 3,
      stops: 1,
      returnStops: 0,
      airlines: ["W6"],
      departTime: "06:15",
      checkedAt: NOW.toISOString(),
    });
    expect(day(data, "2026-11-05")?.fare?.deeplink).toBe("https://www.aviasales.com/search/TLV0511BCN08111?t=180&marker=12345");
    expect(day(data, "2026-11-28")?.fare).toMatchObject({ priceAmount: 300, returnDate: "2026-12-04", nights: 6 });
    // December departures are not November days; a 44-night stay is never offered.
    expect(day(data, "2026-11-01")?.fare).toBeNull();
    expect(day(data, "2026-11-02")?.fare).toBeNull();

    expect(data.meta).toMatchObject({
      apiVersion: 1,
      origin: "TLV",
      destination: "BCN",
      minNights: 1,
      maxNights: 30,
      maxStops: null,
      priceBasis: "roundtrip_one_adult",
      months: [{ month: "2026-11", status: "fresh", checkedAt: NOW.toISOString(), truncated: false }],
      fromCache: false,
      upstreamCalls: 2,
      cheapest: { date: "2026-11-20", priceIls: 324 },
      fxSource: "bank_of_israel",
      source: "travelpayouts",
      noticeHe: CALENDAR_NOTICE_HE,
    });
  });

  it("labels days by price tertile among the priced days", async () => {
    stubUpstream();
    const { data } = await cal(makeEnv(), Q);
    const levels = Object.fromEntries(data.days.filter((d) => d.fare).map((d) => [d.date, d.fare?.level]));
    // prices: 11-20 90, 11-12 150, 11-05 180, 11-28 300
    expect(levels).toEqual({ "2026-11-20": "low", "2026-11-12": "low", "2026-11-05": "mid", "2026-11-28": "high" });
  });

  it("equal prices everywhere are all mid, never all low", async () => {
    stubUpstream(
      tpResponder({
        "2026-11|2026-11": ["05", "06", "07", "08"].map((d) => ({ dep: `2026-11-${d}`, ret: "2026-11-20", price: 100 })),
      }),
    );
    const { data } = await cal(makeEnv(), Q);
    expect(new Set(data.days.filter((d) => d.fare).map((d) => d.fare?.level))).toEqual(new Set(["mid"]));
    expect(data.meta.unavailableHe).toBeUndefined();
  });

  it("fewer than three priced days carry no level", async () => {
    stubUpstream(tpResponder({ "2026-11|2026-11": [{ dep: "2026-11-05", ret: "2026-11-08", price: 100 }] }));
    const { data } = await cal(makeEnv(), Q);
    expect(day(data, "2026-11-05")?.fare?.level).toBeNull();
  });

  it("applies minNights, maxNights and maxStops (unknown stops never pass a stop filter)", async () => {
    stubUpstream();
    const env = makeEnv();
    const long = await cal(env, `${Q}&minNights=5&maxNights=7`);
    expect(day(long.data, "2026-11-05")?.fare).toMatchObject({ priceAmount: 200, nights: 5 });
    expect(day(long.data, "2026-11-20")?.fare).toBeNull(); // 1 night

    const direct = await cal(env, `${Q}&maxStops=0`);
    expect(day(direct.data, "2026-11-05")?.fare).toMatchObject({ priceAmount: 200, stops: 0 });
    expect(day(direct.data, "2026-11-20")?.fare).toBeNull(); // stops unknown
    expect(direct.data.meta.cheapest).toEqual({ date: "2026-11-12", priceIls: 540 });
  });

  it("maxStops=0 finds the direct fare of a date pair whose cheapest fare has a stop, also from the cache", async () => {
    const up = stubUpstream(
      tpResponder({
        "2026-11|2026-11": [
          { dep: "2026-11-09", ret: "2026-11-14", price: 100, transfers: 1 },
          { dep: "2026-11-09", ret: "2026-11-14", price: 160, transfers: 0, returnTransfers: 0 },
        ],
      }),
    );
    const env = makeEnv();
    const any = await cal(env, Q);
    expect(day(any.data, "2026-11-09")?.fare).toMatchObject({ priceAmount: 100, stops: 1 });
    const direct = await cal(env, `${Q}&maxStops=0`); // cache hit
    expect(up.tpCalls()).toHaveLength(2);
    expect(day(direct.data, "2026-11-09")).toMatchObject({ known: true, fare: { priceAmount: 160, stops: 0, returnStops: 0 } });
  });

  it("the current month lists only the days from today on", async () => {
    stubUpstream(tpResponder({}));
    vi.setSystemTime(new Date("2026-10-15T09:00:00Z"));
    const { data } = await cal(makeEnv(), "origin=TLV&destination=BCN&month=2026-10");
    expect(data.days[0]?.date).toBe("2026-10-15");
    expect(data.days).toHaveLength(17);
  });

  it("three months = six requests, and the months are listed in order", async () => {
    const up = stubUpstream();
    const { data } = await cal(makeEnv(), `${Q}&months=3`);
    expect(up.tpCalls()).toHaveLength(6);
    expect(data.meta.months.map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(data.days).toHaveLength(30 + 31 + 31);
    // The December departure found by November's second request is not used: December has its own requests.
    expect(day(data, "2026-12-02")?.fare).toBeNull();
  });

  it("a full page (1000 rows) marks the month as possibly truncated", async () => {
    const many: RowSpec[] = Array.from({ length: 1000 }, (_, i) => ({ dep: "2026-11-10", ret: "2026-11-15", price: 100 + i }));
    stubUpstream(tpResponder({ "2026-11|2026-11": many }));
    const { data } = await cal(makeEnv(), Q);
    expect(data.meta.months[0]?.truncated).toBe(true);
  });

  it("drops fares in a currency without an exchange rate instead of guessing", async () => {
    stubUpstream((url) =>
      json({
        success: true,
        currency: url.searchParams.get("return_at") === "2026-11" ? "xyz" : "usd",
        data: [row(url.searchParams.get("return_at") === "2026-11" ? { dep: "2026-11-05", ret: "2026-11-08", price: 1 } : { dep: "2026-11-06", ret: "2026-12-01", price: 99 })],
      }),
    );
    const { data } = await cal(makeEnv(), Q);
    expect(day(data, "2026-11-05")?.fare).toBeNull();
    expect(day(data, "2026-11-06")?.fare).toMatchObject({ priceCurrency: "USD", priceAmount: 99 });
  });
});

describe("GET /api/calendar: cache", () => {
  it("stores each month in search_cache and answers a repeat within the TTL with ZERO outbound calls", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const first = await cal(env, Q);
    const stored = await rows<{ search_key: string; extra_json: string }>(env, "SELECT search_key, extra_json FROM search_cache");
    expect(stored.map((r) => r.search_key)).toEqual([calendarCacheKey("TLV", "BCN", "2026-11")]);
    expect(JSON.parse(stored[0]?.extra_json ?? "{}")).toEqual({ kind: "calendar", truncated: false });

    const before = up.fn.mock.calls.length;
    vi.setSystemTime(new Date(NOW.getTime() + 5 * HOUR));
    const second = await cal(env, `${Q}&maxNights=10`); // filters are applied to the cached month, not keyed
    expect(up.fn.mock.calls.length).toBe(before);
    expect(second.data.meta).toMatchObject({ fromCache: true, upstreamCalls: 0, months: [{ status: "cached", checkedAt: NOW.toISOString() }] });
    expect(day(second.data, "2026-11-05")?.fare).toEqual(day(first.data, "2026-11-05")?.fare);
  });

  it("refetches after the TTL, and a range fetches only the months it is missing", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    await cal(env, Q);
    const range = await cal(env, `${Q}&months=2`);
    expect(up.tpCalls()).toHaveLength(4); // November cached, December fetched
    expect(range.data.meta.months.map((m) => m.status)).toEqual(["cached", "fresh"]);
    expect(range.data.meta.fromCache).toBe(false);

    vi.setSystemTime(new Date(NOW.getTime() + 7 * HOUR));
    await cal(env, Q);
    expect(up.tpCalls()).toHaveLength(6);
  });

  it("an empty month is cached for one hour only", async () => {
    const up = stubUpstream(tpResponder({}));
    const env = makeEnv();
    const first = await cal(env, Q);
    expect(first.res.status).toBe(200);
    expect(first.data.days.every((d) => d.fare === null)).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
    await cal(env, Q);
    expect(up.tpCalls()).toHaveLength(2);
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    await cal(env, Q);
    expect(up.tpCalls()).toHaveLength(4);
  });

  it("when the refresh fails, the last stored month is served marked stale", async () => {
    let fail = false;
    const ok = tpResponder();
    stubUpstream((url) => (fail ? json({ success: false }, 500) : ok(url)));
    const env = makeEnv();
    await cal(env, Q);
    fail = true;
    vi.setSystemTime(new Date(NOW.getTime() + 8 * HOUR));
    const { res, data } = await cal(env, Q);
    expect(res.status).toBe(200);
    expect(data.meta.months[0]).toMatchObject({ status: "stale", checkedAt: NOW.toISOString() });
    expect(day(data, "2026-11-05")?.fare?.checkedAt).toBe(NOW.toISOString());
  });

  it("a damaged cache row is a miss, and damaged fares inside a row are dropped", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const key = calendarCacheKey("TLV", "BCN", "2026-11");
    await env.DB.prepare("INSERT INTO search_cache (search_key, offers_json, extra_json, created_at) VALUES (?, ?, NULL, ?)").bind(key, "{not json", NOW.toISOString()).run();
    await cal(env, Q);
    expect(up.tpCalls()).toHaveLength(2);

    const bad = [
      { departDate: "2026-11-07", returnDate: "2026-11-09", price: 70, currency: "USD", deeplink: "javascript:alert(1)" },
      { departDate: "2026-11-08", returnDate: "2026-11-09", price: -1, currency: "USD" },
      "junk",
    ];
    await env.DB.prepare("UPDATE search_cache SET offers_json = ? WHERE search_key = ?").bind(JSON.stringify(bad), key).run();
    const { data } = await cal(env, Q);
    expect(up.tpCalls()).toHaveLength(2);
    expect(day(data, "2026-11-07")?.fare).toMatchObject({ priceAmount: 70, deeplink: null, stops: null });
    expect(day(data, "2026-11-08")?.fare).toBeNull();
  });
});

describe("GET /api/calendar: budget, limits and failures", () => {
  it("takes one unit of the global scan budget and of the calendar share per fresh fetch, none on a cache hit", async () => {
    stubUpstream();
    const env = makeEnv();
    await cal(env, `${Q}&months=2`);
    await cal(env, Q);
    const counts = await rows<{ key: string; count: number }>(env, "SELECT key, count FROM rate_limits WHERE key LIKE 'global:%' ORDER BY key");
    expect(counts).toEqual([
      { key: "global:calendar", count: 1 },
      { key: "global:scan", count: 1 },
    ]);
  });

  it("an exhausted global scan budget means no upstream call and a 503 when nothing is stored", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const windowStart = Math.floor(NOW.getTime() / 1000 / 600) * 600;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?)").bind(windowStart, GLOBAL_SCAN_LIMIT).run();
    const { res, data } = await cal(env, Q);
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("source_unavailable");
    expect(up.tpCalls()).toHaveLength(0);
  });

  it("an exhausted calendar share refuses before touching the search budget", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const windowStart = Math.floor(NOW.getTime() / 1000 / 600) * 600;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:calendar', ?, ?)").bind(windowStart, CALENDAR_GLOBAL_LIMIT).run();
    const { res } = await cal(env, Q);
    expect(res.status).toBe(503);
    expect(up.tpCalls()).toHaveLength(0);
    expect(await rows(env, "SELECT * FROM rate_limits WHERE key = 'global:scan'")).toEqual([]);
  });

  it("when the budget is busy, stored months are still served (marked stale) and missing ones say busy", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    await cal(env, Q);
    vi.setSystemTime(new Date(NOW.getTime() + 8 * HOUR));
    const windowStart = Math.floor(Date.now() / 1000 / 600) * 600;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?)").bind(windowStart, GLOBAL_SCAN_LIMIT).run();
    const { res, data } = await cal(env, `${Q}&months=2`);
    expect(res.status).toBe(200);
    expect(data.meta.months.map((m) => m.status)).toEqual(["stale", "busy"]);
    expect(up.tpCalls()).toHaveLength(2);
    // December's empty days are unknown, not "no cached fare", and the response says so.
    expect(day(data, "2026-12-10")).toEqual({ date: "2026-12-10", known: false, fare: null });
    expect(day(data, "2026-11-01")).toEqual({ date: "2026-11-01", known: true, fare: null });
    expect(data.meta.unavailableHe).toBe(CALENDAR_UNKNOWN_HE);
  });

  it("the first upstream failure stops every later request (no retries)", async () => {
    const up = stubUpstream(() => json({ error: "rate limited" }, 429));
    const { res, data } = await cal(makeEnv(), `${Q}&months=3`);
    expect(res.status).toBe(503);
    expect(data.error).toEqual({ code: "source_unavailable", message: "No fare source is available right now" });
    expect(up.tpCalls()).toHaveLength(1);
  });

  it("a failure in a later month keeps the months already fetched", async () => {
    const ok = tpResponder();
    stubUpstream((url) => (url.searchParams.get("departure_at") === "2026-12" ? json({}, 500) : ok(url)));
    const { res, data } = await cal(makeEnv(), `${Q}&months=3`);
    expect(res.status).toBe(200);
    expect(data.meta.months.map((m) => m.status)).toEqual(["fresh", "failed", "failed"]);
    expect(data.meta.upstreamCalls).toBe(3);
    expect(data.days.filter((d) => !d.known).map((d) => d.date.slice(0, 7))).toEqual([...Array(31).fill("2026-12"), ...Array(31).fill("2027-01")]);
  });

  it("without a Travelpayouts token: 503 and no outbound call", async () => {
    const up = stubUpstream();
    const { res } = await cal(makeEnv({ TRAVELPAYOUTS_TOKEN: undefined }), Q);
    expect(res.status).toBe(503);
    expect(up.tpCalls()).toHaveLength(0);
  });

  it("without exchange rates: 503 fx_unavailable", async () => {
    stubUpstream(tpResponder(), () => json({}, 500));
    const { res, data } = await cal(makeEnv(), Q);
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("fx_unavailable");
  });

  it("rate limits each client on its own counter, apart from /api/search", async () => {
    stubUpstream();
    const env = makeEnv();
    for (let i = 0; i < CALENDAR_RATE_LIMIT_MAX; i++) expect((await cal(env, "origin=TLV&destination=BCN")).res.status).toBe(400);
    const { res, data } = await cal(env, Q);
    expect(res.status).toBe(429);
    expect(data.error?.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The search limiter did not move.
    const search = await rows<{ count: number }>(env, "SELECT count FROM rate_limits WHERE key LIKE 'search:%'");
    expect(search).toEqual([]);
  });

  it("400 with fields on a bad query, 405 on POST, CORS preflight for GET", async () => {
    stubUpstream();
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    const bad = await cal(env, "origin=TLV&destination=BCN&month=2026-11&months=9");
    expect(bad.res.status).toBe(400);
    expect(bad.data.error).toMatchObject({ code: "invalid_request", fields: { months: "must be between 1 and 3" } });

    const post = await call(env, "/api/calendar", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, OPTIONS");

    const pre = await call(env, "/api/calendar", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });
});

describe("runCalendar directly", () => {
  it("never calls upstream when reserveFetch refuses (fail closed)", async () => {
    const fetchFn = vi.fn();
    const tp = createTravelpayoutsClient({ token: TOKEN, fetchFn: fetchFn as unknown as typeof fetch });
    const q = { origin: "TLV", destination: "BCN", months: ["2026-11"], minNights: 1, maxNights: 30, maxStops: null };
    await expect(
      runCalendar({ db: createTestD1(), tp, fx: async () => ({ date: "2026-10-01", source: "t", ratesToIls: { ILS: 1, USD: 3.6 } }), now: NOW, reserveFetch: async () => false }, q),
    ).rejects.toMatchObject({ code: "source_unavailable", message: "Too many calendar requests right now, try again later" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Travelpayouts monthRoundTrips", () => {
  it("refuses a return month before the departure month without a request", async () => {
    const fetchFn = vi.fn();
    const tp = createTravelpayoutsClient({ token: TOKEN, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(tp.monthRoundTrips?.("TLV", "BCN", "2026-11", "2026-10")).rejects.toThrow(/months must be YYYY-MM/);
    await expect(tp.monthRoundTrips?.("TLV", "BCN", "2026-11-01", "2026-11")).rejects.toThrow(/months must be YYYY-MM/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// --- meta.insights (calendar-insights.ts) -------------------------------------------------------------------

import { INSIGHTS_LABEL_HE } from "../src/calendar-insights";

describe("GET /api/calendar: meta.insights", () => {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  /** 2026-11-01..21 (three of every weekday; the 1st is a Sunday), 5 nights, direct; price by weekday and week. */
  const WEEK: RowSpec[] = Array.from({ length: 21 }, (_, i) => ({
    dep: `2026-11-${p2(i + 1)}`,
    ret: `2026-11-${p2(i + 6)}`,
    price: 100 + (i % 7) * 10 + Math.floor(i / 7) * 5,
  }));
  const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const insightsOf = (data: CalendarResponse) => {
    expect(data.meta.insights).toBeDefined();
    return data.meta.insights as NonNullable<CalendarResponse["meta"]["insights"]>;
  };

  it("a month with 4+ weekdays priced twice returns insights whose minima match the days of the same response", async () => {
    stubUpstream(tpResponder({ "2026-11|2026-11": WEEK }));
    const { res, data } = await cal(makeEnv(), Q);
    expect(res.status).toBe(200);
    const ins = insightsOf(data);
    expect(ins.labelHe).toBe(INSIGHTS_LABEL_HE);
    expect(ins.basis).toBe("cached_fares");
    expect(ins.byWeekday.map((b) => b.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const b of ins.byWeekday) {
      const prices = data.days.filter((d) => d.known && d.fare && weekdayOf(d.date) === b.weekday).map((d) => d.fare?.priceIls as number);
      expect(b.count).toBe(prices.length);
      expect(b.minIls).toBe(Math.round(Math.min(...prices)));
    }
    expect(ins.cheapestWeekday).toBe(0); // Sunday: 100/105/110 USD
    expect(ins.byNights).toEqual([{ nights: 5, minIls: 360, count: 21 }]);
    expect(ins.cheapestNights).toBe(5);
  });

  it("fares outside minNights or maxStops never reach byNights nor lower a minimum", async () => {
    const cheapOff: RowSpec[] = [
      { dep: "2026-11-22", ret: "2026-11-25", price: 20 }, // 3 nights, direct
      { dep: "2026-11-23", ret: "2026-11-26", price: 20 },
      { dep: "2026-11-02", ret: "2026-11-08", price: 10, transfers: 1 }, // 6 nights, 1 stop
      { dep: "2026-11-03", ret: "2026-11-09", price: 10, transfers: 1 },
    ];
    stubUpstream(tpResponder({ "2026-11|2026-11": [...WEEK, ...cheapOff] }));
    const env = makeEnv();
    // Without filters the cheap fares count (so the fixture really exercises the filters).
    const open = insightsOf((await cal(env, Q)).data);
    expect(open.byNights.map((g) => g.nights)).toEqual([3, 5, 6]);

    const { data } = await cal(env, `${Q}&minNights=4&maxStops=0`);
    const ins = insightsOf(data);
    expect(ins.byNights).toEqual([{ nights: 5, minIls: 360, count: 21 }]);
    for (const b of ins.byWeekday) expect(b.minIls).toBeGreaterThanOrEqual(360);
  });

  it("a fare dropped for a missing exchange rate is not in byNights", async () => {
    const usd: RowSpec[] = Array.from({ length: 14 }, (_, i) => {
      const dep = `2026-11-${p2(16 + i)}`;
      return { dep, ret: plusDays(dep, 20), price: 200 + i };
    });
    const xyz: RowSpec[] = [
      { dep: "2026-11-02", ret: "2026-11-05", price: 1 },
      { dep: "2026-11-03", ret: "2026-11-06", price: 1 },
    ];
    stubUpstream((url) => {
      const same = url.searchParams.get("return_at") === "2026-11";
      return json({ success: true, currency: same ? "xyz" : "usd", data: (same ? xyz : usd).map(row) });
    });
    const { data } = await cal(makeEnv(), Q);
    const ins = insightsOf(data);
    expect(ins.byNights).toEqual([{ nights: 20, minIls: 720, count: 14 }]);
    expect(ins.byWeekday.reduce((n, b) => n + b.count, 0)).toBe(14);
  });

  it("a past departure still stored in the month never enters byNights", async () => {
    vi.setSystemTime(new Date("2026-11-15T09:00:00Z"));
    const future: RowSpec[] = Array.from({ length: 11 }, (_, i) => {
      const dep = `2026-11-${p2(15 + i)}`;
      return { dep, ret: plusDays(dep, 5), price: 300 + i };
    });
    const past: RowSpec[] = [
      { dep: "2026-11-02", ret: "2026-11-04", price: 5 },
      { dep: "2026-11-03", ret: "2026-11-05", price: 5 },
    ];
    stubUpstream(tpResponder({ "2026-11|2026-11": [...past, ...future] }));
    const { data } = await cal(makeEnv(), Q);
    expect(data.days[0]?.date).toBe("2026-11-15");
    const ins = insightsOf(data);
    expect(ins.byNights).toEqual([{ nights: 5, minIls: 1080, count: 11 }]);
    expect(ins.byWeekday.reduce((n, b) => n + b.count, 0)).toBe(11);
  });

  it("the existing thin fixture has no insights key", async () => {
    stubUpstream();
    const { data } = await cal(makeEnv(), Q);
    expect("insights" in data.meta).toBe(false);
  });

  it("a cache hit makes zero outbound calls and returns the same insights; the stored month holds no insights", async () => {
    const up = stubUpstream(tpResponder({ "2026-11|2026-11": WEEK }));
    const env = makeEnv();
    const first = await cal(env, Q);
    const before = up.fn.mock.calls.length;
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    const second = await cal(env, Q);
    expect(up.fn.mock.calls.length).toBe(before);
    expect(second.data.meta.months[0]?.status).toBe("cached");
    expect(second.data.meta.insights).toEqual(insightsOf(first.data));
    const stored = await rows<{ offers_json: string; extra_json: string }>(env, "SELECT offers_json, extra_json FROM search_cache");
    expect(stored).toHaveLength(1);
    for (const r of stored) {
      expect(r.offers_json).not.toContain("insights");
      expect(r.extra_json).not.toContain("insights");
    }
  });

  it("outbound calls and D1 prepares equal the pre-feature baseline", async () => {
    // Baseline measured on main before this feature, same fixture: fresh 1 month = 16 prepares, 2 Travelpayouts calls,
    // 3 outbound in all (with FX); the cache hit = 4 prepares, 0 outbound; fresh 2 months = 17 prepares, 4 calls.
    const up = stubUpstream(tpResponder({ "2026-11|2026-11": WEEK }));
    const env = makeEnv();
    const spy = vi.spyOn(env.DB, "prepare");
    const fresh = await cal(env, Q);
    expect(fresh.data.meta.insights).toBeDefined();
    expect([spy.mock.calls.length, up.tpCalls().length, up.calls.length]).toEqual([16, 2, 3]);

    spy.mockClear();
    const callsBefore = up.calls.length;
    await cal(env, Q);
    expect([spy.mock.calls.length, up.calls.length - callsBefore]).toEqual([4, 0]);

    const env2 = makeEnv();
    const spy2 = vi.spyOn(env2.DB, "prepare");
    const tpBefore = up.tpCalls().length;
    await cal(env2, `${Q}&months=2`);
    expect([spy2.mock.calls.length, up.tpCalls().length - tpBefore]).toEqual([17, 4]);
  });

  it("a multi-month query aggregates the counts of both months", async () => {
    const nov: RowSpec[] = Array.from({ length: 7 }, (_, i) => ({ dep: `2026-11-${p2(2 + i)}`, ret: `2026-11-${p2(5 + i)}`, price: 100 + i }));
    const dec: RowSpec[] = Array.from({ length: 7 }, (_, i) => ({ dep: `2026-12-${p2(7 + i)}`, ret: `2026-12-${p2(10 + i)}`, price: 150 + i }));
    stubUpstream(tpResponder({ "2026-11|2026-11": nov, "2026-12|2026-12": dec }));
    const { data } = await cal(makeEnv(), `${Q}&months=2`);
    const ins = insightsOf(data);
    expect(ins.byWeekday.map((b) => [b.weekday, b.count])).toEqual([0, 1, 2, 3, 4, 5, 6].map((w) => [w, 2]));
    expect(ins.byNights).toEqual([{ nights: 3, minIls: 360, count: 14 }]);
    // Either month alone has one priced day per weekday: no insights.
    const single = await cal(makeEnv(), Q);
    expect(single.data.meta.insights).toBeUndefined();
  });

  it("apiVersion stays 1 and insights add under 1 KB to the response", async () => {
    stubUpstream(tpResponder({ "2026-11|2026-11": WEEK }));
    const { res, data } = await cal(makeEnv(), Q);
    expect(data.meta.apiVersion).toBe(1);
    const full = await res.text();
    const without = JSON.parse(full) as CalendarResponse;
    expect(without.meta.insights).toBeDefined();
    delete without.meta.insights;
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    expect(bytes(full) - bytes(JSON.stringify(without))).toBeLessThan(1024);
  });
});
