import { afterEach, describe, expect, it, vi } from "vitest";
import { BOI_URL, FALLBACK_URL, getFxRates } from "../src/fx";
import { createRepo } from "../src/db";
import { toIls } from "../src/money";
import type { FxRates, Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-11-01T09:30:00.000Z");
const TODAY = "2026-11-01";

const boi = (rows: unknown[]) => ({ exchangeRates: rows });
const BOI_OK = boi([
  { key: "USD", currentExchangeRate: 3.65, currentChange: 0.2, unit: 1, lastUpdate: "2026-11-01T08:00:00Z" },
  { key: "EUR", currentExchangeRate: 4.2, currentChange: -0.1, unit: 1, lastUpdate: "2026-11-01T08:00:00Z" },
  { key: "JPY", currentExchangeRate: 2.4, currentChange: 0.0, unit: 100, lastUpdate: "2026-11-01T08:00:00Z" },
  { key: "GBP", currentExchangeRate: 4.8, unit: 1 },
]);
const ER_OK = { result: "success", base_code: "ILS", rates: { ILS: 1, USD: 0.27, EUR: 0.2381, JPY: 41.5 } };

type Handler = () => Response | Promise<Response>;
const ok = (body: unknown): Handler => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number): Handler => () => new Response("nope", { status: code });
const boom = (msg: string): Handler => () => {
  throw new TypeError(msg);
};
/** A body whose json() yields a value JSON text cannot carry (NaN, Infinity). */
const raw = (value: unknown): Handler => () => ({ ok: true, status: 200, json: async () => value }) as unknown as Response;

function fetchStub(boiHandler: Handler, erHandler: Handler) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === BOI_URL) return boiHandler();
    if (url === FALLBACK_URL) return erHandler();
    throw new Error(`unexpected URL ${url}`);
  });
}
const asFetch = (f: ReturnType<typeof fetchStub>) => f as unknown as typeof fetch;

function setup(boiHandler: Handler = ok(BOI_OK), erHandler: Handler = ok(ER_OK)) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = fetchStub(boiHandler, erHandler);
  return { db, repo, fetchFn, get: (now = NOW) => getFxRates(repo, asFetch(fetchFn), now) };
}

const urls = (f: ReturnType<typeof fetchStub>) => f.mock.calls.map((c) => String(c[0]));

afterEach(() => vi.restoreAllMocks());

describe("Bank of Israel (primary)", () => {
  it("parses rates, dividing by unit (JPY is quoted per 100), always with ILS: 1", async () => {
    const { get, fetchFn } = setup();
    const fx = await get();
    expect(fx.source).toBe("bank_of_israel");
    expect(fx.date).toBe(TODAY);
    expect(fx.ratesToIls.USD).toBe(3.65);
    expect(fx.ratesToIls.EUR).toBe(4.2);
    expect(fx.ratesToIls.GBP).toBe(4.8);
    expect(fx.ratesToIls.JPY).toBeCloseTo(0.024, 10);
    expect(fx.ratesToIls.ILS).toBe(1);
    expect(urls(fetchFn)).toEqual([BOI_URL]); // fallback untouched when the primary works
  });

  it("converts through toIls consistently (1000 JPY is ~24 ILS)", async () => {
    const fx = await setup().get();
    expect(toIls(fx, 1000, "jpy")).toBeCloseTo(24, 6);
    expect(toIls(fx, 100, "USD")).toBeCloseTo(365, 6);
  });

  it("asks with a timeout signal of 8000ms", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { get, fetchFn } = setup();
    await get();
    expect(timeout).toHaveBeenCalledWith(8000);
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uppercases keys and pins ILS to 1 even if the payload says otherwise", async () => {
    const { get } = setup(
      ok(boi([
        { key: "usd", currentExchangeRate: 3.6, unit: 1 },
        { key: " eur ", currentExchangeRate: 4.1 }, // no unit means 1, like the Python engine
        { key: "ILS", currentExchangeRate: 5, unit: 1 },
      ])),
    );
    const fx = await get();
    expect(fx.ratesToIls).toEqual({ USD: 3.6, EUR: 4.1, ILS: 1 });
  });

  it("keeps valid entries and drops malformed ones individually", async () => {
    const { get } = setup(
      ok(boi([
        { key: "USD", currentExchangeRate: 3.65, unit: 1 },
        { key: "EUR", currentExchangeRate: -4.2, unit: 1 }, // negative
        { key: "GBP", currentExchangeRate: "abc", unit: 1 }, // not a number
        { key: "CHF", currentExchangeRate: 4.1, unit: 0 }, // unit 0 would divide by zero
        { key: "CAD", currentExchangeRate: 2.6, unit: -1 },
        { key: "AUD", currentExchangeRate: null, unit: 1 },
        { key: "SEK", currentExchangeRate: true, unit: 1 },
        { key: "NOK", currentExchangeRate: "", unit: 1 },
        { key: "__proto__", currentExchangeRate: 9, unit: 1 },
        { key: "constructor", currentExchangeRate: 9, unit: 1 },
        { key: "TOOLONG", currentExchangeRate: 9, unit: 1 },
        { key: 5, currentExchangeRate: 9, unit: 1 },
        null,
        7,
        "x",
        { currentExchangeRate: 3 },
        { key: "DKK", currentExchangeRate: "0.53", unit: "1" }, // numeric strings are fine
      ])),
    );
    const fx = await get();
    expect(fx.source).toBe("bank_of_israel");
    expect(fx.ratesToIls).toEqual({ USD: 3.65, DKK: 0.53, ILS: 1 });
    expect(Object.getPrototypeOf(fx.ratesToIls)).toBe(Object.prototype);
  });

  it("stores the result in D1 for the UTC date", async () => {
    const { get, repo } = setup();
    const fx = await get();
    expect(await repo.getFxRates(TODAY)).toEqual(fx);
  });
});

describe("open.er-api.com (fallback)", () => {
  const primaryDown: [string, Handler][] = [
    ["network error", boom("fetch failed")],
    ["HTTP 500", status(500)],
    ["HTTP 403 (WAF page)", status(403)],
    ["HTML instead of JSON", () => new Response("<html>blocked</html>", { status: 200 })],
    ["empty body", () => new Response("", { status: 200 })],
  ];

  it.each(primaryDown)("is used when the primary fails: %s", async (_label, handler) => {
    const { get, fetchFn, repo } = setup(handler);
    const fx = await get();
    expect(fx.source).toBe("open.er-api.com");
    expect(fx.date).toBe(TODAY);
    expect(urls(fetchFn)).toEqual([BOI_URL, FALLBACK_URL]);
    expect(await repo.getFxRates(TODAY)).toEqual(fx);
  });

  it("inverts units-per-ILS into ILS-per-unit", async () => {
    const { get } = setup(status(500));
    const fx = await get();
    expect(fx.ratesToIls.USD).toBeCloseTo(1 / 0.27, 10);
    expect(fx.ratesToIls.EUR).toBeCloseTo(1 / 0.2381, 10);
    expect(fx.ratesToIls.JPY).toBeCloseTo(1 / 41.5, 10);
    expect(fx.ratesToIls.ILS).toBe(1);
    // round trip: 100 USD -> ILS -> back is 27 USD-per-ILS
    expect(toIls(fx, 100, "USD") * 0.27).toBeCloseTo(100, 6);
  });

  const badPrimary: [string, unknown][] = [
    ["null", null],
    ["array", []],
    ["exchangeRates is not an array", { exchangeRates: "x" }],
    ["exchangeRates missing", { rates: {} }],
    ["no USD entry", boi([{ key: "EUR", currentExchangeRate: 4.2, unit: 1 }])],
    ["USD negative", boi([{ key: "USD", currentExchangeRate: -3.65, unit: 1 }, { key: "EUR", currentExchangeRate: 4.2, unit: 1 }])],
    ["USD zero", boi([{ key: "USD", currentExchangeRate: 0, unit: 1 }])],
    ["USD null", boi([{ key: "USD", currentExchangeRate: null, unit: 1 }])],
    ["USD text", boi([{ key: "USD", currentExchangeRate: "abc", unit: 1 }])],
    ["USD with unit 0", boi([{ key: "USD", currentExchangeRate: 3.65, unit: 0 }])],
    ["empty table", boi([])],
  ];

  it.each(badPrimary)("rejects a garbage primary payload and falls back: %s", async (_label, payload) => {
    const { get, fetchFn } = setup(ok(payload));
    const fx = await get();
    expect(fx.source).toBe("open.er-api.com");
    expect(urls(fetchFn)).toEqual([BOI_URL, FALLBACK_URL]);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("rejects a primary USD rate of %s", async (_label, value) => {
    const { get } = setup(raw(boi([{ key: "USD", currentExchangeRate: value, unit: 1 }])));
    expect((await get()).source).toBe("open.er-api.com");
  });

  it("drops zero, negative, NaN and non-numeric fallback rates without dividing by them", async () => {
    const { get } = setup(
      status(500),
      raw({ result: "success", rates: { USD: 0.27, EUR: 0, GBP: -0.2, CHF: NaN, CAD: "x", AUD: null, JPY: 1e-320, ILS: 1, "bad!": 2, DKK: "0.14" } }),
    );
    const fx = await get();
    expect(Object.keys(fx.ratesToIls).sort()).toEqual(["DKK", "ILS", "USD"]);
    expect(fx.ratesToIls.DKK).toBeCloseTo(1 / 0.14, 10);
    for (const v of Object.values(fx.ratesToIls)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  const badFallback: [string, unknown][] = [
    ["result: error", { result: "error", "error-type": "quota-reached" }],
    ["rates missing", { result: "success" }],
    ["rates is an array", { result: "success", rates: [1, 2] }],
    ["rates is a string", { result: "success", rates: "x" }],
    ["no USD", { result: "success", rates: { EUR: 0.24 } }],
    ["USD zero (would divide by zero)", { result: "success", rates: { USD: 0 } }],
    ["USD negative", { result: "success", rates: { USD: -0.27 } }],
    ["null", null],
    ["number", 42],
  ];

  it.each(badFallback)("rejects a garbage fallback payload: %s", async (_label, payload) => {
    const { get } = setup(status(500), ok(payload));
    await expect(get()).rejects.toThrow(/No FX rates available/);
  });
});

describe("cache", () => {
  it("a cache hit makes ZERO fetch calls", async () => {
    const { get, fetchFn, repo } = setup();
    const seeded: FxRates = { date: TODAY, source: "bank_of_israel", ratesToIls: { USD: 3.5, EUR: 4, ILS: 1 } };
    await repo.saveFxRates(seeded);
    const fx = await get();
    expect(fx).toEqual(seeded);
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });

  it("the second call after a fetch is served from D1 without fetching again", async () => {
    const { get, fetchFn } = setup();
    const first = await get();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const second = await get(new Date("2026-11-01T23:59:59.999Z"));
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a fallback-sourced day is cached as well", async () => {
    const { get, fetchFn } = setup(status(500));
    const first = await get();
    await get();
    expect(first.source).toBe("open.er-api.com");
    expect(fetchFn).toHaveBeenCalledTimes(2); // primary + fallback once, nothing on the second call
  });

  it("refreshes when the UTC date changes", async () => {
    const { get, fetchFn, repo } = setup();
    await get(new Date("2026-11-01T23:59:59.999Z"));
    await get(new Date("2026-11-02T00:00:00.000Z"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((await repo.getFxRates("2026-11-02"))?.date).toBe("2026-11-02");
  });

  it("an older day in D1 is not a cache hit for today", async () => {
    const { get, fetchFn, repo } = setup();
    await repo.saveFxRates({ date: "2026-10-31", source: "bank_of_israel", ratesToIls: { USD: 3.4, ILS: 1 } });
    const fx = await get();
    expect(fx.date).toBe(TODAY);
    expect(fx.ratesToIls.USD).toBe(3.65);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("an unusable cached row (no USD) is ignored and refetched", async () => {
    const { get, fetchFn, repo } = setup();
    await repo.saveFxRates({ date: TODAY, source: "bank_of_israel", ratesToIls: { EUR: 4, ILS: 1 } });
    const fx = await get();
    expect(fx.ratesToIls.USD).toBe(3.65);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("stale fallback", () => {
  const old: FxRates = { date: "2026-10-27", source: "bank_of_israel", ratesToIls: { USD: 3.5, EUR: 4.1, ILS: 1 } };

  it("serves the newest stored day, marked :stale, when both sources fail", async () => {
    const { get, repo, fetchFn } = setup(boom("fetch failed"), status(503));
    await repo.saveFxRates({ ...old, date: "2026-10-20", ratesToIls: { USD: 3.3, ILS: 1 } });
    await repo.saveFxRates(old);
    const fx = await get();
    expect(fx).toEqual({ ...old, source: "bank_of_israel:stale" });
    expect(urls(fetchFn)).toEqual([BOI_URL, FALLBACK_URL]);
  });

  it("also covers garbage payloads from both sources", async () => {
    const { get, repo } = setup(ok({ exchangeRates: [] }), ok({ result: "error" }));
    await repo.saveFxRates({ ...old, source: "open.er-api.com" });
    expect((await get()).source).toBe("open.er-api.com:stale");
  });

  it("does not persist the stale marker or overwrite stored days", async () => {
    const { get, repo } = setup(status(500), status(500));
    await repo.saveFxRates(old);
    await get();
    expect(await repo.getFxRates(TODAY)).toBeNull();
    expect((await repo.getLatestFxRates())?.source).toBe("bank_of_israel");
  });

  it("throws only when nothing exists anywhere", async () => {
    const { get } = setup(boom("fetch failed"), status(503));
    await expect(get()).rejects.toThrow(/No FX rates available.*bank_of_israel.*fetch failed.*open\.er-api\.com.*HTTP 503/);
  });

  it("times out via AbortSignal.timeout(8000) on each source and then serves stale", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    const hang = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const s = init?.signal;
        if (s?.aborted) reject(new DOMException("The operation timed out", "TimeoutError"));
        else s?.addEventListener("abort", () => reject(new DOMException("The operation timed out", "TimeoutError")));
      });
    const repo = createRepo(createTestD1());
    await repo.saveFxRates(old);
    const fx = await getFxRates(repo, hang as unknown as typeof fetch, NOW);
    expect(fx.source).toBe("bank_of_israel:stale");
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 8000);
    expect(timeout).toHaveBeenNthCalledWith(2, 8000);
  });
});

describe("storage failures", () => {
  it("still returns fresh rates when D1 cannot be read or written", async () => {
    const fetchFn = fetchStub(ok(BOI_OK), ok(ER_OK));
    const down = () => Promise.reject(new Error("D1 unavailable"));
    const repo = { ...createRepo(createTestD1()), getFxRates: down, saveFxRates: down } as unknown as Repo;
    const fx = await getFxRates(repo, asFetch(fetchFn), NOW);
    expect(fx.source).toBe("bank_of_israel");
    expect(fx.ratesToIls.USD).toBe(3.65);
  });

  it("throws the FX error (not a storage error) when sources fail and the stale read fails too", async () => {
    const fetchFn = fetchStub(status(500), status(500));
    const down = () => Promise.reject(new Error("D1 unavailable"));
    const repo = { ...createRepo(createTestD1()), getFxRates: down, getLatestFxRates: down } as unknown as Repo;
    await expect(getFxRates(repo, asFetch(fetchFn), NOW)).rejects.toThrow(/No FX rates available/);
  });
});
