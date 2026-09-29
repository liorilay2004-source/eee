/**
 * Optional live fare sources, the core (src/quotes.ts + the quote phase of runSearch). No vendor adapter exists yet:
 * these tests use a stand-in adapter and a stub fetch, so nothing here ever leaves the machine.
 * Owner rule under test: nothing may cost money. Every vendor request has a reserved unit under a hard cap, the unit is
 * taken BEFORE the request, and a counter that cannot be read means no request.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { computeSearchKey, runSearch, type SearchDeps } from "../src/pipeline";
import {
  createQuoteSource,
  isQuoteSource,
  LIFETIME_CAP_MAX_PERCENT,
  MAX_QUOTE_CALLS,
  MAX_QUOTE_OFFERS_PER_CALL,
  MAX_QUOTE_PAIRS,
  MONTHLY_CAP_MAX_PERCENT,
  mergeQuoted,
  pickQuotePairs,
  QUOTE_CONCURRENCY,
  QUOTE_MAX_AGE_HOURS,
  QUOTE_SOURCE_NAMES,
  QUOTE_TIMEOUT_MS,
  quotaPeriodKey,
  quotaSpecIsSafe,
  QuoteError,
  runQuotes,
  type FareQuoteSource,
  type ParsedFare,
  type QuoteAdapter,
  type QuotaSpec,
  type QuoteQuery,
  type QuoteSourceName,
} from "../src/quotes";
import { recommend } from "../src/scoring";
import { TravelpayoutsError } from "../src/travelpayouts";
import type { FxRates, Leg, Offer, Repo, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

// The ranking pool is what "appears once" is about, and the cards only show its winners: watch it, change nothing.
vi.mock("../src/scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scoring")>();
  return { ...actual, recommend: vi.fn(actual.recommend) };
});

const NOW = new Date("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };
const Q: QuoteQuery = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", party: { adults: 1 } };

/** Safe under the margin rules for a small cap (3 of 10 monthly = 30%, 1 of 10 one-off = 10%). */
const MONTHLY_3: QuotaSpec = { period: "monthly", cap: 3, allowance: 10 };
const LIFETIME_1: QuotaSpec = { period: "lifetime", cap: 1, allowance: 10 };
const BIG: QuotaSpec = { period: "lifetime", cap: 100, allowance: 1000 };
const MONTHLY_BIG: QuotaSpec = { period: "monthly", cap: 100, allowance: 1000 };

const leg = (over: Partial<Leg> = {}): Leg => ({ departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over });

function offer(price: number, over: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: price, priceCurrency: "USD",
    source: "travelpayouts", ticketStructure: "roundtrip", outbound: leg(), inbound: leg({ departTime: "18:00" }), includes: {},
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

function mockTp(rt: Offer[]): TravelpayoutsClient {
  let calls = 0;
  return {
    configured: true,
    callCount: () => calls,
    async roundTrips(o, d) {
      calls += 1;
      return o === "TLV" && d === "BCN" ? rt.map((x) => structuredClone(x)) : [];
    },
    async oneWays() {
      calls += 1;
      return [];
    },
  };
}

const fare = (price: number, over: Partial<ParsedFare> = {}): ParsedFare => ({ price, currency: "USD", outbound: leg(), inbound: leg({ departTime: null }), ...over });

/** A stand-in vendor: `fares` decides what its (stub) answer contains for a date pair. */
function testAdapter(name: QuoteSourceName, quota: QuotaSpec, fares: (q: QuoteQuery) => ParsedFare[] = () => [fare(90)]): QuoteAdapter {
  return {
    name,
    quota,
    request: (q, key) => ({ url: `https://vendor.test/${name}?d=${q.departDate}&r=${q.returnDate}&api_key=${key}`, headers: {} }),
    parse: (_body, q) => fares(q),
  };
}

const okFetch = () => vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;
const rowsOf = async (db: D1Database, sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
const used = async (db: D1Database, source: string, period: string) =>
  (await db.prepare("SELECT used FROM source_quota WHERE source = ? AND period = ?").bind(source, period).first<number>("used")) ?? 0;
const urlsOf = (fn: ReturnType<typeof okFetch>) => fn.mock.calls.map((c) => String(c[0]));
const datesOf = (fn: ReturnType<typeof okFetch>) => urlsOf(fn).map((u) => new URL(u).searchParams.get("d"));

/** One database for the search and for the vendors' counters, like production. */
function world(tpOffers: Offer[]) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = okFetch();
  const mk = (
    name: QuoteSourceName,
    o: { quota?: QuotaSpec; fares?: (q: QuoteQuery) => ParsedFare[]; fetchFn?: unknown; key?: string; repo?: Repo } = {},
  ): FareQuoteSource =>
    createQuoteSource(testAdapter(name, o.quota ?? MONTHLY_BIG, o.fares), { key: o.key ?? "k", repo: o.repo ?? repo, now: NOW, fetchFn: asFetch(o.fetchFn ?? fetchFn) });
  const run = (sources: FareQuoteSource[] | undefined, r: SearchRequest = req(), over: Partial<SearchDeps> = {}) =>
    runSearch({ repo, tp: mockTp(tpOffers), fx: vi.fn(async () => FX), now: NOW, ...(sources ? { quoteSources: sources } : {}), ...over }, r);
  return { db, repo, fetchFn, mk, run };
}

/** n date pairs (stay 6 days), each cheaper than the next. */
const pairsOf = (n: number) => Array.from({ length: n }, (_, i) => offer(100 + i * 10, { departDate: `2026-11-${10 + i}`, returnDate: `2026-11-${16 + i}` }));

/** A stand-in that never touches a vendor, for the tests of the phase itself. */
function fakeSource(name: QuoteSourceName, quote: (q: QuoteQuery) => Promise<Offer[]>, over: Partial<FareQuoteSource> = {}): FareQuoteSource & { asked: QuoteQuery[] } {
  const asked: QuoteQuery[] = [];
  return { name, configured: true, quota: MONTHLY_3, callCount: () => asked.length, quote: async (q) => (asked.push(q), quote(q)), asked, ...over };
}

// ---------------------------------------------------------------------------------------------------------

describe("quota rules a vendor spec must keep", () => {
  it("a cap is safe only when it is a whole number of at least 1 within 90% (one-off) or 45% (monthly) of the allowance", () => {
    expect([LIFETIME_CAP_MAX_PERCENT, MONTHLY_CAP_MAX_PERCENT]).toEqual([90, 45]);
    const spec = (period: QuotaSpec["period"], cap: number, allowance: number) => ({ period, cap, allowance }) as QuotaSpec;
    for (const s of [spec("lifetime", 800, 1000), spec("lifetime", 900, 1000), spec("lifetime", 50, 100), spec("monthly", 100, 250), spec("monthly", 112, 250), spec("monthly", 1, 3)]) {
      expect(quotaSpecIsSafe(s), JSON.stringify(s)).toBe(true);
    }
    for (const s of [
      spec("lifetime", 901, 1000), spec("lifetime", 1000, 1000), spec("lifetime", 2000, 1000), spec("monthly", 113, 250), spec("monthly", 250, 250), spec("monthly", 1, 1),
      spec("lifetime", 0, 1000), spec("lifetime", -5, 1000), spec("lifetime", 1.5, 1000), spec("lifetime", Number.NaN, 1000), spec("lifetime", 5, Number.NaN),
      spec("lifetime", 5, 0), spec("lifetime", 5, Number.POSITIVE_INFINITY), spec("weekly" as QuotaSpec["period"], 1, 1000),
    ]) {
      expect(quotaSpecIsSafe(s), JSON.stringify(s)).toBe(false);
    }
  });

  it("the period key is the UTC month for a monthly allowance and one fixed word for a one-off one", () => {
    expect(quotaPeriodKey("monthly", new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(quotaPeriodKey("monthly", new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
    expect(quotaPeriodKey("monthly", new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
    expect(quotaPeriodKey("lifetime", new Date("2026-09-30T23:59:59Z"))).toBe("lifetime");
    expect(quotaPeriodKey("lifetime", new Date("2031-06-01T00:00:00Z"))).toBe("lifetime");
  });

  it("the per-search limits leave room in the Free plan's 50 subrequests (Travelpayouts 30 + FX 2)", () => {
    expect(MAX_QUOTE_PAIRS).toBe(4);
    expect(MAX_QUOTE_CALLS).toBeLessThanOrEqual(12);
    expect(30 + 2 + MAX_QUOTE_CALLS).toBeLessThanOrEqual(50);
    expect(QUOTE_CONCURRENCY).toBeLessThanOrEqual(6);
    expect(QUOTE_SOURCE_NAMES.every((n) => isQuoteSource(n))).toBe(true);
    expect(isQuoteSource("travelpayouts")).toBe(false);
    expect(isQuoteSource("google_flights")).toBe(false);
  });
});

describe("createQuoteSource (the only code that calls a vendor)", () => {
  const make = (over: Partial<Parameters<typeof createQuoteSource>[1]> = {}, quota: QuotaSpec = MONTHLY_3) => {
    const db = createTestD1();
    const repo = createRepo(db);
    const fetchFn = okFetch();
    const source = createQuoteSource(testAdapter("serpapi", quota), { key: "K-SECRET-123", repo, now: NOW, fetchFn: asFetch(fetchFn), ...over });
    return { db, repo, fetchFn, source };
  };

  it("a source with configured false is never called and never counted (no key, blank key, whitespace key)", async () => {
    for (const key of [undefined, "", "   \n"]) {
      const { db, fetchFn, source } = make({ key });
      expect(source.configured).toBe(false);
      await expect(source.quote(Q)).rejects.toMatchObject({ code: "not_configured" });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(source.callCount()).toBe(0);
      expect(await rowsOf(db, "SELECT * FROM source_quota")).toEqual([]);
    }
  });

  it("a key alone is not enough: a cap outside the margin makes the source inert (the code cannot exceed an allowance)", async () => {
    for (const quota of [{ period: "lifetime", cap: 1000, allowance: 1000 }, { period: "monthly", cap: 250, allowance: 250 }, { period: "lifetime", cap: 0, allowance: 100 }] as QuotaSpec[]) {
      const { db, fetchFn, source } = make({}, quota);
      expect(source.configured).toBe(false);
      await expect(source.quote(Q)).rejects.toMatchObject({ code: "not_configured" });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await rowsOf(db, "SELECT * FROM source_quota")).toEqual([]);
    }
  });

  it("the cap that was checked is the cap that is used, even if the adapter's spec object is changed afterwards", async () => {
    const quota: QuotaSpec = { period: "lifetime", cap: 2, allowance: 10 };
    const { db, fetchFn, source } = make({}, quota);
    quota.cap = 10_000;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => source.quote(Q)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await used(db, "serpapi", "lifetime")).toBe(2);
  });

  it("reserves BEFORE the request: the counter already reads 1 when the vendor is called", async () => {
    const db = createTestD1();
    let seen = -1;
    const spy = vi.fn(async () => {
      seen = await used(db, "serpapi", "2026-11");
      return new Response("{}", { status: 200 });
    });
    const s = createQuoteSource(testAdapter("serpapi", MONTHLY_3), { key: "k", repo: createRepo(db), now: NOW, fetchFn: asFetch(spy) });
    expect(s.callCount()).toBe(0);
    await s.quote(Q);
    expect(seen).toBe(1);
    expect(s.callCount()).toBe(1);
  });

  it("a source at its cap is never called: exactly cap of 20 concurrent requests reach the vendor, the rest are refused without a request", async () => {
    const { db, fetchFn, source } = make({}, { period: "monthly", cap: 5, allowance: 20 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => source.quote(Q)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "quota_exhausted" });
    expect(await used(db, "serpapi", "2026-11")).toBe(5);
    expect(source.callCount()).toBe(5);
    // later, on an already exhausted counter, still nothing goes out
    await expect(source.quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("two instances (two searches, two isolates) share one counter through the database", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const fetchFn = okFetch();
    const mk = () => createQuoteSource(testAdapter("serpapi", MONTHLY_3), { key: "k", repo, now: NOW, fetchFn: asFetch(fetchFn) });
    const a = mk();
    const b = mk();
    const results = await Promise.allSettled([a.quote(Q), b.quote(Q), a.quote(Q), b.quote(Q), a.quote(Q), b.quote(Q)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(a.callCount() + b.callCount()).toBe(3);
  });

  it("a monthly allowance restarts in a new UTC month, a lifetime one never does", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const monthly = (now: Date) => createQuoteSource(testAdapter("serpapi", { period: "monthly", cap: 1, allowance: 10 }), { key: "k", repo, now, fetchFn: asFetch(okFetch()) });
    await monthly(new Date("2026-09-30T12:00:00Z")).quote(Q);
    await expect(monthly(new Date("2026-09-30T23:59:59Z")).quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    await expect(monthly(new Date("2026-10-01T00:00:01Z")).quote(Q)).resolves.toHaveLength(1);
    await expect(monthly(new Date("2026-10-15T00:00:00Z")).quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(await rowsOf(db, "SELECT period, used FROM source_quota ORDER BY period")).toEqual([
      { period: "2026-09", used: 1 },
      { period: "2026-10", used: 1 },
    ]);

    const life = (now: Date) => createQuoteSource(testAdapter("ignav", LIFETIME_1), { key: "k", repo, now, fetchFn: asFetch(okFetch()) });
    await life(new Date("2026-01-01T00:00:00Z")).quote(Q);
    await expect(life(new Date("2026-02-01T00:00:00Z")).quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    await expect(life(new Date("2030-06-01T00:00:00Z")).quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(await rowsOf(db, "SELECT period, used FROM source_quota WHERE source = 'ignav'")).toEqual([{ period: "lifetime", used: 1 }]);
  });

  it("fails closed: a missing table, a database error or a refused reservation means the vendor is NOT called", async () => {
    const fetchFn = okFetch();
    const noTable = createTestD1();
    await noTable.prepare("DROP TABLE source_quota").run();
    const badRepos: Array<[string, Repo]> = [
      ["missing table", createRepo(noTable)],
      ["rejecting repo", { reserveQuota: async () => { throw new Error("D1 down"); } } as unknown as Repo],
      ["throwing repo", { reserveQuota: () => { throw new Error("D1 down"); } } as unknown as Repo],
      ["refusing repo", { reserveQuota: async () => false } as unknown as Repo],
      ["odd answer", { reserveQuota: async () => 1 } as unknown as Repo],
      ["no answer", { reserveQuota: async () => undefined } as unknown as Repo],
      ["throwing D1", createRepo({ prepare: () => { throw new Error("D1_ERROR"); } } as unknown as D1Database)],
    ];
    for (const [label, repo] of badRepos) {
      const s = createQuoteSource(testAdapter("serpapi", MONTHLY_3), { key: "k", repo, now: NOW, fetchFn: asFetch(fetchFn) });
      await expect(s.quote(Q), label).rejects.toMatchObject({ code: "quota_exhausted" });
      expect(s.callCount(), label).toBe(0);
    }
    // a clock that cannot name a period is no reason to guess one
    const db = createTestD1();
    const s = createQuoteSource(testAdapter("serpapi", MONTHLY_3), { key: "k", repo: createRepo(db), now: new Date(Number.NaN), fetchFn: asFetch(fetchFn) });
    await expect(s.quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(await rowsOf(db, "SELECT * FROM source_quota")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a request that fails, times out or throws still used its unit, and is never retried", async () => {
    const { db, repo } = make();
    const failures: Array<[string, () => Response, string]> = [
      ["HTTP 500", () => new Response("nope", { status: 500 }), "http"],
      ["HTTP 429", () => new Response("slow down", { status: 429 }), "http"],
      ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }), "http"],
      ["not JSON", () => new Response("<html>", { status: 200 }), "response"],
      ["thrown TimeoutError", () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "timeout"],
      ["thrown network error", () => { throw new TypeError("network down"); }, "network"],
    ];
    for (const [label, failure, code] of failures) {
      const fetchFn = vi.fn(async () => failure());
      const s = createQuoteSource(testAdapter("serpapi", { period: "monthly", cap: 10, allowance: 50 }), { key: "k", repo, now: NOW, fetchFn: asFetch(fetchFn) });
      await expect(s.quote(Q), label).rejects.toMatchObject({ name: "QuoteError", code });
      expect(fetchFn, label).toHaveBeenCalledTimes(1); // no retry
      expect(s.callCount(), label).toBe(1);
    }
    expect(await used(db, "serpapi", "2026-11")).toBe(failures.length); // every one of them was paid for in the counter
  });

  it("a vendor that never answers is cut off at the timeout: one request, its unit spent, reported as a timeout", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(25));
    try {
      const untilAborted = <T>(signal?: AbortSignal | null) => new Promise<T>((_ok, fail) => signal?.addEventListener("abort", () => fail(signal.reason)));
      const stalls: Record<string, (init?: RequestInit) => Promise<Response>> = {
        "no headers": (init) => untilAborted<Response>(init?.signal),
        "no body": async (init) => ({ status: 200, text: () => untilAborted<string>(init?.signal) }) as unknown as Response,
      };
      for (const [label, stall] of Object.entries(stalls)) {
        const db = createTestD1();
        const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => stall(init));
        const s = createQuoteSource(testAdapter("serpapi", MONTHLY_3), { key: "k", repo: createRepo(db), now: NOW, fetchFn: asFetch(fetchFn) });
        await expect(s.quote(Q), label).rejects.toMatchObject({ code: "timeout" });
        expect(fetchFn, label).toHaveBeenCalledTimes(1);
        expect(s.callCount(), label).toBe(1);
        expect(await used(db, "serpapi", "2026-11"), label).toBe(1);
      }
      expect(spy).toHaveBeenCalledWith(QUOTE_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it("a bad query fails before a unit is spent", async () => {
    const db = createTestD1();
    const adapter: QuoteAdapter = { ...testAdapter("serpapi", MONTHLY_3), request: () => { throw new RangeError("bad"); } };
    const fetchFn = okFetch();
    const s = createQuoteSource(adapter, { key: "k", repo: createRepo(db), now: NOW, fetchFn: asFetch(fetchFn) });
    await expect(s.quote(Q)).rejects.toBeInstanceOf(RangeError);
    expect(await rowsOf(db, "SELECT * FROM source_quota")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never follows a redirect, sends a timeout signal, and keeps the key out of every error", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("upstream echoed api_key=K-SECRET-123", { status: 502 });
    });
    const { source } = make({ fetchFn: asFetch(fetchFn) });
    const err = await source.quote(Q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect(JSON.stringify({ m: (err as Error).message, s: String(err), st: (err as Error).stack ?? "" })).not.toContain("K-SECRET");
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an oversized or garbled answer and drops fares it cannot read", async () => {
    const big = make({ fetchFn: asFetch(vi.fn(async () => new Response(`{"x":"${"a".repeat(600_000)}"}`, { status: 200 }))) });
    await expect(big.source.quote(Q)).rejects.toMatchObject({ code: "response" });
    const throwing = createQuoteSource({ ...testAdapter("serpapi", MONTHLY_3), parse: () => { throw new TypeError("garbage"); } }, { key: "k", repo: createRepo(createTestD1()), now: NOW, fetchFn: asFetch(okFetch()) });
    await expect(throwing.quote(Q)).rejects.toMatchObject({ code: "response" });

    const fares = [fare(0), fare(-5), fare(Number.NaN), fare(50, { currency: "usd" }), fare(50, { currency: "US" }), fare(120), fare(120), fare(80, { outbound: leg({ departTime: "20:00" }) })];
    const s = createQuoteSource(testAdapter("serpapi", MONTHLY_3, () => fares), { key: "k", repo: createRepo(createTestD1()), now: NOW, fetchFn: asFetch(okFetch()) });
    expect((await s.quote(Q)).map((o) => o.priceAmount)).toEqual([80, 120]); // unreadable fares dropped, the duplicate collapsed, cheapest first

    const many = createQuoteSource(testAdapter("serpapi", MONTHLY_3, () => Array.from({ length: 50 }, (_, i) => fare(200 - i, { outbound: leg({ departTime: `0${i % 10}:${10 + i}` }) }))), { key: "k", repo: createRepo(createTestD1()), now: NOW, fetchFn: asFetch(okFetch()) });
    const offers = await many.quote(Q);
    expect(offers).toHaveLength(MAX_QUOTE_OFFERS_PER_CALL);
    expect(offers[0]?.priceAmount).toBe(151);
  });

  it("shapes offers like Travelpayouts round trips: per adult, original currency, raw, the exact dates asked", async () => {
    const { source } = make({ marker: "mk" });
    const [o] = await source.quote({ ...Q, party: { adults: 2, children: 1 } });
    expect(o).toMatchObject({
      origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: 90, priceCurrency: "USD",
      source: "serpapi", ticketStructure: "roundtrip", extrasAmountIls: 0, totalIls: null, tags: [], checkedAt: NOW.toISOString(), verifyLink: null,
    });
    expect(o?.deeplink).toBe("https://www.aviasales.com/search/TLV1211BCN181121?marker=mk"); // an Aviasales search for 2 adults + 1 child
  });
});

// --- the phase --------------------------------------------------------------------------------------------

describe("runQuotes", () => {
  const dates4: Array<[string, string]> = [["2026-11-10", "2026-11-16"], ["2026-11-11", "2026-11-17"], ["2026-11-12", "2026-11-18"], ["2026-11-13", "2026-11-19"]];
  const primary = { origin: "TLV", dest: "BCN" };
  const party = { adults: 1 };

  /** Real sources over one database and one stub fetch that tracks how many requests are in flight at once. */
  function rig(names: QuoteSourceName[], quota: QuotaSpec = BIG) {
    const repo = createRepo(createTestD1());
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async (_u: unknown, _init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response("{}", { status: 200 });
    });
    const sources = names.map((n) => createQuoteSource(testAdapter(n, quota), { key: "k", repo, now: NOW, fetchFn: asFetch(fetchFn) }));
    return { repo, fetchFn, sources, peak: () => peak };
  }

  it("asks at most MAX_QUOTE_PAIRS pairs and issues at most MAX_QUOTE_CALLS requests, however many vendors and pairs there are", async () => {
    const r = rig(["ignav", "searchapi", "serpapi", "wego"]);
    const nine: Array<[string, string]> = Array.from({ length: 9 }, (_, i) => [`2026-11-${10 + i}`, `2026-11-${16 + i}`]);
    const { stats } = await runQuotes(r.sources, primary, nine, party);
    expect(r.fetchFn).toHaveBeenCalledTimes(MAX_QUOTE_CALLS);
    expect(r.peak()).toBeLessThanOrEqual(QUOTE_CONCURRENCY);
    expect([...stats.values()].reduce((n, s) => n + s.calls, 0)).toBe(MAX_QUOTE_CALLS);
    // pair-major order: the three cheapest pairs keep every vendor, the fourth is what the limit cuts
    expect([...new Set(datesOf(r.fetchFn))].sort()).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    for (const s of stats.values()) expect(s.notes).toEqual([`1 request(s) skipped (limit ${MAX_QUOTE_CALLS} per search)`]);
  });

  it("counts requests on the wire, not calls of quote(): a vendor that needs several requests per quote takes that many of the slots", async () => {
    const r = rig(["ignav", "searchapi", "serpapi"]);
    let quotes = 0;
    // stands in for Wego: five requests for the first pair asked (taken synchronously, like Wego does), nothing for the others
    const multi = fakeSource("wego", async () => {
      if (quotes++ > 0) return [];
      for (let i = 0; i < 5; i++) await r.fetchFn("https://vendor.test/wego");
      return [];
    }, { nextQuoteRequests: () => (quotes < 1 ? 5 : 0), callCount: () => r.fetchFn.mock.calls.filter((c) => String(c[0]).includes("/wego")).length });
    const { stats } = await runQuotes([r.sources[0] as FareQuoteSource, multi, r.sources[1] as FareQuoteSource, r.sources[2] as FareQuoteSource], primary, dates4, party);
    expect(r.fetchFn).toHaveBeenCalledTimes(MAX_QUOTE_CALLS); // 5 for the multi-request vendor + 7 for the rest, never 14
    expect(stats.get("wego")).toMatchObject({ calls: 5, succeeded: 4, failures: [], notes: [] }); // the later pairs cost nothing and are not "skipped"
    expect([...stats.values()].reduce((n, st) => n + st.calls, 0)).toBe(MAX_QUOTE_CALLS);
    // pair-major order still holds: the cheapest pair keeps every vendor
    expect(datesOf(r.fetchFn).filter((d) => d === "2026-11-10")).toHaveLength(3);
  });

  it("a vendor that says nothing sensible about its requests costs one slot per quote, and one that throws while saying it does not stop the phase", async () => {
    for (const bad of [() => Number.NaN, () => -3, () => "5" as unknown as number, () => { throw new Error("boom"); }]) {
      const src = fakeSource("serpapi", async () => [offer(70, { source: "serpapi" })], { nextQuoteRequests: bad });
      const { stats } = await runQuotes([src], primary, dates4, party);
      expect(src.asked).toHaveLength(4);
      expect(stats.get("serpapi")).toMatchObject({ succeeded: 4, notes: [] });
    }
    const fat = fakeSource("serpapi", async () => [], { nextQuoteRequests: () => MAX_QUOTE_CALLS + 1 }); // more than a search may ever spend: never asked
    const { stats } = await runQuotes([fat], primary, dates4, party);
    expect(fat.asked).toHaveLength(0);
    expect(stats.get("serpapi")?.notes).toEqual([`4 request(s) skipped (limit ${MAX_QUOTE_CALLS} per search)`]);
  });

  it("asks the pairs in parallel, not one after the other", async () => {
    const r = rig(["serpapi"]);
    await runQuotes(r.sources, primary, dates4, party);
    expect(r.fetchFn).toHaveBeenCalledTimes(4);
    expect(r.peak()).toBe(4);
  });

  it("one source throwing (a foreign error, synchronously or not) does not affect the others", async () => {
    const good = fakeSource("serpapi", async () => [offer(70, { source: "serpapi" })]);
    const rejects = fakeSource("ignav", async () => { throw new TypeError("boom"); });
    const sync = fakeSource("searchapi", async () => [], { quote: () => { throw new Error("sync boom api_key=SECRET"); } });
    const { offers, stats } = await runQuotes([rejects, sync, good], primary, dates4.slice(0, 2), party);
    expect(offers.map((o) => o.priceAmount)).toEqual([70, 70]);
    expect(stats.get("serpapi")).toMatchObject({ succeeded: 2, offers: 2, failures: [] });
    expect(stats.get("ignav")).toMatchObject({ succeeded: 0, failures: ["Ignav: unexpected error"] });
    expect(stats.get("searchapi")).toMatchObject({ succeeded: 0, failures: ["SearchApi: unexpected error"] });
    expect(JSON.stringify([...stats])).not.toContain("SECRET");
    expect(good.asked).toHaveLength(2);
  });

  it("stops asking a vendor that answered 401, 403 or 429, without touching the others", async () => {
    for (const status of [401, 403, 429]) {
      const repo = createRepo(createTestD1());
      const denied = vi.fn(async () => new Response("no", { status }));
      const fine = okFetch();
      const mk = (name: QuoteSourceName, fetchFn: unknown) => createQuoteSource(testAdapter(name, BIG), { key: "k", repo, now: NOW, fetchFn: asFetch(fetchFn) });
      const [a, b, c] = [mk("ignav", denied), mk("serpapi", fine), mk("searchapi", fine)];
      const { stats } = await runQuotes([a, b, c], primary, dates4, party);
      expect(stats.get("ignav")).toMatchObject({ succeeded: 0, failures: [`Ignav: HTTP ${status}`] });
      // the first wave (6 of the 12 planned requests) is already out when the answer arrives, the later pairs of that vendor are not asked
      expect(a.callCount()).toBe(2);
      expect(denied).toHaveBeenCalledTimes(2);
      expect(stats.get("serpapi")).toMatchObject({ calls: 4, succeeded: 4, failures: [] });
      expect(stats.get("searchapi")).toMatchObject({ calls: 4, succeeded: 4, failures: [] });
    }
  });

  it("stops asking a vendor that has no quota left, and says so as a note, not a failure", async () => {
    const r = rig(["serpapi"], { period: "lifetime", cap: 1, allowance: 10 });
    const { stats } = await runQuotes(r.sources, primary, dates4, party);
    expect(r.fetchFn).toHaveBeenCalledTimes(1);
    expect(stats.get("serpapi")).toMatchObject({ calls: 1, succeeded: 1, failures: [], notes: ["SerpApi: free quota used up (lifetime)"] });
  });

  it("an unconfigured source given to it anyway makes no request", async () => {
    const r = rig(["serpapi"]);
    const blank = createQuoteSource(testAdapter("ignav", BIG), { key: "", repo: createRepo(createTestD1()), now: NOW, fetchFn: asFetch(r.fetchFn) });
    const { stats } = await runQuotes([blank], primary, dates4, party);
    expect(r.fetchFn).not.toHaveBeenCalled();
    expect(stats.get("ignav")).toMatchObject({ calls: 0, succeeded: 0, failures: ["Ignav: not configured"] });
  });
});

describe("pickQuotePairs and mergeQuoted", () => {
  const priced = (price: number, over: Partial<Offer> = {}) => ({ ...offer(price, over), totalIls: price * 3 });

  it("picks the cheapest pairs of the primary airport pair by ILS total, from Travelpayouts fares only, never more than MAX_QUOTE_PAIRS", () => {
    const pool = [
      priced(100, { departDate: "2026-11-10", returnDate: "2026-11-16" }),
      priced(50, { departDate: "2026-11-11", returnDate: "2026-11-17", source: "google_flights" }),
      priced(70, { departDate: "2026-11-12", returnDate: "2026-11-18", origin: "SDV" }),
      priced(90, { departDate: "2026-11-13", returnDate: "2026-11-19" }),
      priced(90, { departDate: "2026-11-13", returnDate: "2026-11-19", outbound: leg({ departTime: "20:00" }) }),
      { ...offer(10, { departDate: "2026-11-14", returnDate: "2026-11-20" }), totalIls: null },
    ];
    expect(pickQuotePairs(pool, { origin: "TLV", dest: "BCN" }, 2)).toEqual([["2026-11-13", "2026-11-19"], ["2026-11-10", "2026-11-16"]]);
    const many = Array.from({ length: 9 }, (_, i) => priced(100 + i, { departDate: `2026-11-${10 + i}`, returnDate: `2026-11-${16 + i}` }));
    expect(pickQuotePairs(many, { origin: "TLV", dest: "BCN" })).toHaveLength(MAX_QUOTE_PAIRS);
    expect(pickQuotePairs(many, { origin: "TLV", dest: "BCN" }, 50)).toHaveLength(MAX_QUOTE_PAIRS); // a caller can ask for fewer, never for more
  });

  it("collapses the same flight seen by two live sources to the newest, then the cheapest", () => {
    const older = priced(80, { source: "serpapi", checkedAt: "2026-11-01T06:00:00.000Z" });
    const a = priced(90, { source: "searchapi", inbound: leg({ departTime: null }) });
    const b = priced(85, { source: "serpapi", inbound: leg({ departTime: null }) });
    expect(mergeQuoted([older, a, b]).map((o) => [o.source, o.priceAmount])).toEqual([["serpapi", 85]]);
  });

  it("a live quote replaces the cached fare of the same flight, but not other flights, split tickets or unpriceable quotes", () => {
    const evening = priced(100, { outbound: leg({ departTime: "20:00" }) });
    const split = priced(60, { ticketStructure: "split" });
    const quote = priced(120, { source: "serpapi" });
    const noRate = { ...priced(50, { source: "ignav", priceCurrency: "XXX" }), totalIls: null };
    const out = mergeQuoted([evening, split, priced(100), quote, noRate]);
    expect(out).toContain(evening);
    expect(out).toContain(split);
    expect(out).toContain(quote);
    expect(out).not.toContain(noRate);
    expect(out.filter((o) => o.source === "travelpayouts" && o.ticketStructure === "roundtrip")).toEqual([evening]);
  });

  it("is a no-op without quotes", () => {
    const pool = [priced(100), priced(100)];
    expect(mergeQuoted(pool)).toBe(pool);
  });
});

// --- in runSearch -------------------------------------------------------------------------------------------

describe("live quotes inside runSearch", () => {
  it("asks each source for the cheapest date pairs only (at most 4) and lists it in meta.sources with its own status", async () => {
    const w = world(pairsOf(9));
    const res = await w.run([w.mk("serpapi")], req({ windowEnd: "2026-11-30" }));
    expect(w.fetchFn).toHaveBeenCalledTimes(MAX_QUOTE_PAIRS);
    expect(datesOf(w.fetchFn).sort()).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(res.meta.sources.map((s) => s.name)).toEqual(["travelpayouts", "google_flights", "serpapi"]);
    expect(res.meta.sources[2]).toMatchObject({ name: "serpapi", enabled: true, ok: true, calls: 4, offers: 4, error: null });
    expect(await used(w.db, "serpapi", "2026-11")).toBe(4);
  });

  it("a live quote cheaper than the cached fare wins the card, and the card names the source", async () => {
    const w = world([offer(100)]);
    const res = await w.run([w.mk("serpapi", { fares: () => [fare(80)] })]);
    expect(res.cards[0]?.offer).toMatchObject({ source: "serpapi", priceAmount: 80, priceCurrency: "USD", totalIls: 240 });
    expect(res.cards[0]?.kinds).toContain("cheapest");
    expect(res.cards[0]?.ageHours).toBe(0);
  });

  it("a live quote is scaled to the party like any raw fare", async () => {
    const w = world([offer(100)]);
    const res = await w.run([w.mk("serpapi", { fares: () => [fare(80)] })], req({ adults: 2 }));
    expect(res.cards[0]?.offer).toMatchObject({ source: "serpapi", priceAmount: 160, totalIls: 480 });
    expect(res.cards[0]?.offer.deeplink).toContain("/search/TLV1211BCN18112"); // the booking link is for two adults
  });

  it("a live price replaces the cached one for the same flight, even when the cached one is cheaper", async () => {
    const w = world([offer(100)]);
    const res = await w.run([w.mk("serpapi", { fares: () => [fare(150)] })]);
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.offer).toMatchObject({ source: "serpapi", priceAmount: 150, totalIls: 450 });
  });

  it("the same flight seen by two sources (and the cache) is ranked once, and the ranking pool keeps the newest, cheapest quote", async () => {
    const w = world([offer(100)]);
    vi.mocked(recommend).mockClear();
    const res = await w.run([w.mk("serpapi", { fares: () => [fare(95)] }), w.mk("searchapi", { fares: () => [fare(90)] }), w.mk("ignav", { fares: () => [fare(92, { outbound: leg({ departTime: "20:00" }) })] })]);
    const pool = vi.mocked(recommend).mock.calls.at(-1)?.[0] ?? [];
    const flight = (o: Offer) => `${o.departDate}|${o.returnDate}|${o.outbound.departTime}`;
    const morning = pool.filter((o) => flight(o) === "2026-11-12|2026-11-18|10:00");
    expect(morning.map((o) => [o.source, o.priceAmount])).toEqual([["searchapi", 90]]); // one entry: the cheapest live quote, not the cached 100
    expect(pool.filter((o) => flight(o) === "2026-11-12|2026-11-18|20:00").map((o) => o.source)).toEqual(["ignav"]); // another flight stays
    expect(pool.some((o) => o.source === "travelpayouts" && o.ticketStructure === "roundtrip")).toBe(false);
    expect(res.cards[0]?.offer).toMatchObject({ source: "searchapi", priceAmount: 90 });
  });

  it("a live quote in a currency without an FX rate cannot be ranked: it is dropped and the cached fare stays", async () => {
    const w = world([offer(100)]);
    const res = await w.run([w.mk("serpapi", { fares: () => [fare(1, { currency: "XXX" })] })]);
    expect(res.cards[0]?.offer).toMatchObject({ source: "travelpayouts", priceAmount: 100 });
    expect(res.meta.sources[2]).toMatchObject({ name: "serpapi", ok: true, calls: 1, offers: 1 });
  });

  it("a cache hit makes no vendor call and no reservation, and shows the quote the scan stored", async () => {
    const w = world([offer(100)]);
    await w.repo.saveFxRates(FX);
    const first = await w.run([w.mk("serpapi", { fares: () => [fare(80)] })]);
    expect(first.meta.fromCache).toBe(false);
    expect(w.fetchFn).toHaveBeenCalledTimes(1);

    const second = await w.run([w.mk("serpapi")], req(), { now: new Date(NOW.getTime() + HOUR) });
    expect(second.meta.fromCache).toBe(true);
    expect(w.fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(w.db, "serpapi", "2026-11")).toBe(1);
    expect(second.cards[0]?.offer).toMatchObject({ source: "serpapi", priceAmount: 80 });
    expect(second.cards[0]?.ageHours).toBe(1);
    expect(second.meta.sources[2]).toMatchObject({ name: "serpapi", ok: true, calls: 0, offers: 1 });

    // ...but not for ever: a quote is "live" for QUOTE_MAX_AGE_HOURS, then the cached Travelpayouts fare is back
    const late = await w.run([w.mk("serpapi")], req(), { now: new Date(NOW.getTime() + (QUOTE_MAX_AGE_HOURS - 0.5) * HOUR) });
    expect(late.cards[0]?.offer.source).toBe("serpapi");
    expect(w.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a stored quote is 'live' for QUOTE_MAX_AGE_HOURS only: when Travelpayouts is down an older one is left out, a younger one is used", async () => {
    const down: TravelpayoutsClient = { ...mockTp([]), roundTrips: async () => { throw new TravelpayoutsError("HTTP 500: x", 500); } };
    const at = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
    for (const [hours, winner] of [[QUOTE_MAX_AGE_HOURS + 1, "travelpayouts"], [QUOTE_MAX_AGE_HOURS - 1, "serpapi"]] as const) {
      const w = world([]);
      await w.repo.savePrices([offer(100, { checkedAt: at(hours) }), offer(50, { source: "serpapi", checkedAt: at(hours) })]);
      const res = await w.run([w.mk("serpapi")], req(), { tp: down });
      expect(res.cards[0]?.offer.source, `${hours}h`).toBe(winner);
      expect(w.fetchFn).not.toHaveBeenCalled(); // an outage never asks vendors
      expect(res.meta.sources[2]).toMatchObject({ name: "serpapi", calls: 0, offers: winner === "serpapi" ? 1 : 0, ok: winner === "serpapi" });
    }
  });

  it("never caches a quote: the search cache holds the Travelpayouts scan only, the history gets one row per pair and vendor", async () => {
    const w = world([offer(100)]);
    await w.run([w.mk("serpapi", { fares: () => [fare(80)] })]);
    const cache = await rowsOf(w.db, "SELECT offers_json FROM search_cache");
    expect((JSON.parse(String(cache[0]?.offers_json)) as Offer[]).map((o) => o.source)).toEqual(["travelpayouts"]);
    expect(await rowsOf(w.db, "SELECT source, price_amount FROM prices ORDER BY source")).toEqual([
      { source: "serpapi", price_amount: 80 },
      { source: "travelpayouts", price_amount: 100 },
    ]);
    expect(await rowsOf(w.db, "SELECT source, consecutive_failures FROM source_health ORDER BY source")).toEqual([
      { source: "serpapi", consecutive_failures: 0 },
      { source: "travelpayouts", consecutive_failures: 0 },
    ]);
  });

  it("one vendor failing does not affect the others or the answer: an HTTP error, a timeout and garbage next to a good source", async () => {
    const solo = world(pairsOf(2));
    const alone = await solo.run([solo.mk("serpapi", { fares: () => [fare(70)] })]);

    const w = world(pairsOf(2));
    const bad = w.mk("ignav", { fetchFn: async () => new Response("x api_key=k", { status: 500 }) });
    const slow = w.mk("searchapi", { fetchFn: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
    const garbled = w.mk("wego", { fetchFn: async () => new Response("<html>", { status: 200 }) });
    const res = await w.run([bad, slow, garbled, w.mk("serpapi", { fares: () => [fare(70)] })]);
    const by = Object.fromEntries(res.meta.sources.map((s) => [s.name, s]));
    expect(by.ignav).toMatchObject({ ok: false, error: "Ignav: HTTP 500", calls: 2 });
    expect(by.searchapi).toMatchObject({ ok: false, error: "SearchApi: timeout", calls: 2 });
    expect(by.wego).toMatchObject({ ok: false, error: "Wego: unexpected response", calls: 2 });
    expect(by.serpapi).toMatchObject({ ok: true, calls: 2, offers: 2, error: null });
    expect(res.cards).toEqual(alone.cards); // the answer is exactly what the good source alone gives
    expect(JSON.stringify(res)).not.toContain("api_key");
    // every vendor that was asked is on record, the failed ones with their failure
    const health = await rowsOf(w.db, "SELECT source, consecutive_failures FROM source_health ORDER BY source");
    expect(health.map((r) => [r.source, r.consecutive_failures])).toEqual([["ignav", 1], ["searchapi", 1], ["serpapi", 0], ["travelpayouts", 0], ["wego", 1]]);
  });

  it("a source that throws (not a vendor error, an outright bug) does not affect the others or the answer either", async () => {
    const solo = world(pairsOf(2));
    const alone = await solo.run([solo.mk("serpapi", { fares: () => [fare(70)] })]);

    const w = world(pairsOf(2));
    const throws = fakeSource("ignav", async () => { throw new TypeError("boom api_key=SECRET"); });
    const throwsSync = fakeSource("wego", async () => [], { quote: () => { throw new RangeError("boom"); } });
    const res = await w.run([throws, throwsSync, w.mk("serpapi", { fares: () => [fare(70)] })]);
    expect(res.cards).toEqual(alone.cards);
    expect(res.meta.sources.map((s) => [s.name, s.ok, s.error])).toEqual([
      ["travelpayouts", true, null],
      ["google_flights", false, null],
      ["ignav", false, "Ignav: unexpected error"],
      ["wego", false, "Wego: unexpected error"],
      ["serpapi", true, null],
    ]);
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("when every source fails the answer is the Travelpayouts answer, unchanged", async () => {
    const solo = world([offer(100), offer(120, { departDate: "2026-11-13", returnDate: "2026-11-19" })]);
    const baseline = await solo.run(undefined);
    const w = world([offer(100), offer(120, { departDate: "2026-11-13", returnDate: "2026-11-19" })]);
    const res = await w.run([w.mk("serpapi", { fetchFn: async () => new Response("no", { status: 500 }) }), w.mk("ignav", { fetchFn: async () => { throw new TypeError("down"); } })]);
    expect(res.cards).toEqual(baseline.cards);
    expect(res.meta.sources.slice(0, 2)).toEqual(baseline.meta.sources);
    expect(res.meta.sources.slice(2).map((s) => s.ok)).toEqual([false, false]);
  });

  it("an exhausted source is reported and never called, and does not stop the others", async () => {
    const w = world(pairsOf(3));
    const fetchA = okFetch();
    const exhausted = w.mk("ignav", { quota: LIFETIME_1, fetchFn: fetchA });
    await w.repo.reserveQuota("ignav", "lifetime", 1, NOW); // the one unit is gone
    const res = await w.run([exhausted, w.mk("serpapi")]);
    expect(fetchA).not.toHaveBeenCalled();
    expect(w.fetchFn).toHaveBeenCalledTimes(3);
    expect(res.meta.sources.find((s) => s.name === "ignav")).toMatchObject({ enabled: true, ok: false, calls: 0, offers: 0, error: "Ignav: free quota used up (lifetime)" });
    expect(res.meta.sources.find((s) => s.name === "serpapi")).toMatchObject({ ok: true, calls: 3 });
    expect(await used(w.db, "ignav", "lifetime")).toBe(1);
  });

  it("with the quota table missing or the database failing no vendor is called, and the search still answers", async () => {
    const baseline = await world([offer(100)]).run(undefined);
    const noTable = world([offer(100)]);
    await noTable.db.prepare("DROP TABLE source_quota").run();
    const res = await noTable.run([noTable.mk("serpapi", { fares: () => [fare(1)] })]);
    expect(noTable.fetchFn).not.toHaveBeenCalled();
    expect(res.cards).toEqual(baseline.cards);
    expect(res.meta.sources[2]).toMatchObject({ name: "serpapi", ok: false, calls: 0, error: "SerpApi: free quota used up (monthly)" });

    const broken = world([offer(100)]);
    const failing = { ...broken.repo, reserveQuota: async () => { throw new Error("D1 unavailable"); } } as Repo;
    const res2 = await broken.run([broken.mk("serpapi", { repo: failing })]);
    expect(broken.fetchFn).not.toHaveBeenCalled();
    expect(res2.cards).toEqual(baseline.cards);
  });

  it("a source with configured false is never called and does not appear in meta.sources", async () => {
    const w = world([offer(100)]);
    const asked = vi.fn(async () => [offer(1, { source: "serpapi" })]);
    const off = fakeSource("serpapi", asked, { configured: false });
    const blank = w.mk("ignav", { key: "" });
    const res = await w.run([off, blank]);
    expect(asked).not.toHaveBeenCalled();
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(res.meta.sources.map((s) => s.name)).toEqual(["travelpayouts", "google_flights"]);
    expect(await rowsOf(w.db, "SELECT * FROM source_quota")).toEqual([]);
  });

  it("never exceeds MAX_QUOTE_CALLS requests in one search, whatever the number of vendors", async () => {
    const w = world(pairsOf(9));
    const sources = (["ignav", "searchapi", "serpapi", "wego"] as const).map((n) => w.mk(n));
    const res = await w.run(sources, req({ windowEnd: "2026-11-30" }));
    expect(w.fetchFn).toHaveBeenCalledTimes(MAX_QUOTE_CALLS);
    expect(res.meta.sources.slice(2).reduce((n, s) => n + s.calls, 0)).toBe(MAX_QUOTE_CALLS);
    expect(res.meta.sources.slice(2).every((s) => s.error === `1 request(s) skipped (limit ${MAX_QUOTE_CALLS} per search)`)).toBe(true);
    expect((await rowsOf(w.db, "SELECT SUM(used) AS n FROM source_quota"))[0]?.n).toBe(MAX_QUOTE_CALLS); // and the counters saw exactly those
  });

  it("asks the primary airport pair only", async () => {
    const w = world([offer(100), offer(90, { origin: "SDV", departDate: "2026-11-13", returnDate: "2026-11-19" })]);
    await w.run([w.mk("serpapi")]);
    expect(datesOf(w.fetchFn)).toEqual(["2026-11-12"]);
  });

  it("asks nobody when the Travelpayouts scan failed, was refused or is not configured: nothing is cached, so every repeat would spend units", async () => {
    const w = world([offer(100)]);
    await w.repo.savePrices([offer(100, { checkedAt: new Date(NOW.getTime() - HOUR).toISOString() })]);
    const failing: TravelpayoutsClient = { ...mockTp([]), roundTrips: async () => { throw new TravelpayoutsError("HTTP 500: x", 500); } };
    const res = await w.run([w.mk("serpapi")], req(), { tp: failing });
    expect(res.cards).toHaveLength(1); // served from stored fares
    await w.run([w.mk("serpapi")], req(), { tp: { ...mockTp([]), configured: false } });
    await w.run([w.mk("serpapi")], req(), { scanBudget: async () => false });
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await rowsOf(w.db, "SELECT * FROM source_quota")).toEqual([]);
  });

  it("a search with no Travelpayouts fares asks nobody", async () => {
    const w = world([]);
    const res = await w.run([w.mk("serpapi")]);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(res.meta.sources[2]).toMatchObject({ name: "serpapi", ok: false, calls: 0 });
  });
});

describe("without a configured extra source nothing changes", () => {
  it("the search key does not depend on the sources (pinned: a change here would strand every cached search)", async () => {
    expect(await computeSearchKey(req())).toBe("6dad9fb558a99b7a6e85db4d2e40bad66959175b58da43bfcb83d6d44f457d11");
  });

  it("the response, the cache row and the stored rows are identical with no sources, an empty list, or only unconfigured ones", async () => {
    const tp = [offer(100), offer(120, { departDate: "2026-11-13", returnDate: "2026-11-19" })];
    const base = world(tp);
    const baseline = await base.run(undefined);
    expect(baseline.meta.sources.map((s) => s.name)).toEqual(["travelpayouts", "google_flights"]);

    const dump = async (w: ReturnType<typeof world>) => ({
      cache: await rowsOf(w.db, "SELECT search_key, offers_json, extra_json FROM search_cache"),
      prices: await rowsOf(w.db, "SELECT origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure FROM prices ORDER BY id"),
      health: await rowsOf(w.db, "SELECT source, consecutive_failures FROM source_health ORDER BY source"),
      quota: await rowsOf(w.db, "SELECT * FROM source_quota"),
    });
    const expected = await dump(base);
    expect(expected.quota).toEqual([]);

    for (const make of [
      () => [] as FareQuoteSource[],
      (w: ReturnType<typeof world>) => [w.mk("serpapi", { key: "" }), w.mk("ignav", { key: "  " })],
      () => [fakeSource("wego", async () => [offer(1)], { configured: false })],
    ]) {
      const w = world(tp);
      const res = await w.run(make(w));
      expect(res).toEqual(baseline);
      expect(await dump(w)).toEqual(expected);
      expect(w.fetchFn).not.toHaveBeenCalled();
    }
  });
});
