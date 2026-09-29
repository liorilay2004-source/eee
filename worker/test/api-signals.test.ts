/**
 * Machine-readable API signals (WEB_APP_SPEC §7.5, §7.8 Δ2 / Δ21): `error.reason` and `retryAfterSec` on a 503,
 * `error.fieldCodes` beside `error.fields` on a 400, and `truncated` / `coverage` / `reason` on the Travelpayouts
 * entry of `meta.sources`. Every one is additive: the English strings the API returned before are asserted unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import * as entry from "../src/index";
import { createRepo } from "../src/db";
import { coverageFromNotes, defaultResolver, MAX_TP_REQUESTS, PipelineError, runSearch, type SearchDeps } from "../src/pipeline";
import { monthsBetween } from "../src/travelpayouts";
import { GLOBAL_SCAN_LIMIT, GLOBAL_SCAN_WINDOW_SECONDS, parseSearchBody, type FieldErrorCode } from "../src/validate";
import type { Env, FxRates, Offer, SearchRequest, SearchResponse, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const TOKEN = "tp-SECRET-token-0123456789abcdef";
const BODY = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };
const FX: FxRates = { date: "2026-10-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface ErrorBody {
  error: { code: string; message: string; reason?: string; fields?: Record<string, string>; fieldCodes?: Record<string, string>; retryAfterSec?: number };
}

function stubUpstream(tp?: (url: URL) => Response) {
  const tpCalls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.travelpayouts.com") {
        tpCalls.push(url);
        if (tp) return tp(url);
        if (url.searchParams.get("one_way") === "true") {
          const body = structuredClone(onewayFixture) as { data: { origin: string }[] };
          body.data = body.data.filter((d) => d.origin === url.searchParams.get("origin"));
          return json(body);
        }
        return json(roundtripFixture);
      }
      if (url.hostname === "boi.org.il") return json({ exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }, { key: "EUR", currentExchangeRate: 3.9, unit: 1 }] });
      if (url.hostname === "open.er-api.com") return json({ result: "success", rates: { USD: 0.2778, EUR: 0.2564 } });
      throw new Error(`unexpected outbound call to ${url.hostname}`);
    }),
  );
  return { tpCalls };
}

const makeEnv = (over: Partial<Env> = {}): Env => ({ DB: createTestD1(), TRAVELPAYOUTS_TOKEN: TOKEN, TRAVELPAYOUTS_MARKER: "12345", ...over });

async function post(env: Env, body: unknown, ip = "203.0.113.7", origin?: string): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const headers: Record<string, string> = { "content-type": "application/json", "CF-Connecting-IP": ip, ...(origin ? { Origin: origin } : {}) };
  const res = await worker.fetch(new Request("https://api.example.test/api/search", { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
  await Promise.all(pending);
  return res;
}

const spendBudget = async (env: Env) => {
  const windowStart = Math.floor(NOW.getTime() / 1000 / GLOBAL_SCAN_WINDOW_SECONDS) * GLOBAL_SCAN_WINDOW_SECONDS;
  await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('global:scan', ?, ?)").bind(windowStart, GLOBAL_SCAN_LIMIT).run();
};

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

// --- 400: fieldCodes ------------------------------------------------------------------------------------

describe("error.fieldCodes (400)", () => {
  const deps = { resolver: defaultResolver, now: NOW };
  const codesOf = (patch: unknown) => {
    const r = parseSearchBody(patch && typeof patch === "object" && !Array.isArray(patch) ? { ...BODY, ...patch } : patch, deps);
    if (r.ok) throw new Error("expected a validation failure");
    return r;
  };

  it.each<[string, unknown, string, FieldErrorCode]>([
    ["missing origin", { origin: undefined }, "origin", "required"],
    ["blank origin", { origin: "  " }, "origin", "required"],
    ["numeric origin", { origin: 7 }, "origin", "invalid_format"],
    ["unknown place", { destination: "Atlantis Lost City" }, "destination", "place_not_found"],
    ["place text too long", { destination: "x".repeat(65) }, "destination", "invalid_format"],
    ["same city", { origin: "TLV", destination: "תל אביב" }, "destination", "same_place"],
    ["missing destination", { destination: "" }, "destination", "required"],
    ["missing windowStart", { windowStart: null }, "windowStart", "required"],
    ["past window start", { windowStart: "2026-09-30" }, "windowStart", "past_date"],
    ["start beyond a year", { windowStart: "2027-10-10", windowEnd: "2027-10-20" }, "windowStart", "out_of_range"],
    ["impossible date", { windowStart: "2026-02-30" }, "windowStart", "invalid_format"],
    ["wrong date format", { windowStart: "10/11/2026" }, "windowStart", "invalid_format"],
    ["window end before start", { windowEnd: "2026-11-09" }, "windowEnd", "start_after_end"],
    ["window over 120 days", { windowStart: "2026-11-10", windowEnd: "2027-03-11" }, "windowEnd", "window_too_long"],
    ["too many date combinations", { windowStart: "2026-11-10", windowEnd: "2027-01-09", stayMin: 3, stayMax: 10 }, "windowEnd", "too_many_pairs"],
    ["missing stayMin", { stayMin: undefined }, "stayMin", "required"],
    ["stay as string", { stayMin: "5" }, "stayMin", "invalid_format"],
    ["stay over 30 nights", { stayMax: 31 }, "stayMax", "out_of_range"],
    ["stayMin above stayMax", { stayMin: 8, stayMax: 7 }, "stayMax", "stay_range_invalid"],
    ["no trip fits the window", { windowEnd: "2026-11-12", stayMin: 5, stayMax: 7 }, "stayMin", "stay_too_long"],
    ["ten passengers", { adults: 9, children: 1 }, "adults", "too_many_passengers"],
    ["zero adults", { adults: 0 }, "adults", "out_of_range"],
    ["infants above adults", { adults: 1, infants: 2 }, "infants", "infants_exceed_adults"],
    ["unknown cabin", { cabin: "luxury" }, "cabin", "invalid_format"],
    ["business cabin", { cabin: "business" }, "cabin", "not_supported"],
    ["bag as string", { checkedBag: "true" }, "checkedBag", "invalid_format"],
    ["nearby as number", { nearbyAirports: 1 }, "nearbyAirports", "invalid_format"],
    ["hours of the wrong length", { outHours: [6] }, "outHours", "invalid_format"],
    ["hours as strings", { outHours: ["6", "9"] }, "outHours", "invalid_format"],
    ["hour 25", { outHours: [0, 25] }, "outHours", "out_of_range"],
    ["empty hour window", { retHours: [6, 6] }, "retHours", "hours_invalid"],
    ["max stops as string", { maxStops: "1" }, "maxStops", "invalid_format"],
    ["max stops 6", { maxStops: 6 }, "maxStops", "out_of_range"],
  ])("%s -> %s: %s", (_name, patch, field, code) => {
    const r = codesOf(patch);
    expect(r.fieldCodes[field]).toBe(code);
    expect(typeof r.fields[field]).toBe("string"); // the English sentence is still there
  });

  it("a non-object body is keyed 'body', like fields", () => {
    for (const bad of [null, [], "x", 5]) {
      const r = parseSearchBody(bad, deps);
      expect(r.ok ? null : r.fieldCodes).toEqual({ body: "invalid_format" });
      expect(r.ok ? null : Object.keys(r.fields)).toEqual(["body"]);
    }
  });

  it("fieldCodes always has exactly the keys of fields, including many errors at once", () => {
    const patches: unknown[] = [
      { windowStart: "2026-09-30", stayMin: 9, stayMax: 3, adults: "2", outHours: [25, 3] },
      { origin: 7, destination: undefined, windowStart: "x", windowEnd: "y", stayMin: -1, stayMax: "z", adults: 10, children: -1, infants: 1.5, cabin: 1, checkedBag: 0, outHours: {}, retHours: [1, 2, 3], maxStops: "x", nearbyAirports: "no" },
      { origin: undefined, destination: undefined, windowStart: undefined, windowEnd: undefined, stayMin: undefined, stayMax: undefined },
      { adults: 5, children: 5 },
      { adults: 2, infants: 3, cabin: "first" },
    ];
    for (const p of patches) {
      const r = codesOf(p);
      expect(Object.keys(r.fieldCodes).sort()).toEqual(Object.keys(r.fields).sort());
      expect(Object.keys(r.fieldCodes).length).toBeGreaterThan(0);
    }
  });

  it("the HTTP 400 carries fieldCodes next to the unchanged fields, also for destination_required", async () => {
    const up = stubUpstream();
    const res = await post(makeEnv(), { ...BODY, destination: "", adults: 0, outHours: [6, 6] });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as ErrorBody;
    expect(error.code).toBe("destination_required");
    expect(error.fields).toEqual({ destination: "is required", adults: "must be between 1 and 9", outHours: "start and end hour must differ" });
    expect(error.fieldCodes).toEqual({ destination: "required", adults: "out_of_range", outHours: "hours_invalid" });
    expect(error.reason).toBeUndefined();
    expect(up.tpCalls).toHaveLength(0);
  });

  it("errors other than validation carry no fieldCodes", async () => {
    stubUpstream();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    const res = await worker.fetch(
      new Request("https://api.example.test/api/search", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: "{oops" }),
      makeEnv(),
      ctx,
    );
    await Promise.all(pending);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
  });
});

// --- 503: reason + retryAfterSec ------------------------------------------------------------------------

describe("error.reason and retryAfterSec (503 source_unavailable)", () => {
  it("no token: reason no_token, no retryAfterSec and no Retry-After (the wait is unknown)", async () => {
    const up = stubUpstream();
    const res = await post(makeEnv({ TRAVELPAYOUTS_TOKEN: undefined }), BODY);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body).toEqual({ error: { code: "source_unavailable", message: "No fare source is available right now", reason: "no_token" } });
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(up.tpCalls).toHaveLength(0);
  });

  it("upstream failing: reason upstream_down, no retryAfterSec", async () => {
    stubUpstream(() => new Response("down", { status: 500 }));
    const res = await post(makeEnv(), BODY);
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as ErrorBody;
    expect(error).toMatchObject({ code: "source_unavailable", reason: "upstream_down" });
    expect(error.retryAfterSec).toBeUndefined();
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("global scan budget spent: reason scan_budget with the limiter's wait, in the body and in an exposed Retry-After", async () => {
    const up = stubUpstream();
    const env = makeEnv({ ALLOWED_ORIGIN: "https://app.example.test" });
    await spendBudget(env);
    const res = await post(env, BODY, "203.0.113.7", "https://app.example.test");
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as ErrorBody;
    expect(error).toMatchObject({ code: "source_unavailable", message: "No fare source is available right now", reason: "scan_budget" });
    expect(Number.isInteger(error.retryAfterSec)).toBe(true);
    expect(error.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(error.retryAfterSec).toBeLessThanOrEqual(2 * GLOBAL_SCAN_WINDOW_SECONDS);
    expect(res.headers.get("Retry-After")).toBe(String(error.retryAfterSec));
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(up.tpCalls).toHaveLength(0);
  });

  it("fx_unavailable carries neither reason nor retryAfterSec", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "api.travelpayouts.com") return json(roundtripFixture);
        return new Response("x", { status: 500 });
      }),
    );
    const res = await post(makeEnv(), BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "fx_unavailable", message: "Exchange rates are unavailable" } });
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("the 429 keeps its retryAfterSec and gains no reason", async () => {
    stubUpstream();
    const env = makeEnv();
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await post(env, { ...BODY, destination: "" }, "198.51.100.3");
    expect(last?.status).toBe(429);
    const { error } = (await last!.json()) as ErrorBody;
    expect(error.reason).toBeUndefined();
    expect(error.retryAfterSec).toBe(Number(last!.headers.get("Retry-After")));
  });
});

// --- pipeline: SourceStatus.truncated / coverage / reason ------------------------------------------------

function offer(price: number, over: Partial<Offer> = {}): Offer {
  const leg = { departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"] };
  return {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: price, priceCurrency: "USD",
    source: "travelpayouts", ticketStructure: "roundtrip", outbound: leg, inbound: { ...leg, departTime: "18:00" }, includes: {},
    deeplink: "https://www.aviasales.com/search/TLV1211BCN1811?marker=m", verifyLink: null, checkedAt: NOW.toISOString(),
    extrasAmountIls: 0, totalIls: null, tags: [], ...over,
  };
}

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7, adults: 1, children: 0, infants: 0,
    cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false, ...over,
  };
}

function mockTp(opts: { configured?: boolean; rt?: (o: string, d: string) => Offer[]; fail?: boolean } = {}): TravelpayoutsClient {
  let calls = 0;
  return {
    configured: opts.configured ?? true,
    callCount: () => calls,
    async roundTrips(o, d, ws, we) {
      const k = monthsBetween(ws, we).length;
      calls += (k * (k + 1)) / 2;
      if (opts.fail) throw new Error("boom");
      return (opts.rt?.(o, d) ?? []).map((x) => structuredClone(x));
    },
    async oneWays(_o, _d, ws, we) {
      calls += monthsBetween(ws, we).length;
      if (opts.fail) throw new Error("boom");
      return [];
    },
  };
}

function setup(over: Partial<SearchDeps> = {}) {
  const repo = createRepo(createTestD1());
  const deps: SearchDeps = { repo, tp: mockTp(), fx: FX, now: NOW, ...over };
  return { repo, deps };
}

const only = (o: string, d: string) => (o === "TLV" && d === "BCN" ? [offer(164)] : []);

describe("meta.sources[travelpayouts]: truncated, coverage, reason", () => {
  it("a complete fresh scan: truncated false, coverage with 0 skipped, reason null", async () => {
    const { deps } = setup({ tp: mockTp({ rt: only }) });
    const res = await runSearch(deps, req());
    const tp = res.meta.sources[0];
    expect(tp).toMatchObject({ name: "travelpayouts", ok: true, error: null, truncated: false, reason: null });
    expect(tp?.coverage).toEqual({ plannedRequests: 3, skippedRequests: 0 }); // Nov only: 1 rt + 2 ow
  });

  it("a truncated scan: truncated true with the counts, and the English note is unchanged", async () => {
    const { deps } = setup({ tp: mockTp({ rt: (o, d) => (o === "LHR" && d === "CDG" ? [offer(100, { origin: "LHR", destination: "CDG" })] : []) }) });
    const res = await runSearch(deps, req({ origin: "LON", destination: "PAR", windowEnd: "2027-01-05" }));
    const tp = res.meta.sources[0];
    expect(tp?.truncated).toBe(true);
    expect(tp?.coverage?.skippedRequests).toBeGreaterThan(0);
    expect(tp!.coverage!.plannedRequests - tp!.coverage!.skippedRequests).toBeLessThanOrEqual(MAX_TP_REQUESTS);
    expect(tp?.error).toContain(`truncated: ${tp?.coverage?.skippedRequests} of ${tp?.coverage?.plannedRequests} planned requests skipped (limit ${MAX_TP_REQUESTS})`);
    expect(tp?.ok).toBe(true);
    expect(tp?.reason).toBeNull();
  });

  it("a cache hit of a truncated scan still says truncated, with the same counts", async () => {
    const { deps } = setup({ tp: mockTp({ rt: (o, d) => (o === "LHR" && d === "CDG" ? [offer(100, { origin: "LHR", destination: "CDG" })] : []) }) });
    const wide = req({ origin: "LON", destination: "PAR", windowEnd: "2027-01-05" });
    const first = await runSearch(deps, wide);
    const second = await runSearch(deps, wide);
    expect(second.meta.fromCache).toBe(true);
    expect(second.meta.sources[0]?.truncated).toBe(true);
    expect(second.meta.sources[0]?.coverage).toEqual(first.meta.sources[0]?.coverage);
  });

  it("a cache hit of a complete scan: truncated false, coverage null (the counts are not stored)", async () => {
    const { deps } = setup({ tp: mockTp({ rt: only }) });
    await runSearch(deps, req());
    const hit = await runSearch(deps, req());
    expect(hit.meta.fromCache).toBe(true);
    expect(hit.meta.sources[0]).toMatchObject({ truncated: false, coverage: null, reason: null });
  });

  it("scan budget spent but stored fares: 200 Partial with reason scan_budget and the unchanged text", async () => {
    const { repo, deps } = setup({ tp: mockTp({ rt: only }), scanBudget: async () => ({ allowed: false, retryAfterSec: 42 }) });
    await repo.savePrices([offer(100, { checkedAt: new Date(NOW.getTime() - 3_600_000).toISOString() })]);
    const res = await runSearch(deps, req());
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.meta.sources[0]).toMatchObject({ ok: false, error: "Travelpayouts: too many searches right now", reason: "scan_budget", truncated: false, coverage: null });
  });

  it("upstream failing but stored fares: reason upstream_down", async () => {
    const { repo, deps } = setup({ tp: mockTp({ fail: true }) });
    await repo.savePrices([offer(100, { checkedAt: new Date(NOW.getTime() - 3_600_000).toISOString() })]);
    const res = await runSearch(deps, req());
    expect(res.meta.sources[0]).toMatchObject({ ok: false, reason: "upstream_down" });
  });

  it("the quote-source and google_flights entries are unchanged (no new keys)", async () => {
    const { deps } = setup({ tp: mockTp({ rt: only }) });
    const res = await runSearch(deps, req());
    expect(Object.keys(res.meta.sources[1] ?? {}).sort()).toEqual(["calls", "enabled", "error", "name", "offers", "ok"]);
  });
});

describe("PipelineError reason and retryAfterSec", () => {
  it.each<[string, Partial<SearchDeps>, string, number | undefined]>([
    ["unconfigured", { tp: mockTp({ configured: false }) }, "no_token", undefined],
    ["failing", { tp: mockTp({ fail: true }) }, "upstream_down", undefined],
    ["budget (boolean verdict)", { scanBudget: async () => false }, "scan_budget", undefined],
    ["budget (verdict with wait)", { scanBudget: async () => ({ allowed: false, retryAfterSec: 37.2 }) }, "scan_budget", 38],
    ["budget (verdict, wait 0)", { scanBudget: async () => ({ allowed: false, retryAfterSec: 0 }) }, "scan_budget", undefined],
    ["budget (verdict, NaN wait)", { scanBudget: async () => ({ allowed: false, retryAfterSec: Number.NaN }) }, "scan_budget", undefined],
  ])("%s -> %s", async (_name, over, reason, wait) => {
    const { deps } = setup(over);
    const err = await runSearch(deps, req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err).toMatchObject({ code: "source_unavailable", reason });
    expect((err as PipelineError).retryAfterSec).toBe(wait);
  });

  it("an allowed verdict object scans normally", async () => {
    const { deps } = setup({ tp: mockTp({ rt: only }), scanBudget: async () => ({ allowed: true, retryAfterSec: 0 }) });
    const res = await runSearch(deps, req());
    expect(res.meta.sources[0]).toMatchObject({ ok: true, reason: null });
  });

  it("the unconfigured source does not ask the budget", async () => {
    const scanBudget = vi.fn(async () => ({ allowed: false, retryAfterSec: 10 }));
    const { deps } = setup({ tp: mockTp({ configured: false }), scanBudget });
    await expect(runSearch(deps, req())).rejects.toMatchObject({ reason: "no_token" });
    expect(scanBudget).not.toHaveBeenCalled();
  });
});

describe("coverageFromNotes", () => {
  it("reads the pipeline's own truncation note and ignores anything else", () => {
    expect(coverageFromNotes(["not searchable at Travelpayouts: VDA-BCN", "truncated: 6 of 36 planned requests skipped (limit 30)"])).toEqual({ skippedRequests: 6, plannedRequests: 36 });
    expect(coverageFromNotes([])).toBeNull();
    expect(coverageFromNotes(undefined)).toBeNull();
    expect(coverageFromNotes(["Travelpayouts: HTTP 500", 5 as unknown as string])).toBeNull();
  });
});
