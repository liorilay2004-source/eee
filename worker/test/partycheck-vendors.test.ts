/**
 * The party check's vendor side: every adapter can now ask for N adults (QuoteQuery.adults), and with ONE adult (or none
 * stated) each builds exactly the request it built before the field existed; the Wego source's party series (fixtures
 * written from the documented shapes, not from a live call); and the D1 counters that reserve several units at once.
 * Nothing here leaves the machine.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { compareFares, partyVerdict } from "../src/partycheck";
import { dailyShare, QuoteError, vendorAdults, withDailyShare, type QuoteQuery } from "../src/quotes";
import { ignavAdapter } from "../src/sources/ignav";
import { searchApiAdapter } from "../src/sources/searchapi";
import { serpApiAdapter } from "../src/sources/serpapi";
import { createWegoSource, partyTotalAgrees, resetWegoTokenCache, WEGO_QUOTA } from "../src/sources/wego";
import type { FxRates, Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const Q: QuoteQuery = { origin: "TLV", destination: "LHR", departDate: "2026-11-10", returnDate: "2026-11-17", party: { adults: 1 } };

// The requests below were captured from the adapters BEFORE QuoteQuery.adults existed (same queries, same key).
const SERPAPI_BEFORE = {
  url: "https://serpapi.com/search?engine=google_flights&departure_id=TLV&arrival_id=LHR&outbound_date=2026-11-10&return_date=2026-11-17&type=1&currency=USD&hl=en&adults=1&travel_class=1&sort_by=2&api_key=KEY-123",
  method: "GET",
  headers: {},
};
const SEARCHAPI_BEFORE = {
  url: "https://www.searchapi.io/api/v1/search?engine=google_flights&flight_type=round_trip&departure_id=TLV&arrival_id=LHR&outbound_date=2026-11-10&return_date=2026-11-17&adults=1&travel_class=economy&currency=USD&sort_by=price&separate_tickets=1",
  method: "GET",
  headers: { Authorization: "Bearer KEY-123" },
};
const IGNAV_BEFORE = {
  url: "https://ignav.com/api/fares/round-trip",
  method: "POST",
  headers: { "X-Api-Key": "KEY-123", "Content-Type": "application/json" },
  body: '{"origin":"TLV","destination":"LHR","departure_date":"2026-11-10","return_date":"2026-11-17","adults":1,"cabin_class":"economy","allow_self_transfer":false}',
};
const WEGO_SEARCH_BODY_BEFORE =
  '{"search":{"adultsCount":1,"childrenCount":0,"infantsCount":0,"cabin":"economy","currencyCode":"USD","locale":"en","siteCode":"XX","deviceType":"DESKTOP","appType":"WEB_APP","userLoggedIn":false,"clientCreatedAt":"2026-09-29T12:00:00.000Z","shopcashClickId":"","showWegoFares":false,"showWegoFaresOnly":false,"legs":[{"outboundDate":"2026-11-10","departureAirportCode":"TLV","arrivalAirportCode":"BCN"},{"outboundDate":"2026-11-17","departureAirportCode":"BCN","arrivalAirportCode":"TLV"}]}}';

describe("adapters with one adult build exactly the request they built before", () => {
  const adapters = [
    ["serpapi", serpApiAdapter, SERPAPI_BEFORE],
    ["searchapi", searchApiAdapter, SEARCHAPI_BEFORE],
    ["ignav", ignavAdapter, IGNAV_BEFORE],
  ] as const;

  for (const [name, adapter, before] of adapters) {
    it(`${name}: no adults stated, adults 1, and a bigger party (which only shapes the booking link) are all byte for byte the old request`, () => {
      expect(adapter.request(Q, "KEY-123")).toEqual(before);
      expect(adapter.request({ ...Q, adults: 1 }, "KEY-123")).toEqual(before);
      expect(adapter.request({ ...Q, party: { adults: 3, children: 2 } }, "KEY-123")).toEqual(before);
      expect(JSON.stringify(adapter.request(Q, "KEY-123"))).toBe(JSON.stringify(before));
    });

    it(`${name}: adults 2-9 change the adults parameter and nothing else; anything else is refused before any unit`, () => {
      for (const n of [2, 5, 9]) {
        const req = adapter.request({ ...Q, adults: n }, "KEY-123");
        const expected =
          "body" in before
            ? { ...before, body: before.body.replace('"adults":1', `"adults":${n}`) }
            : { ...before, url: before.url.replace("adults=1", `adults=${n}`) };
        expect(req).toEqual(expected);
      }
      for (const bad of [0, 10, 1.5, -1, Number.NaN, "2" as unknown as number]) {
        expect(() => adapter.request({ ...Q, adults: bad }, "KEY-123"), String(bad)).toThrow(RangeError);
      }
    });
  }

  it("vendorAdults: absent = 1, else a whole number 1-9", () => {
    expect(vendorAdults({})).toBe(1);
    expect(vendorAdults({ adults: 9 })).toBe(9);
    expect(() => vendorAdults({ adults: 0 })).toThrow(RangeError);
    expect(() => vendorAdults({ adults: 10 })).toThrow("adults must be a whole number from 1 to 9");
  });

  it("wego: the search body for one adult is the old one, and N adults change adultsCount only", async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/apps/oauth/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 43200 }), { status: 200 });
      if (u.endsWith("/metasearch/flights/searches")) {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ search: { id: "abc" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ count: 0, fares: [] }), { status: 200 });
    });
    const repo = { reserveQuota: async () => true, reserveQuotaUnits: async () => true } as unknown as Repo;
    const make = () => {
      resetWegoTokenCache();
      return createWegoSource({ apiKey: "client-1", fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW, sleep: async () => {}, clock: () => 0 });
    };
    const WQ = { ...Q, destination: "BCN" };
    await make().quote(WQ);
    await make().quote({ ...WQ, adults: 1 });
    await make().quote({ ...WQ, party: { adults: 4 } });
    expect(bodies).toEqual([WEGO_SEARCH_BODY_BEFORE, WEGO_SEARCH_BODY_BEFORE, WEGO_SEARCH_BODY_BEFORE]);
    await make().partySeries!([{ ...WQ, adults: 3 }]);
    expect(bodies[3]).toBe(WEGO_SEARCH_BODY_BEFORE.replace('"adultsCount":1', '"adultsCount":3'));
  });
});

// --- Wego's party series ----------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const HOST = "https://affiliate-api.wego.com";
const TOKEN_URL = `${HOST}/apps/oauth/token`;
const SEARCH_URL = `${HOST}/metasearch/flights/searches`;
const WQ: QuoteQuery = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", party: { adults: 2 } };

/** `designatorCode` null = the segment does not state one. */
const seg = (designatorCode: string | null, dep: string): Rec => ({
  departureAirportCode: "TLV", arrivalAirportCode: "BCN", airlineCode: "LY", cabin: "economy", durationMinutes: 255,
  ...(designatorCode === null ? {} : { designatorCode }), departureDateTime: dep,
});
const out = (id: string, code: string | null = "LY395", dep = "2026-11-12T08:05:00.000+02:00"): Rec => ({
  id, departureDateTime: dep, arrivalDateTime: "2026-11-12T11:20:00.000+01:00", durationMinutes: 255, departureAirportCode: "TLV", arrivalAirportCode: "BCN",
  airlineCodes: ["LY"], stopoversCount: 0, segments: [seg(code, dep)],
});
const back = (id: string, code: string | null = "LY396", dep = "2026-11-18T13:30:00.000+01:00"): Rec => ({
  id, departureDateTime: dep, arrivalDateTime: "2026-11-18T18:45:00.000+02:00", durationMinutes: 255, departureAirportCode: "BCN", arrivalAirportCode: "TLV",
  airlineCodes: ["LY"], stopoversCount: 0, segments: [{ ...seg(code, dep), departureAirportCode: "BCN", arrivalAirportCode: "TLV" }],
});
const fare = (id: string, tripId: string, price: Rec): Rec => ({ id, tripId, providerCode: "p", handoffUrl: `https://www.wego.com/h/${id}`, price: { currencyCode: "USD", ...price } });
const results = (legs: Rec[], trips: Rec[], fares: Rec[]): Rec => ({ legs, trips, fares, count: fares.length });

/** The answer per adults asked: the single search (id s1) and the group search (id s<N>). */
function wegoVendor(pages: Record<number, Rec>, opts: { failCreateFor?: number; status?: number } = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchFn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    if (url === TOKEN_URL) return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 43199 }), { status: 200 });
    if (url === SEARCH_URL) {
      const adults = (JSON.parse(String(init.body)) as { search: { adultsCount: number } }).search.adultsCount;
      if (opts.failCreateFor === adults) return new Response(JSON.stringify({ error: "vendor says no", client: "CLIENT-9" }), { status: opts.status ?? 429 });
      return new Response(JSON.stringify({ search: { id: `s${adults}` }, count: 0 }), { status: 201 });
    }
    const m = /\/searches\/s(\d+)\/results/.exec(url);
    if (m) return new Response(JSON.stringify(pages[Number(m[1])] ?? results([], [], [])), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  return { fetchFn, calls, creations: () => calls.filter((c) => c.url === SEARCH_URL) };
}

const PAGES: Record<number, Rec> = {
  // One adult: flight LY395/LY396 at 120 (the doc's example numbers: total = average for one passenger).
  1: results([out("L1"), back("L2")], [{ id: "T1", legIds: ["L1", "L2"] }], [fare("F1", "T1", { totalAmount: 120, amount: 120, originalAmount: 119.6 })]),
  // Two adults: the same flight at 300 total (150 each: agrees), and a fare whose "total" is really per person: dropped.
  2: results(
    [out("L1"), back("L2"), out("L7", "W62301", "2026-11-12T06:00:00.000+02:00"), back("L8", "W62302")],
    [{ id: "T1", legIds: ["L1", "L2"] }, { id: "T7", legIds: ["L7", "L8"] }],
    [fare("F1", "T1", { totalAmount: 300, amount: 150 }), fare("F7", "T7", { totalAmount: 90, amount: 90 })],
  ),
};

function wego(pages: Record<number, Rec> = PAGES, opts: { failCreateFor?: number; status?: number; seedUsed?: number; repo?: Repo } = {}) {
  resetWegoTokenCache();
  const db = createTestD1();
  const repo = opts.repo ?? createRepo(db);
  const v = wegoVendor(pages, opts);
  const source = createWegoSource({ apiKey: "CLIENT-9", fetchFn: v.fetchFn as unknown as typeof fetch, repo, now: NOW, sleep: async () => {}, clock: () => 0 });
  const used = async () => (await db.prepare("SELECT used FROM source_quota WHERE source = 'wego' AND period = 'lifetime'").first<number>("used")) ?? 0;
  const seed = (n: number) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('wego', 'lifetime', ?, ?)").bind(n, NOW.toISOString()).run();
  return { db, source, used, seed, ...v };
}

describe("wego party series (docs: totalAmount \"total amount\", amount the average for all passengers; that the total covers them all is INFERRED)", () => {
  it("reserves both units before the first request, then one search per query, in order, adults 1 then N", async () => {
    const w = wego();
    let usedAtFirst = -1;
    w.fetchFn.mockImplementationOnce(async () => {
      usedAtFirst = await w.used();
      return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 43199 }), { status: 200 });
    });
    const [single, group] = await w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }]);
    expect(usedAtFirst).toBe(2);
    expect(await w.used()).toBe(2);
    expect(w.creations().map((c) => (JSON.parse(String(c.body)) as { search: { adultsCount: number } }).search.adultsCount)).toEqual([1, 2]);
    expect(single).toEqual([
      {
        amount: 120,
        currency: "USD",
        flightKey: "LY395@2026-11-12T08:05|LY396@2026-11-18T13:30",
        outbound: { departTime: "08:05", arriveTime: "11:20", stops: 0, durationMin: 255, airlines: ["LY"] },
        inbound: { departTime: "13:30", arriveTime: "18:45", stops: 0, durationMin: 255, airlines: ["LY"] },
      },
    ]);
    // The per-person-looking "total" (90 total with an average of 90 for two adults) is not read at all.
    expect(group).toEqual([expect.objectContaining({ amount: 300, flightKey: "LY395@2026-11-12T08:05|LY396@2026-11-18T13:30" })]);
  });

  it("without designator codes a fare has no flight identity (never guessed)", async () => {
    const pages = { 1: results([out("L1", null), back("L2")], [{ id: "T1", legIds: ["L1", "L2"] }], [fare("F1", "T1", { totalAmount: 120 })]) };
    const w = wego(pages);
    const answers = await w.source.partySeries!([{ ...WQ, adults: 1 }]);
    expect(answers.map((fares) => fares.map((f) => f.flightKey))).toEqual([[null]]);
  });

  it("only 1 unit left: refused with zero requests (all or none)", async () => {
    const w = wego();
    await w.seed(WEGO_QUOTA.cap - 1);
    await expect(w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }])).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await w.used()).toBe(WEGO_QUOTA.cap - 1);
  });

  it("through the daily share (1 request a day for Wego today) a two-search series is always refused, with zero requests", async () => {
    const db = createTestD1();
    const w = wego(PAGES, { repo: withDailyShare(createRepo(db)) });
    expect(dailyShare(WEGO_QUOTA.period, WEGO_QUOTA.cap)).toBe(1);
    await expect(w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }])).rejects.toMatchObject({ code: "ration_exhausted" });
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it("the first search fails (HTTP 429 or 5xx): no second search, no retry, and nothing of the answer in the error", async () => {
    for (const status of [429, 500, 503]) {
      const w = wego(PAGES, { failCreateFor: 1, status });
      const err = await w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(QuoteError);
      expect(err).toMatchObject({ code: "http", status });
      expect(String((err as Error).message)).not.toContain("CLIENT-9");
      expect(w.creations()).toHaveLength(1);
      expect(w.calls.map((c) => c.url)).toEqual([TOKEN_URL, SEARCH_URL]);
    }
  });

  it("an unreadable token answer ends the series: ONE token request, no search, no second token request (no retry)", async () => {
    const w = wego();
    w.fetchFn.mockImplementation(async (input: unknown) => {
      w.calls.push({ url: String(input) });
      return new Response("<html>maintenance</html>", { status: 200 });
    });
    await expect(w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }])).rejects.toMatchObject({ code: "response" });
    expect(w.calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    expect(await w.used()).toBe(2); // reserved up front, never refunded
  });

  it("an unreadable search id ends the series: no polls, no second search", async () => {
    const w = wego();
    w.fetchFn.mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      w.calls.push({ url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      if (url === TOKEN_URL) return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 43199 }), { status: 200 });
      return new Response(JSON.stringify({ search: { id: "../../x" } }), { status: 201 }); // not a readable id
    });
    await expect(w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }])).rejects.toMatchObject({ code: "response" });
    expect(w.calls.map((c) => c.url)).toEqual([TOKEN_URL, SEARCH_URL]);
  });

  it("a one-adult answer without a usable fare ends the series: the group search is never created", async () => {
    const w = wego({ 1: results([], [], []), 2: PAGES[2] as Rec });
    const answers = await w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }]);
    expect(answers).toEqual([[]]);
    expect(w.creations()).toHaveLength(1);
    expect(w.creations().map((c) => (JSON.parse(String(c.body)) as { search: { adultsCount: number } }).search.adultsCount)).toEqual([1]);
  });

  it("a one-adult answer with no fare the caller can compare (its `comparable`, e.g. no rate for the currency) ends the series too", async () => {
    const none = wego();
    const answers = await none.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }], (f) => f.currency === "EUR");
    expect(answers).toHaveLength(1); // the USD fare came back, but the caller cannot compare it
    expect(none.creations()).toHaveLength(1);
    // A test that throws counts as "nothing comparable": the series stops (fewer requests, never more).
    const broken = wego();
    const stopped = await broken.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }], () => {
      throw new Error("no rates");
    });
    expect(stopped).toHaveLength(1);
    expect(broken.creations()).toHaveLength(1);
    // One comparable fare is enough to go on to the group search.
    const some = wego();
    expect(await some.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }], (f) => f.currency === "USD")).toHaveLength(2);
    expect(some.creations()).toHaveLength(2);
  });

  it("one token for the whole series, even when the vendor's token cannot be cached (no expires_in)", async () => {
    const w = wego();
    const base = w.fetchFn.getMockImplementation();
    w.fetchFn.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input) === TOKEN_URL) {
        w.calls.push({ url: TOKEN_URL });
        return new Response(JSON.stringify({ access_token: "tok_nocache" }), { status: 200 });
      }
      return base!(input, init);
    });
    const [single, group] = await w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }]);
    expect(single).toHaveLength(1);
    expect(group).toHaveLength(1);
    expect(w.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    expect(w.creations()).toHaveLength(2);
  });

  it("a query it cannot send fails before any unit or request; without a key nothing happens at all", async () => {
    const w = wego();
    await expect(w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 12 }])).rejects.toThrow(RangeError);
    await expect(w.source.partySeries!([{ ...WQ, returnDate: "2026-11-01" }])).rejects.toThrow(RangeError);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await w.used()).toBe(0);
    resetWegoTokenCache();
    const off = createWegoSource({ apiKey: " ", repo: createRepo(createTestD1()), now: NOW, fetchFn: w.fetchFn as unknown as typeof fetch });
    await expect(off.partySeries!([{ ...WQ, adults: 1 }])).rejects.toMatchObject({ code: "not_configured" });
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it("partyTotalAgrees: for 2+ adults the inferred total must be CHECKED against a per-passenger figure the fare states", () => {
    // Nothing to check against: the inference cannot be checked, so the fare is not read (it used to be read unchecked).
    expect(partyTotalAgrees({}, 300, 2)).toBe(false);
    expect(partyTotalAgrees({ amount: 0, originalAmount: "x", amountPerAdult: null }, 300, 2)).toBe(false); // unreadable = not stated
    expect(partyTotalAgrees({ amount: 150 }, 300, 2)).toBe(true);
    expect(partyTotalAgrees({ amount: 150.4 }, 300, 2)).toBe(true); // rounding of the average
    expect(partyTotalAgrees({ amount: 156, originalAmount: 150 }, 300, 2)).toBe(true); // a payment fee in the average only
    expect(partyTotalAgrees({ amount: 150 }, 150, 2)).toBe(false); // the "total" is per person
    expect(partyTotalAgrees({ amount: 300 }, 300, 2)).toBe(false); // the "average" is the total
    // amountPerAdult ("amount per adult passenger") is a per-passenger figure too, and every figure stated must agree.
    expect(partyTotalAgrees({ amountPerAdult: 150 }, 300, 2)).toBe(true);
    expect(partyTotalAgrees({ amountPerAdult: 150 }, 150, 2)).toBe(false);
    expect(partyTotalAgrees({ amount: 150, amountPerAdult: 300 }, 300, 2)).toBe(false);
    expect(partyTotalAgrees({ amount: 100, originalAmount: 100, amountPerAdult: 100 }, 300, 3)).toBe(true);
    // One adult: a total and a per-person price are the same thing; stated figures must still agree.
    expect(partyTotalAgrees({}, 120, 1)).toBe(true);
    expect(partyTotalAgrees({ amount: 120, originalAmount: 119.6 }, 120, 1)).toBe(true);
    expect(partyTotalAgrees({ amount: 240 }, 120, 1)).toBe(false);
  });

  it("the review's case: a group 'total' with no per-passenger figure is not read, so a per-person price can never pass as the group's", async () => {
    // If totalAmount were really PER PERSON (150 for one adult, 150 each for two) and no average were stated, reading it as the
    // group's total made one booking look half price ("together", group total 150 instead of 300). Now that fare is not read:
    // nothing comparable for the group, verdict "unknown".
    const pages = {
      1: results([out("L1"), back("L2")], [{ id: "T1", legIds: ["L1", "L2"] }], [fare("F1", "T1", { totalAmount: 150 })]),
      2: results([out("L1"), back("L2")], [{ id: "T1", legIds: ["L1", "L2"] }], [fare("F1", "T1", { totalAmount: 150 })]),
    };
    const w = wego(pages);
    const [single, group] = await w.source.partySeries!([{ ...WQ, adults: 1 }, { ...WQ, adults: 2 }]);
    expect(single).toHaveLength(1); // one adult: read as before
    expect(group).toEqual([]);
    const FX: FxRates = { date: "2026-09-29", source: "t", ratesToIls: { ILS: 1, USD: 3.5 } };
    const cmp = compareFares(single ?? [], group ?? [], 2, FX, "total");
    expect(cmp).toMatchObject({ basis: null, why: "no_group", together: null });
    expect(partyVerdict(cmp.single?.ils ?? null, cmp.together?.ils ?? null, 2).verdict).toBe("unknown");
  });
});

// --- the counters that reserve several units at once --------------------------------------------------------

describe("reserveQuotaUnits / reserveDailyUnits (all or none, fail closed)", () => {
  const usedOf = async (db: D1Database) => (await db.prepare("SELECT used FROM source_quota WHERE source = 'ignav' AND period = 'lifetime'").first<number>("used")) ?? 0;
  const dayCount = async (db: D1Database, key: string) => (await db.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first<number>("count")) ?? 0;

  it("takes all the units or none, never past the cap, next to the one-unit counter", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    expect(await repo.reserveQuotaUnits!("ignav", "lifetime", 5, 2, NOW)).toBe(true);
    expect(await repo.reserveQuotaUnits!("ignav", "lifetime", 5, 2, NOW)).toBe(true);
    expect(await usedOf(db)).toBe(4);
    expect(await repo.reserveQuotaUnits!("ignav", "lifetime", 5, 2, NOW)).toBe(false); // 1 left: none taken
    expect(await usedOf(db)).toBe(4);
    expect(await repo.reserveQuota("ignav", "lifetime", 5, NOW)).toBe(true);
    expect(await repo.reserveQuotaUnits!("ignav", "lifetime", 5, 1, NOW)).toBe(false);
    expect(await usedOf(db)).toBe(5);
    // A first reservation larger than the cap inserts nothing.
    const fresh = createTestD1();
    expect(await createRepo(fresh).reserveQuotaUnits!("ignav", "lifetime", 1, 2, NOW)).toBe(false);
    expect(await usedOf(fresh)).toBe(0);
  });

  it("holds under concurrency: 20 parallel two-unit reservations under a cap of 7 grant exactly 3", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const got = await Promise.all(Array.from({ length: 20 }, () => repo.reserveQuotaUnits!("ignav", "lifetime", 7, 2, NOW)));
    expect(got.filter(Boolean)).toHaveLength(3);
    expect(await usedOf(db)).toBe(6);
  });

  it("refuses odd input and fails closed on a missing table or a broken database", async () => {
    const repo = createRepo(createTestD1());
    for (const units of [0, -1, 1.5, 11, Number.NaN]) expect(await repo.reserveQuotaUnits!("ignav", "lifetime", 100, units, NOW), String(units)).toBe(false);
    for (const cap of [0, 0.5, Number.NaN]) expect(await repo.reserveQuotaUnits!("ignav", "lifetime", cap, 2, NOW), String(cap)).toBe(false);
    expect(await repo.reserveQuotaUnits!("ignav", "forever", 100, 2, NOW)).toBe(false);
    const noTable = createTestD1();
    await noTable.exec("DROP TABLE source_quota");
    expect(await createRepo(noTable).reserveQuotaUnits!("ignav", "lifetime", 100, 2, NOW)).toBe(false);
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await createRepo(broken).reserveQuotaUnits!("ignav", "lifetime", 100, 2, NOW)).toBe(false);
    expect(await createRepo(broken).reserveDailyUnits!("quota:ignav", 100, 2, NOW)).toBe(false);
  });

  it("the daily counter: all or none per UTC day, and the party check's own 'party:<source>' key is accepted", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    expect(await repo.reserveDailyUnits!("quota:ignav", 3, 2, NOW)).toBe(true);
    expect(await repo.reserveDailyUnits!("quota:ignav", 3, 2, NOW)).toBe(false);
    expect(await dayCount(db, "quota:ignav")).toBe(2);
    expect(await repo.reserveDailyUnits!("quota:ignav", 3, 2, new Date("2026-09-30T00:00:00Z"))).toBe(true); // the next UTC day
    expect(await repo.reserveDaily("party:ignav", 1, NOW)).toBe(true);
    expect(await repo.reserveDaily("party:ignav", 1, NOW)).toBe(false);
    for (const key of ["party:", "party:IGNAV", "party-client:abc", "partyx:ignav", "search:abc"]) {
      expect(await repo.reserveDaily(key, 5, NOW), key).toBe(false);
      expect(await repo.reserveDailyUnits!(key, 5, 2, NOW), key).toBe(false);
    }
  });

  it("withDailyShare: the day's share first, all or none; a refused share leaves the real counter untouched", async () => {
    const db = createTestD1();
    const shared = withDailyShare(createRepo(db));
    const share = dailyShare("lifetime", 100); // 4
    expect(await shared.reserveQuotaUnits!("ignav", "lifetime", 100, 2, NOW)).toBe(true);
    expect(await shared.reserveQuotaUnits!("ignav", "lifetime", 100, 2, NOW)).toBe(true);
    expect(await dayCount(db, "quota:ignav")).toBe(share);
    await expect(shared.reserveQuotaUnits!("ignav", "lifetime", 100, 2, NOW)).rejects.toMatchObject({ code: "ration_exhausted" });
    expect(await usedOf(db)).toBe(4);
  });
});
