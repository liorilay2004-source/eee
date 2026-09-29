/**
 * End-to-end: real Request objects into worker.fetch, D1 shim behind it, global fetch stubbed for Travelpayouts and
 * the FX endpoints (every outbound call is counted). Mapped to SPEC §14 and §16.
 * The Date is frozen (Date only: timers stay real) so fixed fixture dates are always in the future.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import * as entry from "../src/index";
import { defaultResolver, sha256Hex } from "../src/pipeline";
import {
  GLOBAL_SCAN_LIMIT,
  GLOBAL_SCAN_WINDOW_SECONDS,
  MAX_ADVANCE_DAYS,
  MAX_BODY_BYTES,
  MAX_PASSENGERS,
  MAX_STAY_NIGHTS,
  MAX_VALID_PAIRS,
  MAX_WINDOW_DAYS,
  parseSearchBody,
  RATE_LIMIT_MAX,
} from "../src/validate";
import type { Env, SearchResponse } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;

const NOW = new Date("2026-10-01T09:00:00.000Z");
const TOKEN = "tp-SECRET-token-0123456789abcdef";
const BASE = "https://api.example.test";
const ORIGIN = "https://app.example.test";
const IP = "203.0.113.7";

const BODY = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clone = <T>(v: T): T => structuredClone(v);

// --- upstream stub ---------------------------------------------------------------------------------------

interface Outbound {
  url: URL;
  init: RequestInit;
}

interface UpstreamOptions {
  tp?: (url: URL) => Response;
  boi?: () => Response;
  erapi?: () => Response;
}

const BOI_PAYLOAD = {
  exchangeRates: [
    { key: "USD", currentExchangeRate: 3.6, unit: 1 },
    { key: "EUR", currentExchangeRate: 3.9, unit: 1 },
    { key: "JPY", currentExchangeRate: 2.4, unit: 100 },
  ],
};

/** Same behaviour as the Python test double: one-way calls get the one-way fixture filtered by origin. */
function fixtureTp(url: URL): Response {
  if (url.searchParams.get("one_way") === "true") {
    const body = clone(onewayFixture) as { data: { origin: string }[] };
    body.data = body.data.filter((d) => d.origin === url.searchParams.get("origin"));
    return json(body);
  }
  return json(roundtripFixture);
}

function stubUpstream(opts: UpstreamOptions = {}) {
  const calls: Outbound[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init: init ?? {} });
    if (url.hostname === "api.travelpayouts.com") return (opts.tp ?? fixtureTp)(url);
    if (url.hostname === "boi.org.il") return (opts.boi ?? (() => json(BOI_PAYLOAD)))();
    if (url.hostname === "open.er-api.com") return (opts.erapi ?? (() => json({ result: "success", rates: { USD: 0.2778, EUR: 0.2564 } })))();
    throw new Error(`unexpected outbound call to ${url.hostname}`);
  });
  vi.stubGlobal("fetch", fn);
  const host = (h: string) => calls.filter((c) => c.url.hostname === h);
  return { calls, fn, tpCalls: () => host("api.travelpayouts.com"), fxCalls: () => host("boi.org.il").concat(host("open.er-api.com")) };
}

// --- harness ---------------------------------------------------------------------------------------------

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: TOKEN, TRAVELPAYOUTS_MARKER: "12345", ...over };
}

/** Calls the worker like the runtime does, then lets ctx.waitUntil work finish (persistence). */
async function call(env: Env, path: string, init: RequestInit = {}, request?: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(request ?? new Request(`${BASE}${path}`, init), env, ctx);
  await Promise.all(pending);
  return res;
}

function post(env: Env, body: unknown, headers: Record<string, string> = {}, path = "/api/search"): Promise<Response> {
  return call(env, path, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": IP, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const search = async (env: Env, body: unknown = BODY, headers: Record<string, string> = {}) => {
  const res = await post(env, body, headers);
  return { res, data: (await res.clone().json()) as SearchResponse & { error?: { code: string; message: string; fields?: Record<string, string> } } };
};

const rows = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
const cardOf = (data: SearchResponse, kind: string) => data.cards.find((c) => (c.kinds as string[]).includes(kind));

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

// ---------------------------------------------------------------------------------------------------------

describe("Worker entry module", () => {
  it("exports only the default handler: workerd refuses to load a Worker whose main module exports anything else", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof entry.default.fetch).toBe("function");
  });
});

describe("POST /api/search: the happy path with Travelpayouts fixtures", () => {
  it("returns the recommendations, priced in ILS with the original USD kept", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    // Fixture: round trips 189/264 USD, one-ways 79 (W6) + 85 (VY) = 164 USD split. USD = 3.6 ILS.
    const cheapest = cardOf(data, "cheapest");
    expect(cheapest?.offer).toMatchObject({ ticketStructure: "split", priceAmount: 164, priceCurrency: "USD", totalIls: 590.4 });
    expect(cheapest?.savingsVsRoundtripIls).toBeCloseTo((189 - 164) * 3.6, 6);
    expect(cardOf(data, "my_times")).toBeUndefined(); // no hour windows -> card hidden
    expect(data.meta).toMatchObject({ fromCache: false, fxSource: "bank_of_israel", fxDate: "2026-10-01", candidatePairs: 2 });
    expect(data.meta.sources[0]).toMatchObject({ name: "travelpayouts", ok: true, calls: 3, error: null });

    // 1 month window: 1 round-trip request + 2 one-way requests; one FX request.
    expect(up.tpCalls()).toHaveLength(3);
    expect(up.fxCalls()).toHaveLength(1);
  });

  it("sends the token in a header only, with the market of the origin country", async () => {
    const up = stubUpstream();
    const { res } = await search(makeEnv());
    for (const c of up.tpCalls()) {
      expect(c.url.toString()).not.toContain(TOKEN);
      expect((c.init.headers as Record<string, string>)["X-Access-Token"]).toBe(TOKEN);
      // the market follows the origin country of each request: TLV -> il, the BCN -> TLV one-way -> es
      expect(c.url.searchParams.get("market")).toBe(c.url.searchParams.get("origin") === "TLV" ? "il" : "es");
    }
    expect(up.tpCalls().some((c) => c.url.searchParams.get("market") === "il")).toBe(true);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("stores the original currency in D1, the raw offers in the cache and the search itself", async () => {
    stubUpstream();
    const env = makeEnv();
    const { data } = await search(env);
    const prices = await rows<{ price_currency: string; price_amount: number; source: string }>(env, "SELECT price_currency, price_amount, source FROM prices");
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p.price_currency === "USD" && p.source === "travelpayouts")).toBe(true);
    expect(prices.map((p) => p.price_amount)).toContain(164);

    const cached = await rows<{ search_key: string }>(env, "SELECT search_key FROM search_cache");
    expect(cached.map((c) => c.search_key)).toEqual([data.meta.searchKey]);
    const searches = await rows<{ origin: string; destination: string }>(env, "SELECT origin, destination FROM searches");
    expect(searches).toEqual([{ origin: "TLV", destination: "BCN" }]);
    const [health] = await rows<{ source: string; consecutive_failures: number }>(env, "SELECT source, consecutive_failures FROM source_health");
    expect(health).toEqual({ source: "travelpayouts", consecutive_failures: 0 });
    const fx = await rows<{ currency: string }>(env, "SELECT currency FROM fx_rates WHERE date = '2026-10-01' ORDER BY currency");
    expect(fx.map((r) => r.currency)).toEqual(["EUR", "ILS", "JPY", "USD"]);
  });

  it("the same search twice within 6h: the second makes ZERO outbound fetches", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const first = await search(env);
    expect(first.data.meta.fromCache).toBe(false);
    const outboundAfterFirst = up.fn.mock.calls.length;
    expect(outboundAfterFirst).toBe(4);

    vi.setSystemTime(new Date(NOW.getTime() + 5 * 3_600_000)); // still inside the 6h TTL
    const second = await search(env);
    expect(second.res.status).toBe(200);
    expect(second.data.meta.fromCache).toBe(true);
    expect(up.fn.mock.calls.length).toBe(outboundAfterFirst); // FX from D1, fares from the cache
    expect(second.data.cards.map((c) => c.offer.priceAmount)).toEqual(first.data.cards.map((c) => c.offer.priceAmount));
    expect(second.data.meta.sources[0]).toMatchObject({ calls: 0, ok: true });
  });

  it("a cache hit on the next UTC day still makes zero outbound fetches", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    vi.setSystemTime(new Date("2026-10-01T22:30:00.000Z"));
    await search(env);
    const outbound = up.fn.mock.calls.length;
    vi.setSystemTime(new Date("2026-10-02T01:30:00.000Z"));
    const { data } = await search(env);
    expect(data.meta.fromCache).toBe(true);
    expect(up.fn.mock.calls.length).toBe(outbound);
  });

  it("after the TTL the stale row answers at once, marked, and ONE background rescan refreshes it", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const first = await search(env);
    expect(first.data.meta.stale).toBeUndefined();
    vi.setSystemTime(new Date(NOW.getTime() + 6 * 3_600_000 + 1000));
    const { res, data } = await search(env);
    expect(res.status).toBe(200);
    expect(data.meta.fromCache).toBe(true);
    expect(data.meta.stale).toEqual({
      cachedAt: NOW.toISOString(),
      ageHours: 6,
      revalidating: true,
      messageHe: expect.stringContaining("לפני 6 שעות"),
    });
    expect(data.meta.stale?.messageHe).toContain("חפשו שוב");
    expect(data.cards.map((c) => c.offer.priceAmount)).toEqual(first.data.cards.map((c) => c.offer.priceAmount));
    // Every card says its fares are as old as the scan behind them.
    for (const c of data.cards) expect(c.ageHours).toBeGreaterThanOrEqual(6);
    expect(up.tpCalls()).toHaveLength(6); // the background rescan (waitUntil) made the same 3 requests again
    expect(up.fxCalls()).toHaveLength(1); // same UTC day: rates come from D1

    // The rescan rewrote the row: the next identical search is an ordinary in-TTL hit, no stale mark, no call.
    const again = await search(env);
    expect(again.data.meta.fromCache).toBe(true);
    expect(again.data.meta.stale).toBeUndefined();
    expect(up.tpCalls()).toHaveLength(6);
    // The stale answer logged its search once; the rescan did not log another.
    expect(await rows(env, "SELECT id FROM searches")).toHaveLength(3);
  });

  it("past the stale bound (24h) the row is not served: a fresh scan runs in the request", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    await search(env);
    vi.setSystemTime(new Date(NOW.getTime() + 24 * 3_600_000));
    const { data } = await search(env);
    expect(data.meta.fromCache).toBe(false);
    expect(data.meta.stale).toBeUndefined();
    expect(up.tpCalls()).toHaveLength(6);
  });

  it("a burst of stale hits starts one rescan only (the per-key lock), and later ones say they are not revalidating", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 3_600_000));
    // The rescan fails, so the row stays stale: the next hits must not rescan again inside the lock window.
    const failing = stubUpstream({ tp: () => new Response("upstream down", { status: 502 }) });
    const a = await search(env);
    const b = await search(env);
    expect(a.data.meta.stale?.revalidating).toBe(true);
    expect(b.data.meta.stale?.revalidating).toBe(false);
    expect(b.data.meta.stale?.messageHe).not.toContain("חפשו שוב");
    expect(b.data.meta.fromCache).toBe(true);
    expect(failing.tpCalls().length).toBeGreaterThan(0);
    const afterBurst = failing.tpCalls().length;
    const c = await search(env);
    expect(c.data.meta.stale?.revalidating).toBe(false);
    expect(failing.tpCalls()).toHaveLength(afterBurst);
    const [health] = await rows<{ consecutive_failures: number }>(env, "SELECT consecutive_failures FROM source_health WHERE source = 'travelpayouts'");
    expect(health?.consecutive_failures).toBe(1); // the failed rescan is recorded, once
    // Polled every 5 minutes, the key still gets exactly one rescan per 10-minute window: refused claims never push it back.
    const t0 = NOW.getTime() + 7 * 3_600_000; // 16:00:00Z, a window boundary
    const seen: boolean[] = [];
    for (let i = 1; i <= 6; i++) {
      vi.setSystemTime(new Date(t0 + i * 5 * 60_000));
      seen.push((await search(env, BODY, { "CF-Connecting-IP": `198.51.100.${i}` })).data.meta.stale?.revalidating ?? false);
    }
    expect(seen).toEqual([false, true, false, true, false, true]);
    expect(failing.tpCalls().length).toBeGreaterThan(afterBurst);
  });

  it("a stale hit with the global scan budget spent answers stale and does not rescan", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 3_600_000));
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / GLOBAL_SCAN_WINDOW_SECONDS) * GLOBAL_SCAN_WINDOW_SECONDS;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?)").bind(windowStart, GLOBAL_SCAN_LIMIT + 5).run();
    const up = stubUpstream();
    const { data } = await search(env);
    expect(data.meta.fromCache).toBe(true);
    expect(data.meta.stale?.revalidating).toBe(false);
    expect(up.tpCalls()).toHaveLength(0);
  });

  it("an old EMPTY scan is never served stale", async () => {
    stubUpstream({ tp: () => json({ success: true, data: [], currency: "eur" }) });
    const env = makeEnv();
    await search(env);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 3_600_000));
    const up = stubUpstream({ tp: () => json({ success: true, data: [], currency: "eur" }) });
    const { data } = await search(env);
    expect(data.meta.fromCache).toBe(false);
    expect(data.meta.stale).toBeUndefined();
    expect(up.tpCalls().length).toBeGreaterThan(0);
  });

  it("a variant search in the same 6h bin does not rewrite unchanged fares to the price history", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env);
    const before = (await rows(env, "SELECT id FROM prices")).length;
    expect(before).toBeGreaterThan(0);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const variant = await search(env, { ...BODY, stayMax: 8 }); // another search key over the same fares
    expect(variant.data.meta.fromCache).toBe(false);
    expect((await rows(env, "SELECT id FROM prices")).length).toBe(before);
    // The next bin writes them again: one observation per bin is what deal detection counts.
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    await search(env, { ...BODY, stayMax: 9 });
    expect((await rows(env, "SELECT id FROM prices")).length).toBe(2 * before);
  });

  it("a different bag choice on cached data re-ranks without any outbound call", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const plain = await search(env);
    const outbound = up.fn.mock.calls.length;
    expect(cardOf(plain.data, "cheapest")?.offer).toMatchObject({ extrasAmountIls: 0, totalIls: 590.4 });

    const bag = await search(env, { ...BODY, checkedBag: true });
    expect(bag.data.meta.fromCache).toBe(true);
    expect(up.fn.mock.calls.length).toBe(outbound);
    // split = W6 out + VY back: (45 + 35) EUR x 3.9 = 312 ILS on top of 590.4
    expect(cardOf(bag.data, "cheapest")?.offer).toMatchObject({ extrasAmountIls: 312, totalIls: 902.4, priceAmount: 164 });
  });

  it("adds the 🎯 card only when hour windows are given, on the cached data", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env);
    const timed = await search(env, { ...BODY, outHours: [5, 9], retHours: [10, 14] });
    expect(timed.data.meta.fromCache).toBe(true);
    const mine = cardOf(timed.data, "my_times");
    // W6 leaves at 06:15 (inside 5-9); the only 10-14 return is VY at 12:10 (split)
    expect(mine?.offer).toMatchObject({ ticketStructure: "split", outbound: { departTime: "06:15" }, inbound: { departTime: "12:10" } });
  });
});

describe("POST /api/search: places", () => {
  it("resolves Hebrew city names: תל אביב -> TLV, ברצלונה -> BCN", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    const { res } = await search(env, { ...BODY, origin: "תל אביב", destination: "ברצלונה" });
    expect(res.status).toBe(200);
    const first = up.tpCalls()[0]?.url.searchParams;
    expect([first?.get("origin"), first?.get("destination")]).toEqual(["TLV", "BCN"]);
    const [s] = await rows<{ origin: string; destination: string }>(env, "SELECT origin, destination FROM searches");
    expect(s).toEqual({ origin: "TLV", destination: "BCN" });
  });

  it("gives the same cache key for Hebrew, English and IATA spellings of one place", async () => {
    stubUpstream();
    const env = makeEnv();
    const a = await search(env, { ...BODY, origin: "תל אביב", destination: "ברצלונה" });
    const b = await search(env, { ...BODY, origin: "tel aviv", destination: "Barcelona" });
    const c = await search(env, { ...BODY, origin: "tlv", destination: "BCN" });
    expect(new Set([a.data.meta.searchKey, b.data.meta.searchKey, c.data.meta.searchKey]).size).toBe(1);
    expect(c.data.meta.fromCache).toBe(true);
  });

  it("scans nearby airports only when asked", async () => {
    const up = stubUpstream();
    await search(makeEnv(), { ...BODY, nearbyAirports: true });
    const dests = new Set(up.tpCalls().map((c) => c.url.searchParams.get("destination")));
    expect([...dests].sort()).toEqual(["BCN", "GRO", "REU", "TLV"]); // TLV: the return one-ways
    const up2 = stubUpstream();
    await search(makeEnv(), BODY);
    expect(new Set(up2.tpCalls().map((c) => c.url.searchParams.get("destination")))).toEqual(new Set(["BCN", "TLV"]));
  });

  it("an airport search does not expand to the city's other airports", async () => {
    const up = stubUpstream();
    await search(makeEnv(), { ...BODY, origin: "LHR", destination: "CDG" });
    const routes = new Set(up.tpCalls().map((c) => `${c.url.searchParams.get("origin")}-${c.url.searchParams.get("destination")}`));
    expect(routes).toEqual(new Set(["LHR-CDG", "CDG-LHR"]));
  });
});

describe("POST /api/search: validation (SPEC §5, §4.1)", () => {
  const invalid = async (patch: Record<string, unknown>) => {
    const up = stubUpstream();
    const out = await search(makeEnv(), { ...BODY, ...patch });
    expect(up.fn).not.toHaveBeenCalled(); // bad input never reaches an external service
    return out;
  };

  it("400 with per-field errors, in the documented error format", async () => {
    const { res, data } = await invalid({ windowStart: "2026-09-30", stayMin: 9, stayMax: 3, adults: "2", outHours: [25, 3] });
    expect(res.status).toBe(400);
    expect(data.error?.code).toBe("invalid_request");
    expect(data.error?.message).toEqual(expect.any(String));
    expect(Object.keys(data.error?.fields ?? {}).sort()).toEqual(["adults", "outHours", "stayMax", "windowStart"]);
  });

  it("empty destination: 400 destination_required (spontaneous mode arrives in Phase 2)", async () => {
    for (const destination of ["", "   ", null, undefined]) {
      const { res, data } = await invalid({ destination });
      expect(res.status).toBe(400);
      expect(data.error?.code).toBe("destination_required");
      expect(data.error?.fields?.destination).toBeTruthy();
    }
    const { res, data } = await invalid({ destination: undefined, adults: 0 });
    expect([res.status, data.error?.code]).toEqual([400, "destination_required"]);
    expect(data.error?.fields).toHaveProperty("adults");
  });

  it("unknown places, identical places and non-strings are field errors", async () => {
    expect((await invalid({ destination: "Atlantis Lost City" })).data.error?.fields?.destination).toBeTruthy();
    expect((await invalid({ origin: "" })).data.error?.fields?.origin).toBeTruthy();
    expect((await invalid({ origin: 7 })).data.error?.fields?.origin).toBeTruthy();
    expect((await invalid({ origin: "TLV", destination: "תל אביב" })).data.error?.fields?.destination).toBeTruthy();
  });

  it.each([
    ["past window start", { windowStart: "2026-09-30" }, "windowStart"],
    ["impossible date", { windowStart: "2026-02-30" }, "windowStart"],
    ["wrong date format", { windowStart: "10/11/2026" }, "windowStart"],
    ["window end before start", { windowEnd: "2026-11-09" }, "windowEnd"],
    ["window over 120 days", { windowStart: "2026-11-10", windowEnd: "2027-03-11" }, "windowEnd"],
    ["stay over 30 nights", { stayMax: 31 }, "stayMax"],
    ["stay as string", { stayMin: "5" }, "stayMin"],
    ["fractional stay", { stayMin: 5.5 }, "stayMin"],
    ["negative stay", { stayMin: -1 }, "stayMin"],
    ["huge stay", { stayMax: 1e9 }, "stayMax"],
    ["stayMin above stayMax", { stayMin: 8, stayMax: 7 }, "stayMax"],
    ["ten passengers", { adults: 9, children: 1 }, "adults"],
    ["infants above adults", { adults: 1, infants: 2 }, "infants"],
    ["zero adults", { adults: 0 }, "adults"],
    ["hour 25", { outHours: [0, 25] }, "outHours"],
    ["negative hour", { retHours: [-1, 5] }, "retHours"],
    ["fractional hour", { outHours: [6.5, 9] }, "outHours"],
    ["hours as strings", { outHours: ["6", "9"] }, "outHours"],
    ["hours of the wrong length", { outHours: [6] }, "outHours"],
    ["empty hour window", { outHours: [6, 6] }, "outHours"],
    ["max stops as string", { maxStops: "1" }, "maxStops"],
    ["negative max stops", { maxStops: -1 }, "maxStops"],
    ["unknown cabin", { cabin: "luxury" }, "cabin"],
    ["bag as string", { checkedBag: "true" }, "checkedBag"],
    ["nearby as number", { nearbyAirports: 1 }, "nearbyAirports"],
    ["too many date combinations", { windowStart: "2026-11-10", windowEnd: "2027-01-09", stayMin: 3, stayMax: 10 }, "windowEnd"],
    ["no trip fits the window", { windowEnd: "2026-11-12", stayMin: 5, stayMax: 7 }, "stayMin"],
  ])("rejects %s", async (_name, patch, field) => {
    const { res, data } = await invalid(patch);
    expect(res.status).toBe(400);
    expect(data.error?.fields).toHaveProperty(field);
  });

  it("malformed JSON, non-object bodies and bad encodings are 400", async () => {
    stubUpstream();
    const env = makeEnv();
    for (const body of ["{", "not json", "", "null", "[]", "7", '"x"']) {
      const res = await post(env, body);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: string } };
      expect(["invalid_json", "invalid_request"]).toContain(data.error.code);
    }
    const bad = await call(env, "/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(bad.status).toBe(400);
  });

  it("accepts a content type with a charset parameter and ignores unknown keys", async () => {
    stubUpstream();
    const res = await post(makeEnv(), { ...BODY, futureField: { a: 1 } }, { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });

  it("applies the documented defaults: 1 adult, economy, no bag, no filters, nearby off", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env);
    const [s] = await rows<{ pax_json: string; cabin: string; extras_json: string; filters_json: string }>(env, "SELECT pax_json, cabin, extras_json, filters_json FROM searches");
    expect(JSON.parse(s?.pax_json ?? "")).toEqual({ adults: 1, children: 0, infants: 0 });
    expect(s?.cabin).toBe("economy");
    expect(JSON.parse(s?.extras_json ?? "")).toEqual({ checked_bag: false });
    expect(JSON.parse(s?.filters_json ?? "")).toEqual({ out_hours: null, ret_hours: null, max_stops: null, nearby_airports: false });
  });
});

describe("POST /api/search: body limits", () => {
  it("413 when Content-Length is over 8 KB, without reading or scanning anything", async () => {
    const up = stubUpstream();
    const res = await post(makeEnv(), { ...BODY, pad: "x".repeat(MAX_BODY_BYTES) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(up.fn).not.toHaveBeenCalled();
  });

  it("413 for a chunked body with no Content-Length that grows past the limit", async () => {
    const up = stubUpstream();
    const chunk = new TextEncoder().encode(" ".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        sent += 1;
        if (sent > 20) controller.close(); // 20 KB: never fully consumed if the limit works
      },
    });
    const req = new Request(`${BASE}/api/search`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": IP }, body: stream, duplex: "half" } as RequestInit);
    const res = await call(makeEnv(), "", {}, req);
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(21);
    expect(up.fn).not.toHaveBeenCalled();
  });

  it("a body of exactly 8 KB is accepted", async () => {
    stubUpstream();
    const json = JSON.stringify(BODY);
    const padded = json + " ".repeat(MAX_BODY_BYTES - json.length);
    expect(padded.length).toBe(MAX_BODY_BYTES);
    expect((await post(makeEnv(), padded)).status).toBe(200);
  });

  it("415 for other content types, including none", async () => {
    stubUpstream();
    const env = makeEnv();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const headers: Record<string, string> = { "CF-Connecting-IP": IP };
      if (contentType) headers["content-type"] = contentType;
      const res = await call(env, "/api/search", { method: "POST", headers, body: JSON.stringify(BODY) });
      expect(res.status).toBe(415);
    }
  });
});

describe("rate limiting (SPEC §14)", () => {
  it("allows 30 searches per 10 minutes per client, then 429 with Retry-After", async () => {
    stubUpstream();
    const env = makeEnv();
    expect(RATE_LIMIT_MAX).toBe(30); // SPEC §14, pinned here so the constant cannot drift with the loop below
    for (let i = 0; i < 30; i++) {
      const res = await post(env, {});
      expect(res.status, `request ${i + 1}`).toBe(400); // counted even though invalid
    }
    const blocked = await post(env, BODY);
    expect(blocked.status).toBe(429);
    const retry = Number(blocked.headers.get("Retry-After"));
    // The requests of this window also weigh on the next one, so the honest wait can exceed a single window.
    expect(Number.isInteger(retry) && retry >= 1 && retry <= 2 * 600).toBe(true);
    const blockedBody = (await blocked.json()) as { error: { code: string; retryAfterSec?: number } };
    expect(blockedBody.error.code).toBe("rate_limited");
    expect(blockedBody.error.retryAfterSec).toBe(retry); // the body carries the wait too: a cross-origin client may not read headers

    // another client is unaffected
    expect((await post(env, BODY, { "CF-Connecting-IP": "198.51.100.9" })).status).toBe(200);
    // The window is a sliding one: the 31 requests just made still weigh on the next window, and fade out in it.
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    expect((await post(env, BODY)).status).toBe(429); // right at the boundary the whole burst still counts
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60_000));
    expect((await post(env, BODY)).status).toBe(200); // half way through the next window
  });

  it("an IPv6 client is one client per /64: rotating the low 64 bits does not buy a new quota", async () => {
    stubUpstream();
    const env = makeEnv();
    for (let i = 1; i <= 30; i++) {
      const res = await post(env, {}, { "CF-Connecting-IP": `2001:db8:1:2::${i.toString(16)}` });
      expect(res.status, `request ${i}`).toBe(400);
    }
    const blocked = await post(env, {}, { "CF-Connecting-IP": "2001:db8:1:2:abcd:ef01:2345:6789" });
    expect(blocked.status).toBe(429);
    expect(await rows(env, "SELECT * FROM rate_limits")).toHaveLength(1); // one bucket, not 31
    // a different /64 is a different client
    expect((await post(env, {}, { "CF-Connecting-IP": "2001:db8:1:3::1" })).status).toBe(400);
  });

  it("an IPv4-mapped IPv6 address counts as that IPv4 address", async () => {
    stubUpstream();
    const env = makeEnv();
    for (let i = 0; i < 30; i++) await post(env, {}, { "CF-Connecting-IP": IP });
    expect((await post(env, {}, { "CF-Connecting-IP": `::ffff:${IP}` })).status).toBe(429);
  });

  it("limits only /api/search: health, airports and preflight are free", async () => {
    stubUpstream();
    const env = makeEnv();
    for (let i = 0; i < RATE_LIMIT_MAX + 5; i++) {
      expect((await call(env, "/api/health", { headers: { "CF-Connecting-IP": IP } })).status).toBe(200);
      expect((await call(env, "/api/airports?q=tel", { headers: { "CF-Connecting-IP": IP } })).status).toBe(200);
      expect((await call(env, "/api/search", { method: "OPTIONS", headers: { "CF-Connecting-IP": IP } })).status).toBe(204);
    }
    expect(await rows(env, "SELECT * FROM rate_limits")).toHaveLength(0);
  });

  it("never stores the raw IP address", async () => {
    stubUpstream();
    const env = makeEnv();
    await post(env, {});
    const stored = await rows<{ key: string }>(env, "SELECT key FROM rate_limits");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.key).toMatch(/^search:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(IP);
  });

  it("the salt changes the hash (a secret salt makes stored keys unguessable)", async () => {
    stubUpstream();
    const a = makeEnv();
    const b = makeEnv({ RATE_LIMIT_SALT: "another-secret" });
    await post(a, {});
    await post(b, {});
    const [ka] = await rows<{ key: string }>(a, "SELECT key FROM rate_limits");
    const [kb] = await rows<{ key: string }>(b, "SELECT key FROM rate_limits");
    expect(ka?.key).not.toBe(kb?.key);
  });

  it("never stores an address that can be recovered with the old public salt", async () => {
    stubUpstream();
    for (const env of [makeEnv(), makeEnv({ TRAVELPAYOUTS_TOKEN: undefined, RATE_LIMIT_SALT: "s3cret-salt" })]) {
      await post(env, {});
      const [stored] = await rows<{ key: string }>(env, "SELECT key FROM rate_limits");
      expect(stored?.key).not.toBe(`search:${await sha256Hex(`${IP}|tpe-rate-limit-v1`)}`);
    }
    // With RATE_LIMIT_SALT set the hash is exactly sha256(client|salt), so the operator can reason about it.
    const env = makeEnv({ RATE_LIMIT_SALT: "s3cret-salt" });
    await post(env, {});
    const [stored] = await rows<{ key: string }>(env, "SELECT key FROM rate_limits");
    expect(stored?.key).toBe(`search:${await sha256Hex(`${IP}|s3cret-salt`)}`);
  });

  const downDb = { prepare: () => { throw new Error("D1 down: SECRET-DETAIL"); }, batch: () => { throw new Error("D1 down: SECRET-DETAIL"); } } as unknown as D1Database;

  it("keeps serving when the limiter's storage is down (e.g. the D1 free-tier quota is spent) instead of answering 503", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000)); // the failure log is throttled per minute, module-wide: start a fresh minute
    stubUpstream();
    const env = makeEnv({ DB: downDb });
    const res = await post(env, BODY, { "CF-Connecting-IP": "198.51.100.50" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-DETAIL");
    expect((JSON.parse(text) as SearchResponse).cards.length).toBeGreaterThan(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("rate limiter storage unavailable"));
  });

  it("...and the in-memory fallback still limits a client hammering the API", async () => {
    stubUpstream();
    const env = makeEnv({ DB: downDb });
    const headers = { "CF-Connecting-IP": "198.51.100.51" };
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect((await post(env, {}, headers)).status, `request ${i + 1}`).toBe(400);
    const blocked = await post(env, {}, headers);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await post(env, {}, { "CF-Connecting-IP": "198.51.100.52" })).status).toBe(400); // someone else is fine
  });
});

describe("global upstream budget (many clients cannot burn the Travelpayouts quota together)", () => {
  const spend = async (env: Env, used: number) => {
    const windowStart = Math.floor(NOW.getTime() / 1000 / GLOBAL_SCAN_WINDOW_SECONDS) * GLOBAL_SCAN_WINDOW_SECONDS;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?) ON CONFLICT(key, window_start) DO UPDATE SET count = excluded.count").bind(windowStart, used).run();
  };

  it("counts every fresh scan against one shared budget, whoever asks", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    for (let i = 1; i <= 3; i++) {
      const res = await post(env, { ...BODY, adults: i }, { "CF-Connecting-IP": `198.51.100.${i}` }); // each a different client, a different cache key
      expect(res.status).toBe(200);
    }
    const [row] = await rows<{ count: number }>(env, "SELECT count FROM rate_limits WHERE key = 'global:scan'");
    expect(row?.count).toBe(3);
    expect(up.tpCalls().length).toBeGreaterThan(0);
  });

  it("once the budget is spent a new search makes no upstream call: stored fares answer, else 503; cached searches still work", async () => {
    const up = stubUpstream();
    const env = makeEnv();
    expect((await post(env, BODY)).status).toBe(200); // cached now, and its fares are in the history
    await spend(env, GLOBAL_SCAN_LIMIT); // ...and the budget is gone
    const before = up.tpCalls().length;

    const stored = await post(env, { ...BODY, adults: 2 }, { "CF-Connecting-IP": "198.51.100.77" }); // new cache key, same route
    expect(stored.status).toBe(200);
    const storedData = (await stored.json()) as SearchResponse;
    expect(storedData.meta.fromCache).toBe(false);
    expect(storedData.meta.sources[0]).toMatchObject({ ok: false, calls: 0, error: "Travelpayouts: too many searches right now" });

    const nothing = await post(env, { ...BODY, destination: "ATH" }, { "CF-Connecting-IP": "198.51.100.79" }); // nothing stored for it
    expect(nothing.status).toBe(503);
    expect(((await nothing.json()) as { error: { code: string } }).error.code).toBe("source_unavailable");
    expect(up.tpCalls().length).toBe(before);

    const cached = await post(env, BODY, { "CF-Connecting-IP": "198.51.100.78" });
    expect(cached.status).toBe(200);
    expect(((await cached.json()) as SearchResponse).meta.fromCache).toBe(true);
  });
});

describe("scheduled retention job", () => {
  it("prunes what the API can no longer reach, and only that", async () => {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, legs_json, includes_json, checked_at) VALUES (?, ?, ?, ?, 100, 'USD', 'travelpayouts', 'roundtrip', '[]', '{}', '{}', ?)")
      .bind("TLV", "BCN", "2026-08-01", "2026-08-06", NOW.toISOString()).run();
    await env.DB.prepare("INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, legs_json, includes_json, checked_at) VALUES (?, ?, ?, ?, 100, 'USD', 'travelpayouts', 'roundtrip', '[]', '{}', '{}', ?)")
      .bind("TLV", "BCN", "2026-11-12", "2026-11-18", NOW.toISOString()).run();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    const left = await rows<{ depart_date: string }>(env, "SELECT depart_date FROM prices");
    expect(left).toEqual([{ depart_date: "2026-11-12" }]);
  });

  it("never rejects, even when the database is down", async () => {
    const env = makeEnv({ DB: { batch: () => { throw new Error("D1 down"); }, prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});

describe("CORS (never a wildcard)", () => {
  it("preflight from the allowed origin: 204 with exactly that origin", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    const res = await call(env, "/api/search", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After"); // else a cross-origin fetch cannot read the 429 wait
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(res.headers.get("Access-Control-Max-Age")).toBeTruthy();
    expect(res.headers.get("Vary")).toContain("Origin");
    expect(await res.text()).toBe("");
  });

  it("preflight from any other origin gets no CORS grant", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: ORIGIN });
    const res = await call(env, "/api/search", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("without ALLOWED_ORIGIN no origin is ever granted", async () => {
    const env = makeEnv();
    const pre = await call(env, "/api/search", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    stubUpstream();
    const res = await post(env, BODY, { Origin: ORIGIN });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("a wildcard configuration is refused, not echoed", async () => {
    const env = makeEnv({ ALLOWED_ORIGIN: "*" });
    stubUpstream();
    for (const origin of [ORIGIN, "*", "null"]) {
      for (const res of [await call(env, "/api/search", { method: "OPTIONS", headers: { Origin: origin } }), await post(env, BODY, { Origin: origin })]) {
        expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
    }
  });

  it("actual responses carry the grant only for the allowed origin", async () => {
    stubUpstream();
    const env = makeEnv({ ALLOWED_ORIGIN: `${ORIGIN}/` }); // a trailing slash in the config is tolerated
    const ok = await post(env, BODY, { Origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(ok.headers.get("Vary")).toContain("Origin");
    const other = await post(env, BODY, { Origin: "https://evil.example" });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const err = await post(env, {}, { Origin: ORIGIN });
    expect(err.status).toBe(400);
    expect(err.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN); // browsers must be able to read the errors
  });
});

describe("source failures", () => {
  it("Travelpayouts unconfigured and nothing stored: 503 source_unavailable, no internals", async () => {
    const up = stubUpstream();
    const { res, data } = await search(makeEnv({ TRAVELPAYOUTS_TOKEN: undefined }));
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("source_unavailable");
    const text = await res.text();
    expect(text).not.toMatch(/stack|at \w+ \(|TRAVELPAYOUTS_TOKEN/);
    expect(up.tpCalls()).toHaveLength(0); // no token, no request
  });

  it("Travelpayouts failing with a body that echoes the token: 503, and neither the body nor the token leaks", async () => {
    stubUpstream({ tp: () => new Response(`{"error":"invalid token ${TOKEN}","detail":"UPSTREAM-INTERNALS"}`, { status: 500 }) });
    const { res } = await search(makeEnv());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("UPSTREAM-INTERNALS");
  });

  it("Travelpayouts failing but recent fares stored: 200 from the DB with the failure shown in sources", async () => {
    stubUpstream();
    const env = makeEnv();
    await search(env); // fills the price history at NOW
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 3_600_000)); // stored fares still recent
    stubUpstream({ tp: () => new Response("upstream down: UPSTREAM-INTERNALS", { status: 502 }) });
    // A search with no cache row at all (another stay range over the same fares): a stale row would be served instead.
    const { res, data } = await search(env, { ...BODY, stayMax: 8 });
    expect(res.status).toBe(200);
    expect(data.cards.length).toBeGreaterThan(0);
    expect(data.meta.fromCache).toBe(false);
    expect(data.meta.sources[0]).toMatchObject({ ok: false, error: "Travelpayouts: HTTP 502" });
    expect(JSON.stringify(data)).not.toContain("UPSTREAM-INTERNALS");
    const [health] = await rows<{ consecutive_failures: number; last_error: string }>(env, "SELECT consecutive_failures, last_error FROM source_health");
    expect(health?.consecutive_failures).toBe(1);
  });

  it("no exchange rate anywhere: 503 fx_unavailable", async () => {
    stubUpstream({ boi: () => new Response("x", { status: 500 }), erapi: () => new Response("x", { status: 500 }) });
    const { res, data } = await search(makeEnv());
    expect(res.status).toBe(503);
    expect(data.error?.code).toBe("fx_unavailable");
  });

  it("falls back to the second FX source when Bank of Israel is down", async () => {
    stubUpstream({ boi: () => new Response("x", { status: 500 }) });
    const { data } = await search(makeEnv());
    expect(data.meta.fxSource).toBe("open.er-api.com");
    expect(cardOf(data, "cheapest")?.offer.totalIls).toBeCloseTo(164 / 0.2778, 1);
  });

  it("a Travelpayouts window that needs many requests is truncated and says so", async () => {
    const up = stubUpstream();
    const { data } = await search(makeEnv(), { ...BODY, windowStart: "2026-11-10", windowEnd: "2027-02-20", stayMin: 3, stayMax: 3, nearbyAirports: true });
    expect(up.tpCalls().length).toBeLessThanOrEqual(30);
    expect(data.meta.sources[0]?.error).toMatch(/truncated/);
    expect(data.meta.sources[0]?.ok).toBe(true);
  });
});

describe("GET /api/airports", () => {
  const get = async (q: string) => {
    const res = await call(makeEnv(), `/api/airports${q}`);
    return { res, data: (await res.json()) as { results: { code: string; nameHe: string | null; nameEn: string; airports: string[]; kind: string }[] } };
  };

  it("autocompletes Hebrew and English", async () => {
    expect((await get("?q=תל")).data.results.map((r) => r.code)).toContain("TLV");
    const he = await get("?q=" + encodeURIComponent("ברצלונה"));
    expect(he.data.results[0]).toMatchObject({ code: "BCN", nameHe: "ברצלונה" });
    const en = await get("?q=barcelona");
    expect(en.data.results[0]?.code).toBe("BCN");
    expect((await get("?q=LHR")).data.results[0]).toMatchObject({ code: "LON", kind: "airport" });
  });

  it("respects limit and survives garbage", async () => {
    expect((await get("?q=a&limit=2")).data.results.length).toBeLessThanOrEqual(2);
    expect((await get("?q=a&limit=999")).data.results.length).toBeLessThanOrEqual(10);
    expect((await get("?q=a&limit=abc")).data.results.length).toBeLessThanOrEqual(8);
    for (const q of ["", "?q=", "?q=" + "x".repeat(500), "?q=" + encodeURIComponent("(.*)[\\"), "?q=%00%01"]) {
      const { res, data } = await get(q);
      expect(res.status).toBe(200);
      expect(data.results).toEqual([]);
    }
  });
});

describe("GET /api/health", () => {
  it("checks D1", async () => {
    const res = await call(makeEnv(), "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("503 without details when D1 is down", async () => {
    const env = makeEnv({ DB: { prepare: () => ({ first: async () => { throw new Error("SECRET-DETAIL"); } }) } as unknown as D1Database });
    const res = await call(env, "/api/health");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET-DETAIL");
  });
});

describe("routing and response hygiene", () => {
  it("404 for unknown paths, 405 (with Allow) for the wrong method, trailing slash tolerated", async () => {
    const env = makeEnv();
    expect((await call(env, "/")).status).toBe(404);
    expect((await call(env, "/api/nope")).status).toBe(404);
    expect((await call(env, "/api")).status).toBe(404);
    const get = await call(env, "/api/search");
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toContain("POST");
    expect((await call(env, "/api/health", { method: "POST" })).status).toBe(405);
    expect((await call(env, "/api/health/")).status).toBe(200);
    expect((await call(env, "/api/airports/?q=tel")).status).toBe(200);
  });

  it("every response is no-store, nosniff, JSON, and errors follow { error: { code, message } }", async () => {
    stubUpstream();
    const env = makeEnv();
    const responses = [
      await post(env, BODY),
      await post(env, {}),
      await post(env, "{"),
      await call(env, "/nope"),
      await call(env, "/api/search"),
      await call(env, "/api/health"),
      await call(env, "/api/airports?q=tel"),
      await post(env, { ...BODY, pad: "x".repeat(MAX_BODY_BYTES) }),
      await call(env, "/api/search", { method: "OPTIONS" }),
    ];
    for (const res of responses) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      if (res.status !== 204) expect(res.headers.get("content-type")).toContain("application/json");
      if (res.status >= 400) {
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toMatch(/^[a-z_]+$/);
        expect(typeof body.error.message).toBe("string");
      }
    }
  });

  it("an unexpected exception becomes a bare 500 with no message or stack", async () => {
    const boom = { get url(): string { throw new Error("SECRET-DETAIL at /srv/app.ts:1"); }, method: "GET", headers: new Headers() } as unknown as Request;
    const res = await call(makeEnv(), "", {}, boom);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("parseSearchBody", () => {
  const deps = { resolver: defaultResolver, now: NOW };
  const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const ok = (patch: Record<string, unknown> = {}) => {
    const r = parseSearchBody({ ...BODY, ...patch }, deps);
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.fields)}`);
    return r.req;
  };
  const fields = (patch: Record<string, unknown> | unknown) => {
    const r = parseSearchBody(patch && typeof patch === "object" && !Array.isArray(patch) ? { ...BODY, ...patch } : patch, deps);
    return r.ok ? null : r.fields;
  };

  it("fills SPEC §4.1 defaults for everything the user left out", () => {
    expect(ok()).toEqual({
      origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7,
      adults: 1, children: 0, infants: 0, cabin: "economy", checkedBag: false,
      outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
    });
  });

  it("treats null like absent for optional fields", () => {
    const r = ok({ adults: null, children: null, cabin: null, checkedBag: null, outHours: null, retHours: null, maxStops: null, nearbyAirports: null });
    expect(r).toMatchObject({ adults: 1, cabin: "economy", checkedBag: false, outHours: null, maxStops: null, nearbyAirports: false });
  });

  it("accepts every documented value at its boundary", () => {
    expect(ok({ windowStart: day(0), windowEnd: day(MAX_WINDOW_DAYS), stayMin: 5, stayMax: 7 }).windowStart).toBe(day(0)); // today is allowed
    expect(ok({ windowStart: day(MAX_ADVANCE_DAYS), windowEnd: day(MAX_ADVANCE_DAYS + 20) })).toBeTruthy();
    expect(ok({ stayMin: MAX_STAY_NIGHTS, stayMax: MAX_STAY_NIGHTS, windowStart: day(1), windowEnd: day(40) })).toBeTruthy();
    expect(ok({ adults: 5, children: 3, infants: 1 })).toMatchObject({ adults: 5, children: 3, infants: 1 });
    expect(ok({ adults: MAX_PASSENGERS }).adults).toBe(9);
    expect(ok({ adults: 2, infants: 2 }).infants).toBe(2);
    expect(ok({ outHours: [0, 24], retHours: [22, 6], maxStops: 0 })).toMatchObject({ outHours: [0, 24], retHours: [22, 6], maxStops: 0 });
    expect(ok({ cabin: "economy", checkedBag: true, nearbyAirports: true })).toMatchObject({ cabin: "economy", checkedBag: true, nearbyAirports: true });
  });

  it("rejects one step past each boundary", () => {
    expect(fields({ windowStart: day(-1), windowEnd: day(20) })).toHaveProperty("windowStart");
    expect(fields({ windowStart: day(0), windowEnd: day(MAX_WINDOW_DAYS + 1) })).toHaveProperty("windowEnd");
    expect(fields({ windowStart: day(MAX_ADVANCE_DAYS + 1), windowEnd: day(MAX_ADVANCE_DAYS + 20) })).toHaveProperty("windowStart");
    expect(fields({ stayMax: MAX_STAY_NIGHTS + 1 })).toHaveProperty("stayMax");
    expect(fields({ stayMin: 0 })).toHaveProperty("stayMin");
    expect(fields({ adults: MAX_PASSENGERS, children: 1 })).toHaveProperty("adults");
    expect(fields({ adults: 2, infants: 3 })).toHaveProperty("infants");
    expect(fields({ outHours: [0, 25] })).toHaveProperty("outHours");
    expect(fields({ maxStops: 6 })).toHaveProperty("maxStops");
  });

  it("bounds the number of valid date pairs", () => {
    // 121-day-wide windows are refused elsewhere; here 60 days x stays of 3..10 nights = 436 pairs
    expect(MAX_VALID_PAIRS).toBe(400);
    expect(fields({ windowStart: "2026-11-10", windowEnd: "2027-01-09", stayMin: 3, stayMax: 10 })).toHaveProperty("windowEnd");
    expect(ok({ windowStart: "2026-11-10", windowEnd: "2027-03-09", stayMin: 5, stayMax: 7 })).toBeTruthy(); // 119 days, 3 stays: 345 pairs
  });

  it("is strict about types: no coercion, NaN, Infinity or huge numbers", () => {
    for (const bad of ["2", "", true, [], {}, NaN, Infinity, -Infinity, 1e21, 2.5, -1]) {
      expect(fields({ adults: bad }), JSON.stringify(bad)).toHaveProperty("adults");
    }
    for (const bad of ["x", 5, [], {}, true]) expect(fields({ windowStart: bad })).toHaveProperty("windowStart");
    for (const bad of [1, "yes", [], {}]) expect(fields({ checkedBag: bad })).toHaveProperty("checkedBag");
    for (const bad of [null, "9", [1], [1, 2, 3], {}, [NaN, 3], [1, Infinity], [1.5, 4], [true, false]]) {
      if (bad === null) continue; // null means "no restriction"
      expect(fields({ outHours: bad }), JSON.stringify(bad)).toHaveProperty("outHours");
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, 7, "x", [], [BODY], true]) expect(fields(body)).toEqual({ body: "must be a JSON object" });
  });

  it("ignores inherited and unknown keys", () => {
    const polluted = JSON.parse('{"__proto__":{"adults":5},"constructor":{"adults":5},"unknown":1}') as Record<string, unknown>;
    expect(parseSearchBody({ ...BODY, ...polluted }, deps)).toMatchObject({ ok: true, req: { adults: 1 } });
    const proto = Object.create({ adults: 6 }) as Record<string, unknown>;
    Object.assign(proto, BODY);
    expect(parseSearchBody(proto, deps)).toMatchObject({ ok: true, req: { adults: 1 } });
  });

  it("resolves places through the airports resolver: cities expand later, airports stay airports", () => {
    expect(ok({ origin: "לונדון", destination: "פריז" })).toMatchObject({ origin: "LON", destination: "PAR" });
    expect(ok({ origin: "LHR", destination: "CDG" })).toMatchObject({ origin: "LHR", destination: "CDG" });
    expect(ok({ origin: " tel aviv ", destination: "BARCELONA" })).toMatchObject({ origin: "TLV", destination: "BCN" });
    expect(fields({ origin: "LHR", destination: "London" })).toHaveProperty("destination"); // same city
    expect(fields({ origin: "x".repeat(65) })).toHaveProperty("origin");
  });

  it("refuses a cabin no fare source can price, instead of showing economy fares under that label", () => {
    for (const cabin of ["premium-economy", "business", "first"]) {
      expect(fields({ cabin }), cabin).toEqual({ cabin: "only economy fares are available at the moment" });
    }
    expect(fields({ cabin: "luxury" })?.cabin).toMatch(/^must be one of/);
    expect(ok({ cabin: "economy" }).cabin).toBe("economy");
  });

  it("never turns an unknown place into a different one: no fuzzy (prefix, word or substring) hits on submit", () => {
    // Each of these used to validate and silently search another city.
    for (const place of ["פולין", "יוון", "צרפת", "Siem Reap", "National", "Barcelo", "Tel Avi", "Punta"]) {
      expect(fields({ destination: place }), place).toHaveProperty("destination");
    }
  });

  it("a well-formed 3-letter code the dataset does not know is passed through as an airport (SPEC §4.3: any airport)", () => {
    for (const code of ["VGO", "ANR", "REP", "ETH", "MED", "NAT", "ANU"]) {
      expect(ok({ destination: code }).destination, code).toBe(code);
      expect(ok({ destination: code.toLowerCase() }).destination, code.toLowerCase()).toBe(code);
    }
    expect(ok({ origin: "fmm" }).origin).toBe("FMM");
    expect(ok({ origin: " Nrn " }).origin).toBe("NRN");
    // ...but anything that is not code-shaped is still refused
    for (const bad of ["TL", "TLVX", "T1V", "T V"]) expect(fields({ origin: bad }), bad).toHaveProperty("origin");
  });

  it("an all-caps triple is a code and nothing else: it never falls back to a city with that name", () => {
    expect(ok({ destination: "KOS" }).destination).toBe("KOS"); // Kos the island is KGS
    expect(ok({ destination: "Kos" }).destination).toBe("KGS");
    expect(ok({ destination: "GOA" }).destination).toBe("GOA"); // Genoa's code
    expect(ok({ destination: "Goa" }).destination).toBe("GOI"); // the city of Goa
    expect(ok({ destination: "goa" }).destination).toBe("GOI");
    expect(ok({ destination: "גואה" }).destination).toBe("GOI");
  });

  it("accepts the everyday ways to name an airport or a city, with or without the words around it", () => {
    for (const [text, code] of [
      ["Ben Gurion Airport", "TLV"], ["נתב\"ג", "TLV"], ["נמל התעופה בן גוריון", "TLV"], ["Tel Aviv, Israel", "TLV"], ["Tel Aviv-Jaffa", "TLV"],
      ["Heathrow", "LHR"], ["Heathrow Airport", "LHR"], ["London Heathrow Airport", "LHR"], ["הית'רו", "LHR"],
      ["אורלי", "ORY"], ["Orly", "ORY"], ["Elat", "ETM"], ["Eilat Ramon Airport", "ETM"], ["TLV airport", "TLV"], ["JFK Airport", "JFK"],
    ] as const) {
      expect(ok({ origin: "BCN", destination: text }).destination, text).toBe(code);
    }
  });

  it("reports the empty destination with its own code", () => {
    const r = parseSearchBody({ ...BODY, destination: "" }, deps);
    expect(r).toMatchObject({ ok: false, code: "destination_required" });
    expect(parseSearchBody({ ...BODY, adults: 0 }, deps)).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("uses the UTC calendar for 'today'", () => {
    const lateUtc = { resolver: defaultResolver, now: new Date("2026-10-01T23:59:59.999Z") };
    expect(parseSearchBody({ ...BODY, windowStart: "2026-10-01", windowEnd: "2026-10-20" }, lateUtc).ok).toBe(true);
    expect(parseSearchBody({ ...BODY, windowStart: "2026-09-30", windowEnd: "2026-10-20" }, lateUtc).ok).toBe(false);
  });
});
