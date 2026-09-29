/**
 * The optional live fare sources wired into the Worker entry (src/index.ts): real Request objects into worker.fetch, the D1
 * shim behind it, global fetch stubbed for Travelpayouts, FX and the four vendors (every outbound call is counted).
 * NOTHING here leaves the machine, and the vendor responses are stand-ins built from the docs, not from live calls.
 * Owner rule under test: nothing may cost money. A source without a key is not built and costs nothing, a source at its cap
 * or with a counter that cannot be read is not called, and the scheduled job never uses any of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import onewayFixture from "./fixtures/tp_oneway.json";
import * as entry from "../src/index";
import { MAX_TP_REQUESTS } from "../src/pipeline";
import { dailyShare, MAX_QUOTE_CALLS } from "../src/quotes";
import { IGNAV_QUOTA } from "../src/sources/ignav";
import { SEARCHAPI_QUOTA } from "../src/sources/searchapi";
import { SERPAPI_QUOTA } from "../src/sources/serpapi";
import { resetWegoTokenCache, WEGO_MAX_REQUESTS_PER_SEARCH, WEGO_QUOTA } from "../src/sources/wego";
import type { Env, SearchResponse } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;

const NOW = new Date("2026-10-01T09:00:00.000Z");
const TP_TOKEN = "tp-SECRET-token-0123456789abcdef";
const BASE = "https://api.example.test";
const IP = "203.0.113.7";
const BODY = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clone = <T>(v: T): T => structuredClone(v);

/** One env var per vendor, the host it talks to, and the quota row its counter uses (the period key of NOW). */
const VENDORS = [
  { name: "ignav", envVar: "IGNAV_API_KEY", host: "ignav.com", period: "lifetime", quota: IGNAV_QUOTA },
  { name: "wego", envVar: "WEGO_API_TOKEN", host: "affiliate-api.wego.com", period: "lifetime", quota: WEGO_QUOTA },
  { name: "searchapi", envVar: "SEARCHAPI_KEY", host: "www.searchapi.io", period: "lifetime", quota: SEARCHAPI_QUOTA },
  { name: "serpapi", envVar: "SERPAPI_KEY", host: "serpapi.com", period: "2026-10", quota: SERPAPI_QUOTA },
] as const;
const VENDOR_HOSTS: readonly string[] = VENDORS.map((v) => v.host);
type VendorEnv = "IGNAV_API_KEY" | "WEGO_API_TOKEN" | "SEARCHAPI_KEY" | "SERPAPI_KEY";
const KEYS: Record<VendorEnv, string> = {
  IGNAV_API_KEY: "ignav-SECRET-key-0123456789",
  WEGO_API_TOKEN: "wego-SECRET-id-0123456789",
  SEARCHAPI_KEY: "searchapi-SECRET-key-0123456789",
  SERPAPI_KEY: "serpapi-SECRET-key-0123456789",
};
const ALL_KEYS: Partial<Env> = KEYS;

// --- upstream stub ---------------------------------------------------------------------------------------

interface Outbound {
  url: URL;
  init: RequestInit;
}

const BOI_PAYLOAD = { exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }] };

function fixtureTp(url: URL): Response {
  if (url.searchParams.get("one_way") === "true") {
    const body = clone(onewayFixture) as { data: { origin: string }[] };
    body.data = body.data.filter((d) => d.origin === url.searchParams.get("origin"));
    return json(body);
  }
  return json(roundtripFixture);
}

/** Ignav's answer for the dates it was asked: one verified 120 USD direct round trip (cheaper than the cached 189). */
function ignavAnswer(init: RequestInit): Response {
  const asked = JSON.parse(String(init.body)) as { origin: string; destination: string; departure_date: string; return_date: string };
  const segment = (from: string, to: string, date: string, dep: string, arr: string) => ({
    marketing_carrier_code: "LY",
    departure_airport: from,
    departure_time_local: `${date}T${dep}:00`,
    arrival_airport: to,
    arrival_time_local: `${date}T${arr}:00`,
    duration_minutes: 290,
  });
  return json({
    origin: asked.origin,
    destination: asked.destination,
    itineraries: [
      {
        price: { amount: 120, currency: "USD", status: "verified" },
        outbound: { duration_minutes: 290, segments: [segment(asked.origin, asked.destination, asked.departure_date, "08:05", "12:55")] },
        inbound: { duration_minutes: 270, segments: [segment(asked.destination, asked.origin, asked.return_date, "15:30", "20:00")] },
        cabin_class: "economy",
        bags: { carry_on: 1, checked: 0 },
        requires_self_transfer: false,
      },
    ],
  });
}

/** The round-trip fixture widened to six date pairs (11-12 .. 11-17, six nights each), so the four cheapest have to be picked. */
function manyPairsTp(url: URL): Response {
  if (url.searchParams.get("one_way") === "true") return fixtureTp(url);
  const base = (clone(roundtripFixture) as { data: Array<Record<string, unknown>> }).data[0] as Record<string, unknown>;
  const data = Array.from({ length: 6 }, (_, i) => ({
    ...base,
    price: 200 + i * 10,
    departure_at: `2026-11-${12 + i}T06:15:00+02:00`,
    return_at: `2026-11-${18 + i}T21:40:00+01:00`,
  }));
  return json({ success: true, currency: "usd", data });
}

interface StubOptions {
  /** Answers Travelpayouts requests instead of the fixtures. */
  tp?: (url: URL) => Response;
  /** Answer per vendor host; a vendor that is not listed answers with an empty (unreadable-as-fares) 200. */
  vendors?: Partial<Record<string, (url: URL, init: RequestInit) => Response>>;
}

function stubUpstream(opts: StubOptions = {}) {
  const calls: Outbound[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init: init ?? {} });
    if (url.hostname === "api.travelpayouts.com") return (opts.tp ?? fixtureTp)(url);
    if (url.hostname === "boi.org.il") return json(BOI_PAYLOAD);
    if (url.hostname === "open.er-api.com") return json({ result: "success", rates: { USD: 0.2778 } });
    if (url.hostname === "affiliate-api.wego.com") {
      const custom = opts.vendors?.[url.hostname];
      if (custom) return custom(url, init ?? {});
      if (url.pathname === "/apps/oauth/token") return json({ access_token: "wego-token-0123456789", expires_in: 43199 });
      if (url.pathname === "/metasearch/flights/searches") return json({ search: { id: "s-1" } }, 201);
      return new Response("not json", { status: 200 }); // a poll nobody can read ends the wait after one poll
    }
    if (VENDOR_HOSTS.includes(url.hostname)) return (opts.vendors?.[url.hostname] ?? (() => json({})))(url, init ?? {});
    throw new Error(`unexpected outbound call to ${url.hostname}`);
  });
  vi.stubGlobal("fetch", fn);
  const host = (h: string) => calls.filter((c) => c.url.hostname === h);
  return {
    calls,
    fn,
    host,
    vendorCalls: () => calls.filter((c) => VENDOR_HOSTS.includes(c.url.hostname)),
    tpCalls: () => host("api.travelpayouts.com"),
  };
}

// --- harness ---------------------------------------------------------------------------------------------

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: TP_TOKEN, TRAVELPAYOUTS_MARKER: "12345", ...over };
}

/** Calls the worker like the runtime does, then lets ctx.waitUntil work finish (persistence). */
async function call(env: Env, path: string, init: RequestInit): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await Promise.all(pending);
  return res;
}

async function search(env: Env, body: unknown = BODY) {
  const res = await call(env, "/api/search", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": IP },
    body: JSON.stringify(body),
  });
  return { res, text: await res.clone().text(), data: (await res.json()) as SearchResponse };
}

const rows = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
const quotaRows = (env: Env) => rows<{ source: string; period: string; used: number }>(env, "SELECT source, period, used FROM source_quota ORDER BY source, period");
const sourceNames = (data: SearchResponse) => data.meta.sources.map((s) => s.name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetWegoTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------

describe("no key: the extra sources do not exist", () => {
  it("makes no vendor request, keeps no counter and lists only the built-in sources", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(sourceNames(data)).toEqual(["travelpayouts", "google_flights"]);
    expect(up.vendorCalls()).toEqual([]);
    expect(up.fn).toHaveBeenCalledTimes(4); // 3 Travelpayouts + 1 FX, exactly as before the feature
    expect(await quotaRows(env)).toEqual([]);
  });

  it("a blank, whitespace or non-string secret counts as no key: the answer is byte for byte the one without them", async () => {
    stubUpstream();
    const plain = await search(makeEnv());
    for (const blank of ["", "   ", "\n", 12345 as unknown as string]) {
      const up = stubUpstream();
      const env = makeEnv({ IGNAV_API_KEY: blank, WEGO_API_TOKEN: blank, SEARCHAPI_KEY: blank, SERPAPI_KEY: blank });
      const got = await search(env);
      expect(got.text, JSON.stringify(blank)).toBe(plain.text);
      expect(up.vendorCalls(), JSON.stringify(blank)).toEqual([]);
      expect(await quotaRows(env)).toEqual([]);
    }
  });

  it("the JSON contract is untouched: the same top-level and meta fields as without the feature", async () => {
    stubUpstream();
    const { data } = await search(makeEnv());
    expect(Object.keys(data).sort()).toEqual(["cards", "meta"]);
    expect(Object.keys(data.meta).sort()).toEqual(["apiVersion", "candidatePairs", "fromCache", "fxDate", "fxSource", "generatedAt", "searchKey", "sources"].sort());
  });
});

describe("one key: exactly that source is built", () => {
  for (const v of VENDORS) {
    it(`${v.envVar} alone: only ${v.host} is asked, it is listed in meta.sources with its own status, and its counter starts`, async () => {
      const up = stubUpstream();
      const env = makeEnv({ [v.envVar]: KEYS[v.envVar] } as Partial<Env>);
      const { res, text, data } = await search(env);
      expect(res.status).toBe(200);
      expect(sourceNames(data)).toEqual(["travelpayouts", "google_flights", v.name]);
      const status = data.meta.sources[2];
      expect(status).toMatchObject({ name: v.name, enabled: true });
      expect(status?.calls).toBeGreaterThan(0);
      expect(new Set(up.vendorCalls().map((c) => c.url.hostname))).toEqual(new Set([v.host]));
      expect(up.vendorCalls()).toHaveLength(status?.calls as number);
      const rowsNow = await quotaRows(env);
      expect(rowsNow).toHaveLength(1);
      expect(rowsNow[0]).toMatchObject({ source: v.name, period: v.period });
      expect(rowsNow[0]?.used).toBeGreaterThan(0);
      expect(rowsNow[0]?.used).toBeLessThanOrEqual(v.quota.cap);
      // no secret in the answer (the status text is fixed wording, never a vendor body, URL or key)
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
    });
  }

  it("a padded key is trimmed before it is used", async () => {
    const up = stubUpstream();
    await search(makeEnv({ IGNAV_API_KEY: `  ${KEYS.IGNAV_API_KEY}\n` }));
    const headers = up.host("ignav.com")[0]?.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe(KEYS.IGNAV_API_KEY);
  });
});

describe("a live quote reaches the ranking", () => {
  it("a verified Ignav price of 120 USD beats the cached 189 USD for the same dates and wins the cheapest card", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const { data } = await search(makeEnv({ IGNAV_API_KEY: KEYS.IGNAV_API_KEY }));
    const cheapest = data.cards.find((c) => (c.kinds as string[]).includes("cheapest"));
    expect(cheapest?.offer).toMatchObject({ source: "ignav", priceAmount: 120, priceCurrency: "USD", totalIls: 432 });
    // only the two date pairs inside the window were asked (the third fixture fare is out of it), each exactly once
    const asked = up.host("ignav.com").map((c) => (JSON.parse(String(c.init.body)) as { departure_date: string }).departure_date).sort();
    expect(asked).toEqual(["2026-11-12", "2026-11-14"]);
    expect(data.meta.sources[2]).toMatchObject({ name: "ignav", ok: true, calls: 2, offers: 2, error: null });
  });

  it("the same search again inside the cache TTL asks no vendor and spends no unit", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv({ IGNAV_API_KEY: KEYS.IGNAV_API_KEY, SERPAPI_KEY: KEYS.SERPAPI_KEY });
    const first = await search(env);
    const before = { calls: up.fn.mock.calls.length, quota: await quotaRows(env) };
    expect(before.quota.length).toBeGreaterThan(0);

    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    const second = await search(env);
    expect(second.data.meta.fromCache).toBe(true);
    expect(up.fn.mock.calls.length).toBe(before.calls);
    expect(await quotaRows(env)).toEqual(before.quota);
    // the quote the first search found is still shown, as a stored live fare
    expect(second.data.cards.find((c) => (c.kinds as string[]).includes("cheapest"))?.offer.source).toBe(first.data.cards.find((c) => (c.kinds as string[]).includes("cheapest"))?.offer.source);
  });
});

describe("all four keys", () => {
  it("never make more than MAX_QUOTE_CALLS vendor requests in one search, and the whole search stays inside the 50 subrequests of the Free plan", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv(ALL_KEYS);
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(sourceNames(data)).toEqual(["travelpayouts", "google_flights", "ignav", "wego", "searchapi", "serpapi"]);
    expect(up.vendorCalls().length).toBeGreaterThan(0);
    expect(up.vendorCalls().length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    // what each source reports is what actually went out
    for (const v of VENDORS) expect(data.meta.sources.find((s) => s.name === v.name)?.calls, v.name).toBe(up.host(v.host).length);
    // Travelpayouts is capped at 30 and FX at 2 (see MAX_TP_REQUESTS): the worst case of the whole invocation
    expect(30 + 2 + up.vendorCalls().length).toBeLessThanOrEqual(50);
    // every request used a reserved unit: no counter is behind the requests it counts (Wego needs several requests for one unit)
    const used = Object.fromEntries((await quotaRows(env)).map((r) => [r.source, r.used]));
    for (const v of VENDORS) {
      expect(used[v.name], v.name).toBeGreaterThan(0);
      expect(used[v.name] as number, v.name).toBeLessThanOrEqual(up.host(v.host).length);
      expect(used[v.name] as number, v.name).toBeLessThanOrEqual(v.quota.cap);
    }
  });

  it("in the worst case (Wego polling to its limit, every vendor answering) the requests still add up to MAX_QUOTE_CALLS at most", async () => {
    const up = stubUpstream({
      tp: manyPairsTp,
      vendors: {
        "ignav.com": (_url, init) => ignavAnswer(init),
        // pages that parse but hold no fares: Wego uses its token, search and all its polls (real waits of 0.5 + 1 + 1.5 s)
        "affiliate-api.wego.com": (url) =>
          url.pathname === "/apps/oauth/token" ? json({ access_token: "wego-token-0123456789", expires_in: 43199 }) : url.pathname === "/metasearch/flights/searches" ? json({ search: { id: "s-1" } }, 201) : json({ count: 0 }),
      },
    });
    const env = makeEnv(ALL_KEYS);
    const { data } = await search(env);
    expect(up.host("affiliate-api.wego.com")).toHaveLength(WEGO_MAX_REQUESTS_PER_SEARCH); // the worst case really happened
    expect(up.vendorCalls().length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    for (const v of VENDORS) expect(data.meta.sources.find((s) => s.name === v.name)?.calls, v.name).toBe(up.host(v.host).length);
    expect(30 + 2 + up.vendorCalls().length).toBeLessThanOrEqual(50);
  }, 15_000);

  it("one vendor failing (HTTP 500, or refusing the key) does not affect the others or the answer", async () => {
    const up = stubUpstream({
      vendors: {
        "ignav.com": (_url, init) => ignavAnswer(init),
        "serpapi.com": () => json({ error: "boom" }, 500),
        "www.searchapi.io": () => json({ error: "no" }, 401),
      },
    });
    const { res, data, text } = await search(makeEnv(ALL_KEYS));
    expect(res.status).toBe(200);
    const by = (n: string) => data.meta.sources.find((s) => s.name === n);
    expect(by("ignav")).toMatchObject({ ok: true, error: null });
    expect(by("serpapi")).toMatchObject({ ok: false, error: "SerpApi: HTTP 500" });
    expect(by("searchapi")).toMatchObject({ ok: false, error: "SearchApi: HTTP 401" });
    expect(data.cards.find((c) => (c.kinds as string[]).includes("cheapest"))?.offer.source).toBe("ignav");
    for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
    expect(up.vendorCalls().length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
  });
});

describe("the caps hold at the Worker entry", () => {
  it("a source whose counter is at its cap is not called, the others are, and its counter does not move", async () => {
    for (const v of VENDORS) {
      const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
      const env = makeEnv(ALL_KEYS);
      await env.DB.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES (?, ?, ?, ?)").bind(v.name, v.period, v.quota.cap, NOW.toISOString()).run();
      const { res, data } = await search(env);
      expect(res.status, v.name).toBe(200);
      expect(up.host(v.host), v.name).toEqual([]);
      const status = data.meta.sources.find((s) => s.name === v.name);
      expect(status, v.name).toMatchObject({ calls: 0, ok: false });
      expect(status?.error, v.name).toContain("free quota used up");
      expect((await quotaRows(env)).find((r) => r.source === v.name), v.name).toMatchObject({ used: v.quota.cap });
      // every other configured source still ran
      for (const other of VENDORS.filter((o) => o.name !== v.name)) expect(up.host(other.host).length, `${v.name} full, ${other.name}`).toBeGreaterThan(0);
    }
  });

  it("a cap is spent only across searches, never within a month for a monthly vendor: SerpApi's counter is per UTC month", async () => {
    stubUpstream();
    const env = makeEnv({ SERPAPI_KEY: KEYS.SERPAPI_KEY });
    await env.DB.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('serpapi', '2026-09', ?, ?)").bind(SERPAPI_QUOTA.cap, NOW.toISOString()).run();
    const up = stubUpstream();
    await search(env); // October: September's full counter does not block it
    expect(up.host("serpapi.com").length).toBeGreaterThan(0);
    expect((await quotaRows(env)).map((r) => [r.source, r.period])).toEqual([["serpapi", "2026-09"], ["serpapi", "2026-10"]]);
  });

  it("without migration 0004 (no source_quota table) no vendor is ever called, and the search still answers", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv(ALL_KEYS);
    await env.DB.prepare("DROP TABLE source_quota").run();
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(up.vendorCalls()).toEqual([]);
    expect(data.cards.length).toBeGreaterThan(0);
    expect(data.cards.every((c) => c.offer.source !== "ignav")).toBe(true);
    for (const v of VENDORS) expect(data.meta.sources.find((s) => s.name === v.name), v.name).toMatchObject({ calls: 0, ok: false });
  });

  it("with a database that cannot write the counters no vendor is called (fail closed), and the search still answers", async () => {
    const up = stubUpstream();
    const real = createTestD1();
    // Reads and every other write work; only the counter statement fails, like a D1 whose write quota is spent.
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, target) as unknown;
        return (sql: string) => {
          if (/source_quota/i.test(sql)) throw new Error("D1_ERROR: write quota exceeded");
          return target.prepare(sql);
        };
      },
    });
    const { res, data } = await search(makeEnv({ ...ALL_KEYS, DB: db as D1Database }));
    expect(res.status).toBe(200);
    expect(up.vendorCalls()).toEqual([]);
    expect(data.cards.length).toBeGreaterThan(0);
  });
});

describe("the scheduled job", () => {
  it("makes no outbound request and touches no quota row, even with every key set", async () => {
    const up = stubUpstream();
    const env = makeEnv(ALL_KEYS);
    await env.DB.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('ignav', 'lifetime', 7, '2020-01-01T00:00:00.000Z')").run();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: NOW.getTime() + 400 * 86_400_000, cron: "17 3 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect(up.fn).not.toHaveBeenCalled();
    expect(await quotaRows(env)).toEqual([{ source: "ignav", period: "lifetime", used: 7 }]); // long past every retention window, still there
  });
});

// --- review fixes -------------------------------------------------------------------------------------------

describe("the affiliate marker reaches every live booking link", () => {
  /** One round trip for the dates asked, in the shape each vendor's docs show, cheaper than the cached 189 and not "implausibly" so. */
  const searchApiAnswer = (url: URL): Response => {
    const dep = url.searchParams.get("outbound_date") ?? "";
    return json({
      best_flights: [
        {
          flights: [{ departure_airport: { id: "TLV", date: dep, time: "08:05" }, arrival_airport: { id: "BCN", date: dep, time: "12:55" }, duration: 290, airline: "El Al", travel_class: "Economy", flight_number: "LY 395" }],
          total_duration: 290,
          price: 150,
          type: "Round trip",
        },
      ],
    });
  };
  const serpApiAnswer = (url: URL): Response => {
    const dep = url.searchParams.get("outbound_date") ?? "";
    return json({
      best_flights: [
        {
          flights: [{ departure_airport: { id: "TLV", time: `${dep} 08:05` }, arrival_airport: { id: "BCN", time: `${dep} 12:55` }, duration: 290, airline: "El Al", travel_class: "Economy", flight_number: "LY 395" }],
          total_duration: 290,
          price: 150,
          type: "Round trip",
        },
      ],
    });
  };
  const marked = [
    { name: "ignav", envVar: "IGNAV_API_KEY", host: "ignav.com", answer: (_url: URL, init: RequestInit) => ignavAnswer(init) },
    { name: "searchapi", envVar: "SEARCHAPI_KEY", host: "www.searchapi.io", answer: (url: URL) => searchApiAnswer(url) },
    { name: "serpapi", envVar: "SERPAPI_KEY", host: "serpapi.com", answer: (url: URL) => serpApiAnswer(url) },
  ] as const;

  for (const v of marked) {
    it(`${v.name}: the live offer that wins the cheapest card links to Aviasales with TRAVELPAYOUTS_MARKER`, async () => {
      stubUpstream({ vendors: { [v.host]: v.answer } });
      const { data } = await search(makeEnv({ [v.envVar]: KEYS[v.envVar] } as Partial<Env>));
      const cheapest = data.cards.find((c) => (c.kinds as string[]).includes("cheapest"));
      expect(cheapest?.offer.source).toBe(v.name);
      expect(cheapest?.offer.deeplink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/TLV1211BCN18111\?marker=12345/);
    });
  }
});

describe("the daily shares hold at the Worker entry", () => {
  const dayStart = Math.floor(NOW.getTime() / 86_400_000) * 86_400;
  const usedBy = async (env: Env) => Object.fromEntries((await quotaRows(env)).map((r) => [r.source, r.used]));

  it("30 searches from one client, each dodging the cache, use a day's share of each vendor and nothing more; the next day renews it", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv({ IGNAV_API_KEY: KEYS.IGNAV_API_KEY, SEARCHAPI_KEY: KEYS.SEARCHAPI_KEY, SERPAPI_KEY: KEYS.SERPAPI_KEY });
    const dodge = (i: number) => ({ ...BODY, stayMax: 6 + (i % 15), adults: 1 + Math.floor(i / 15) }); // 30 different search keys
    for (let i = 0; i < 30; i++) expect((await search(env, dodge(i))).res.status).toBe(200);
    const ration = { searchapi: dailyShare("lifetime", SEARCHAPI_QUOTA.cap), serpapi: dailyShare("2026-10", SERPAPI_QUOTA.cap), ignav: dailyShare("lifetime", IGNAV_QUOTA.cap) };
    expect(up.host("www.searchapi.io")).toHaveLength(ration.searchapi);
    expect(up.host("serpapi.com")).toHaveLength(ration.serpapi);
    expect(up.host("ignav.com").length).toBeLessThanOrEqual(ration.ignav);
    const used = await usedBy(env);
    expect(used.searchapi).toBe(ration.searchapi); // 2 of the 50: the allowance is intact
    expect(used.serpapi).toBe(ration.serpapi); // 4 of the 100 of this month
    expect(used.ignav).toBeLessThanOrEqual(ration.ignav);
    expect(await quotaRows(env)).toHaveLength(3); // the daily counters live elsewhere: one row per vendor and period, as before

    vi.setSystemTime(new Date(NOW.getTime() + 24 * 3_600_000));
    await search(env, { ...BODY, stayMax: 25 });
    expect((await usedBy(env)).searchapi).toBe(2 * ration.searchapi);
    expect(up.host("www.searchapi.io")).toHaveLength(2 * ration.searchapi);
  });

  it("a vendor whose share is spent is not called and says so, the others are; its real counter does not move", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv(ALL_KEYS);
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('quota:ignav', ?, ?)").bind(dayStart, dailyShare("lifetime", IGNAV_QUOTA.cap)).run();
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(up.host("ignav.com")).toEqual([]);
    expect(data.meta.sources.find((s) => s.name === "ignav")).toMatchObject({ calls: 0, ok: false, error: "Ignav: today's share of the free quota used up" });
    expect((await quotaRows(env)).find((r) => r.source === "ignav")).toBeUndefined();
    for (const other of VENDORS.filter((o) => o.name !== "ignav")) expect(up.host(other.host).length, other.name).toBeGreaterThan(0);
  });

  it("with the daily counters unreadable (no rate_limits table) no vendor is called, and the search still answers", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const env = makeEnv(ALL_KEYS);
    await env.DB.prepare("DROP TABLE rate_limits").run();
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(up.vendorCalls()).toEqual([]);
    expect(data.cards.length).toBeGreaterThan(0);
    for (const v of VENDORS) expect(data.meta.sources.find((s) => s.name === v.name), v.name).toMatchObject({ calls: 0, ok: false, error: expect.stringContaining("free quota used up") });
    expect(await quotaRows(env)).toEqual([]);
  });
});

describe("the 50-subrequest budget, measured (not computed)", () => {
  const FX_HOSTS = ["boi.org.il", "open.er-api.com"];
  const measure = (up: ReturnType<typeof stubUpstream>) => ({
    total: up.fn.mock.calls.length,
    travelpayouts: up.tpCalls().length,
    vendors: up.vendorCalls().length,
    fx: up.calls.filter((c) => FX_HOSTS.includes(c.url.hostname)).length,
  });

  it("a search with every key: every outbound call is Travelpayouts, FX or a vendor, and the total stays under 50", async () => {
    const up = stubUpstream({ vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    await search(makeEnv(ALL_KEYS));
    const m = measure(up);
    expect(m.total).toBeLessThanOrEqual(50);
    expect(m.travelpayouts).toBeLessThanOrEqual(MAX_TP_REQUESTS);
    expect(m.fx).toBeLessThanOrEqual(2);
    expect(m.vendors).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    expect(m.total).toBe(m.travelpayouts + m.fx + m.vendors); // nothing else leaves the Worker
  });

  it("and when Travelpayouts uses its whole budget first (wide window, nearby airports) the vendors are still asked and the total still holds", async () => {
    const up = stubUpstream({ tp: manyPairsTp, vendors: { "ignav.com": (_url, init) => ignavAnswer(init) } });
    const { res } = await search(makeEnv(ALL_KEYS), { ...BODY, windowEnd: "2027-01-05", nearbyAirports: true });
    expect(res.status).toBe(200);
    const m = measure(up);
    expect(m.travelpayouts).toBe(MAX_TP_REQUESTS); // the scan really reached its cap
    expect(m.vendors).toBeGreaterThan(0);
    expect(m.vendors).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    expect(m.total).toBeLessThanOrEqual(50);
    expect(m.total).toBe(m.travelpayouts + m.fx + m.vendors);
  }, 15_000);
});

describe("nothing a search logs holds a key or a vendor URL", () => {
  it("every key set, every kind of vendor failure, and a database that cannot take the counters", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    stubUpstream({
      vendors: {
        "ignav.com": () => json({ error: "boom" }, 500),
        "www.searchapi.io": () => json({ error: "no" }, 401),
        "serpapi.com": () => {
          throw new TypeError("fetch failed");
        },
        "affiliate-api.wego.com": () => new Response("<html>", { status: 200 }),
      },
    });
    const flaky = createTestD1();
    const db = new Proxy(flaky, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop, target) as unknown;
        return (sql: string) => {
          if (/source_quota/i.test(sql)) throw new Error("D1_ERROR: write quota exceeded");
          return target.prepare(sql);
        };
      },
    });
    for (const env of [makeEnv(ALL_KEYS), makeEnv({ ...ALL_KEYS, DB: db as D1Database })]) {
      const { text } = await search(env);
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
    }
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const key of Object.values(KEYS)) expect(logged).not.toContain(key);
    for (const host of VENDOR_HOSTS) expect(logged).not.toContain(host);
    for (const spy of spies) spy.mockRestore();
  });
});
