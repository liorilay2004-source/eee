/**
 * Pipeline tests: real D1 shim + repo, a mock Travelpayouts client, injected FX. Mapped to SPEC §16.
 * The mock reproduces the real client's request accounting (k(k+1)/2 per round-trip scan, k per one-way scan).
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import {
  airportPairs,
  computeSearchKey,
  defaultResolver,
  FALLBACK_MAX_AGE_HOURS,
  EMPTY_RESULT_TTL_HOURS,
  MAX_CACHED_OFFERS,
  MAX_CACHED_ONEWAYS,
  MAX_PERSISTED_PRICES,
  MAX_TP_REQUESTS,
  PipelineError,
  REFRESH_LOCK_SECONDS,
  runSearch,
  sanitizeOffers,
  sanitizeOneWayPairs,
  STALE_MAX_AGE_HOURS,
  staleInfo,
  type SearchDeps,
} from "../src/pipeline";
import { BAG_FEES, SCORING } from "../src/scoring.config";
import { buildSplits, countValidPairs, pairOk, validPairs } from "../src/splits";
import { monthsBetween, TravelpayoutsError } from "../src/travelpayouts";
import type { FareQuoteSource } from "../src/quotes";
import type { FxRates, Leg, Offer, OneWayFare, OneWayPair, SearchRequest, SearchResponse, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number, from: Date = NOW) => new Date(from.getTime() - ms).toISOString();
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };

function leg(over: Partial<Leg> = {}): Leg {
  return { departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over };
}

function offer(price: number, over: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV",
    destination: "BCN",
    departDate: "2026-11-12",
    returnDate: "2026-11-18",
    priceAmount: price,
    priceCurrency: "USD",
    source: "travelpayouts",
    ticketStructure: "roundtrip",
    outbound: leg(),
    inbound: leg({ departTime: "18:00" }),
    includes: {},
    deeplink: "https://www.aviasales.com/search/TLV1211BCN1811?marker=m",
    verifyLink: null,
    checkedAt: ago(0),
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
    ...over,
  };
}

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV",
    destination: "BCN",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-25",
    stayMin: 5,
    stayMax: 7,
    adults: 1,
    children: 0,
    infants: 0,
    cabin: "economy",
    checkedBag: false,
    outHours: null,
    retHours: null,
    maxStops: null,
    nearbyAirports: false,
    ...over,
  };
}

function fare(date: string, price: number, over: Partial<OneWayFare> = {}): OneWayFare {
  return { date, priceAmount: price, priceCurrency: "USD", leg: leg({ airlines: ["W6"] }), deeplink: `https://www.aviasales.com/x/${date}`, ...over };
}

// --- mock Travelpayouts ----------------------------------------------------------------------------------

interface MockTpOptions {
  configured?: boolean;
  rt?: (origin: string, dest: string) => Offer[];
  ow?: (origin: string, dest: string) => OneWayFare[];
}

type MockTp = TravelpayoutsClient & { log: string[] };

function mockTp(opts: MockTpOptions = {}): MockTp {
  const log: string[] = [];
  let calls = 0;
  return {
    configured: opts.configured ?? true,
    log,
    callCount: () => calls,
    async roundTrips(origin, dest, ws, we) {
      const k = monthsBetween(ws, we).length;
      calls += (k * (k + 1)) / 2;
      log.push(`rt:${origin}-${dest}`);
      return (opts.rt?.(origin, dest) ?? []).map((o) => structuredClone(o));
    },
    async oneWays(origin, dest, ws, we) {
      calls += monthsBetween(ws, we).length;
      log.push(`ow:${origin}-${dest}`);
      return (opts.ow?.(origin, dest) ?? []).map((f) => structuredClone(f));
    },
  };
}

/** Round trips for TLV-BCN only, whatever pair is asked (other pairs come back empty). */
const rtFor = (offers: Offer[]) => (o: string, d: string) => (o === "TLV" && d === "BCN" ? offers : []);

function setup(over: Partial<SearchDeps> & { tp?: TravelpayoutsClient } = {}) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fx = vi.fn(async () => FX);
  const deps: SearchDeps = { repo, tp: over.tp ?? mockTp(), fx, now: NOW, ...over };
  return { db, repo, fx, deps };
}

async function rows<T = Record<string, unknown>>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...binds).all<T>()).results;
}
const count = async (db: D1Database, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
const kindsOf = (cards: { kinds: string[] }[]) => cards.flatMap((c) => c.kinds);
const cardOf = <C extends { kinds: string[] }>(cards: C[], kind: string) => cards.find((c) => c.kinds.includes(kind));

// ---------------------------------------------------------------------------------------------------------

describe("computeSearchKey", () => {
  it("is a stable SHA-256 hex of the fares-defining fields", async () => {
    const a = await computeSearchKey(req());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeSearchKey(req())).toBe(a);
  });

  it("ignores extras, hour windows and max stops: they only affect ranking", async () => {
    const base = await computeSearchKey(req());
    expect(await computeSearchKey(req({ checkedBag: true }))).toBe(base);
    expect(await computeSearchKey(req({ outHours: [6, 12] }))).toBe(base);
    expect(await computeSearchKey(req({ retHours: [15, 23] }))).toBe(base);
    expect(await computeSearchKey(req({ maxStops: 1 }))).toBe(base);
  });

  it("changes with every field that changes which fares exist", async () => {
    const base = await computeSearchKey(req());
    const variants: Partial<SearchRequest>[] = [
      { origin: "ETM" },
      { destination: "ATH" },
      { windowStart: "2026-11-11" },
      { windowEnd: "2026-11-26" },
      { stayMin: 4 },
      { stayMax: 8 },
      { adults: 2 },
      { children: 1 },
      { infants: 1 },
      { cabin: "business" },
      { nearbyAirports: true },
    ];
    const keys = await Promise.all(variants.map((v) => computeSearchKey(req(v))));
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not depend on property order or on the case of the codes", async () => {
    const shuffled = Object.fromEntries(Object.entries(req()).reverse()) as unknown as SearchRequest;
    expect(await computeSearchKey(shuffled)).toBe(await computeSearchKey(req()));
    expect(await computeSearchKey(req({ origin: "tlv", destination: "bcn" }))).toBe(await computeSearchKey(req()));
  });
});

describe("recommendations (SPEC §8)", () => {
  const cheapBad = () =>
    offer(100, {
      outbound: leg({ departTime: "03:00", stops: 2, durationMin: 900, airlines: ["X"] }),
      inbound: leg({ departTime: "04:00", stops: 2, durationMin: 900, airlines: ["X"] }),
    });

  it("returns Cheapest and Best Value, and hides My Times without hour windows", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([cheapBad(), offer(200)]) }) });
    const res = await runSearch(deps, req());
    expect(cardOf(res.cards, "cheapest")?.offer.priceAmount).toBe(100);
    expect(cardOf(res.cards, "best_value")?.offer.priceAmount).toBe(200);
    expect(kindsOf(res.cards)).not.toContain("my_times");
  });

  it("adds My Times when hour windows are set: the cheapest offer inside both windows", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([cheapBad(), offer(200)]) }) });
    const res = await runSearch(deps, req({ outHours: [7, 12], retHours: [15, 23] }));
    const mine = cardOf(res.cards, "my_times");
    expect(mine?.offer.priceAmount).toBe(200);
    expect(mine?.kinds).toEqual(["best_value", "my_times"]); // same offer, shown once with two tags
  });

  it("shows one offer once when it wins everything", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]) }) });
    const res = await runSearch(deps, req());
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.kinds).toEqual(["cheapest", "best_value"]);
  });

  it("returns no cards (not an error) when Travelpayouts has no fares", async () => {
    const { deps } = setup({ tp: mockTp() });
    const res = await runSearch(deps, req());
    expect(res.cards).toEqual([]);
    expect(res.meta.sources[0]).toMatchObject({ ok: true, error: null, offers: 0 });
  });

  it("drops fares outside the window or the stay range", async () => {
    const outside = offer(50, { departDate: "2026-11-21", returnDate: "2026-11-28" }); // return after windowEnd
    const tooLong = offer(60, { departDate: "2026-11-10", returnDate: "2026-11-20" }); // 10 nights
    const { deps } = setup({ tp: mockTp({ rt: rtFor([outside, tooLong, offer(200)]) }) });
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.offer.priceAmount).toBe(200);
    expect(res.meta.sources[0]?.offers).toBe(1);
  });
});

describe("bag extras (SPEC §4.1, §16)", () => {
  const lowcost = () => offer(100, { outbound: leg({ departTime: "06:00", airlines: ["W6"] }), inbound: leg({ departTime: "20:00", airlines: ["W6"] }) });
  const full = () => offer(150, { includes: { checkedBag: true } });

  it("no bag selected: an included bag is a bonus tag and never changes the ranking", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([lowcost(), full()]) }) });
    const res = await runSearch(deps, req());
    expect(cardOf(res.cards, "cheapest")?.offer.priceAmount).toBe(100);
    const all = res.cards.map((c) => c.offer);
    expect(all.every((o) => o.extrasAmountIls === 0)).toBe(true);
  });

  it("no bag selected: the offer that includes a bag is tagged 🎁 and ranked on its base price", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([full(), offer(300)]) }) });
    const res = await runSearch(deps, req());
    const top = cardOf(res.cards, "cheapest");
    expect(top?.offer.tags).toContain("bonus_checked_bag");
    expect(top?.offer.totalIls).toBe(450);
  });

  it("23kg bag selected: low-cost fares are ranked on fare + bag fee", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([lowcost(), full()]) }) });
    const res = await runSearch(deps, req({ checkedBag: true }));
    const cheapest = cardOf(res.cards, "cheapest");
    expect(cheapest?.offer.includes.checkedBag).toBe(true);
    expect(cheapest?.offer.totalIls).toBe(450);

    // 2 legs x EUR 45 x 3.5 = 315 ILS on top of USD 100 x 3
    const alone = await runSearch(setup({ tp: mockTp({ rt: rtFor([lowcost()]) }) }).deps, req({ checkedBag: true }));
    expect(alone.cards[0]?.offer).toMatchObject({ extrasAmountIls: 315, totalIls: 615 });
  });

  it("an unknown airline is tagged, never guessed", async () => {
    const o = offer(100, { outbound: leg({ airlines: ["ZZ"] }), inbound: leg({ airlines: ["ZZ"] }) });
    const { deps } = setup({ tp: mockTp({ rt: rtFor([o]) }) });
    const res = await runSearch(deps, req({ checkedBag: true }));
    expect(res.cards[0]?.offer.tags).toContain("bag_fee_unknown");
    expect(res.cards[0]?.offer.extrasAmountIls).toBe(0);
  });

  it("a different bag choice on cached data re-ranks correctly with zero Travelpayouts calls", async () => {
    const tp = mockTp({ rt: rtFor([lowcost(), full()]) });
    const { deps } = setup({ tp });
    const first = await runSearch(deps, req({ checkedBag: false }));
    expect(cardOf(first.cards, "cheapest")?.offer.priceAmount).toBe(100);
    const callsAfterFirst = tp.callCount();

    const second = await runSearch(deps, req({ checkedBag: true }));
    expect(second.meta.fromCache).toBe(true);
    expect(tp.callCount()).toBe(callsAfterFirst);
    expect(cardOf(second.cards, "cheapest")?.offer.priceAmount).toBe(150);
    expect(cardOf(second.cards, "cheapest")?.offer.totalIls).toBe(450);

    // ...and back again: the cache holds RAW offers, nothing from the checked-bag run leaked into it.
    const third = await runSearch(deps, req({ checkedBag: false }));
    expect(cardOf(third.cards, "cheapest")?.offer.priceAmount).toBe(100);
    expect(cardOf(third.cards, "cheapest")?.offer.extrasAmountIls).toBe(0);
  });

  it("re-applies hour windows to cached data (the 🎯 card appears without a rescan)", async () => {
    const tp = mockTp({ rt: rtFor([offer(200), offer(120, { outbound: leg({ departTime: "02:00" }) })]) });
    const { deps } = setup({ tp });
    const plain = await runSearch(deps, req());
    expect(kindsOf(plain.cards)).not.toContain("my_times");
    const timed = await runSearch(deps, req({ outHours: [7, 12] }));
    expect(timed.meta.fromCache).toBe(true);
    expect(cardOf(timed.cards, "my_times")?.offer.priceAmount).toBe(200);
  });
});

describe("currency (SPEC §4.2)", () => {
  it("keeps the original USD amount everywhere (cards, D1 history, D1 cache) and derives ILS per request", async () => {
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }) });
    const res = await runSearch(deps, req());
    const o = res.cards[0]?.offer;
    expect(o).toMatchObject({ priceAmount: 164, priceCurrency: "USD", totalIls: 492 });

    const prices = await rows<{ price_amount: number; price_currency: string }>(db, "SELECT price_amount, price_currency FROM prices");
    expect(prices).toEqual([{ price_amount: 164, price_currency: "USD" }]);
    const cache = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    const cached = JSON.parse(cache[0]?.offers_json ?? "[]") as Offer[];
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({ priceAmount: 164, priceCurrency: "USD", totalIls: null, extrasAmountIls: 0, tags: [] });
    expect(res.meta).toMatchObject({ fxSource: "test", fxDate: "2026-11-01" });
  });

  it("offers in a currency without an FX rate are skipped, not guessed", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(1000, { priceCurrency: "XXX" }), offer(200)]) }) });
    const res = await runSearch(deps, req());
    expect(res.cards.map((c) => c.offer.priceAmount)).toEqual([200]);
  });
});

describe("cache (SPEC §7 step 2, §16)", () => {
  it("the same search twice within 6h: the second is served from D1 with zero Travelpayouts calls", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const { db, repo, fx, deps } = setup({ tp });
    await repo.saveFxRates(FX);
    const first = await runSearch(deps, req());
    expect(first.meta.fromCache).toBe(false);
    const calls = tp.callCount();
    expect(calls).toBeGreaterThan(0);

    const second = await runSearch({ ...deps, now: new Date(NOW.getTime() + 5 * HOUR + 59 * 60_000) }, req());
    expect(second.meta.fromCache).toBe(true);
    expect(tp.callCount()).toBe(calls);
    expect(fx).toHaveBeenCalledTimes(1); // stored rates are used, the loader is not asked again
    expect(second.cards.map((c) => c.offer.priceAmount)).toEqual(first.cards.map((c) => c.offer.priceAmount));
    expect(second.meta.sources[0]).toMatchObject({ ok: true, calls: 0, error: null });
    // A cache hit adds no price history (only fresh scans feed it) but still records the search.
    expect(await count(db, "prices")).toBe(1);
    expect(await count(db, "searches")).toBe(2);
  });

  it("after 6h the cache is stale and a fresh scan runs", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const { deps } = setup({ tp });
    await runSearch(deps, req());
    const calls = tp.callCount();
    const later = await runSearch({ ...deps, now: new Date(NOW.getTime() + 6 * HOUR + 1000) }, req());
    expect(later.meta.fromCache).toBe(false);
    expect(tp.callCount()).toBeGreaterThan(calls);
  });

  it("uses yesterday's stored rates on a cache hit rather than calling out when the UTC day rolls over", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const late = new Date("2026-11-01T22:00:00.000Z");
    const { repo, fx, deps } = setup({ tp, now: late });
    await runSearch(deps, req());
    await repo.saveFxRates(FX); // dated 2026-11-01
    const nextDay = new Date("2026-11-02T01:00:00.000Z");
    const res = await runSearch({ ...deps, now: nextDay }, req());
    expect(res.meta.fromCache).toBe(true);
    expect(res.meta.fxDate).toBe("2026-11-01");
    expect(fx).toHaveBeenCalledTimes(1);
  });

  it("does not serve a cached result for a different party size", async () => {
    const tp = mockTp({ rt: rtFor([offer(100)]) });
    const { deps } = setup({ tp });
    await runSearch(deps, req({ adults: 1 }));
    const two = await runSearch(deps, req({ adults: 2 }));
    expect(two.meta.fromCache).toBe(false);
  });

  it("treats a corrupt cache row as a miss and replaces it", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const { repo, deps } = setup({ tp });
    const key = await computeSearchKey(req());
    await repo.putCachedOffers(key, [{ bogus: true }, { priceAmount: "x" }] as unknown as Offer[], NOW);
    const res = await runSearch(deps, req());
    expect(res.meta.fromCache).toBe(false);
    expect(res.cards).toHaveLength(1);
    expect((await repo.getCachedOffers(key, 6, NOW))?.offers).toHaveLength(1);
  });

  it("does not cache a failed scan or an unconfigured source", async () => {
    const tp = mockTp({ rt: () => { throw new TravelpayoutsError("HTTP 500: boom", 500); } });
    const failing = setup({ tp });
    await failing.repo.savePrices([offer(100, { checkedAt: ago(HOUR) })]);
    await runSearch(failing.deps, req());
    expect(await count(failing.db, "search_cache")).toBe(0);

    const unconfigured = setup({ tp: mockTp({ configured: false }) });
    await unconfigured.repo.savePrices([offer(100, { checkedAt: ago(HOUR) })]);
    await runSearch(unconfigured.deps, req());
    expect(await count(unconfigured.db, "search_cache")).toBe(0);
  });

  it("caches a scan that succeeded but found nothing: repeating it makes no external call (SPEC §16)", async () => {
    const tp = mockTp();
    const { db, repo, deps } = setup({ tp });
    await repo.saveFxRates(FX);
    const first = await runSearch(deps, req());
    expect(first.cards).toEqual([]);
    expect(first.meta.fromCache).toBe(false);
    const calls = tp.callCount();
    expect(calls).toBeGreaterThan(0);
    expect(await count(db, "search_cache")).toBe(1);

    const second = await runSearch({ ...deps, now: new Date(NOW.getTime() + 30 * 60_000) }, req());
    expect(second.cards).toEqual([]);
    expect(second.meta.fromCache).toBe(true);
    expect(tp.callCount()).toBe(calls);
    expect(second.meta.sources[0]).toMatchObject({ ok: true, calls: 0, offers: 0, error: null });
  });

  it("trusts an empty scan for a shorter time than a full one: fares may appear", async () => {
    const tp = mockTp();
    const { repo, deps } = setup({ tp });
    await repo.saveFxRates(FX);
    await runSearch(deps, req());
    const calls = tp.callCount();
    const later = await runSearch({ ...deps, now: new Date(NOW.getTime() + EMPTY_RESULT_TTL_HOURS * HOUR + 1000) }, req());
    expect(later.meta.fromCache).toBe(false);
    expect(tp.callCount()).toBeGreaterThan(calls);
  });

  it("an empty cache row that carries no scan marker (no one-way list) is still a miss", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const { repo, deps } = setup({ tp });
    await repo.putCachedOffers(await computeSearchKey(req()), [], NOW);
    const res = await runSearch(deps, req());
    expect(res.meta.fromCache).toBe(false);
    expect(res.cards).toHaveLength(1);
  });

  it("a cache row from before the one-way fares were stored still serves its offers", async () => {
    const tp = mockTp();
    const { repo, deps } = setup({ tp });
    await repo.putCachedOffers(await computeSearchKey(req()), [offer(100)], NOW);
    const res = await runSearch(deps, req());
    expect(res.meta.fromCache).toBe(true);
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
    expect(tp.callCount()).toBe(0);
  });

  it("a truncated scan keeps its warning on cache hits (the gap does not vanish for 6 hours)", async () => {
    const tp = mockTp({ rt: (o, d) => (o === "LHR" && d === "CDG" ? [offer(100, { origin: "LHR", destination: "CDG" })] : []) });
    const { repo, deps } = setup({ tp });
    await repo.saveFxRates(FX);
    const wide = req({ origin: "LON", destination: "PAR", windowEnd: "2027-01-05", stayMin: 5, stayMax: 7 });
    const first = await runSearch(deps, wide);
    const note = first.meta.sources[0]?.error;
    expect(note).toMatch(/^truncated: \d+ of \d+ planned requests skipped/);
    const calls = tp.callCount();

    const second = await runSearch(deps, wide);
    expect(second.meta.fromCache).toBe(true);
    expect(tp.callCount()).toBe(calls);
    expect(second.meta.sources[0]).toMatchObject({ ok: true, calls: 0, error: note });
  });

  it("a complete scan has no warning on a hit either", async () => {
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }) });
    await repo.saveFxRates(FX);
    await runSearch(deps, req());
    expect((await runSearch(deps, req())).meta.sources[0]?.error).toBeNull();
  });
});

describe("split tickets (SPEC §7 layer 3, §16)", () => {
  const ow = (o: string) => (o === "TLV" ? [fare("2026-11-12", 60)] : [fare("2026-11-18", 70, { leg: leg({ airlines: ["FR"], departTime: "19:00" }) })]);

  it("a split cheaper than every round trip becomes Cheapest and shows what it saves", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(200)]), ow: (o, d) => (o === "TLV" && d === "BCN" ? ow("TLV") : o === "BCN" && d === "TLV" ? ow("BCN") : []) }) });
    const res = await runSearch(deps, req());
    const cheapest = cardOf(res.cards, "cheapest");
    expect(cheapest?.offer.ticketStructure).toBe("split");
    expect(cheapest?.offer.priceAmount).toBe(130);
    expect(cheapest?.savingsVsRoundtripIls).toBe(210); // (200 - 130) USD x 3
  });

  it("scales split fares to the whole party like round trips", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(200)]), ow: (o, d) => (o === "TLV" && d === "BCN" ? ow("TLV") : o === "BCN" && d === "TLV" ? ow("BCN") : []) }) });
    const res = await runSearch(deps, req({ adults: 2 }));
    const cheapest = cardOf(res.cards, "cheapest");
    expect(cheapest?.offer.priceAmount).toBe(260);
    expect(cheapest?.offer.totalIls).toBe(780);
    expect(cheapest?.savingsVsRoundtripIls).toBe(420);
  });

  it("a split that is not cheaper shows no savings", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]), ow: (o) => (o === "TLV" ? [fare("2026-11-12", 60)] : [fare("2026-11-18", 70)]) }) });
    const res = await runSearch(deps, req());
    expect(cardOf(res.cards, "cheapest")?.offer.ticketStructure).toBe("roundtrip");
    expect(res.cards.every((c) => c.savingsVsRoundtripIls === null)).toBe(true);
  });
});

describe("buildSplits", () => {
  const r = req();
  const build = (outs: OneWayFare[], backs: OneWayFare[], request: SearchRequest = r, fx: FxRates = FX, scale = 1) =>
    buildSplits("TLV", "BCN", request, outs, backs, "travelpayouts", fx, scale, NOW.toISOString());

  it("combines the cheapest one-way per day for every valid date pair", () => {
    const outs = [fare("2026-11-12", 90), fare("2026-11-12", 60), fare("2026-11-13", 70)];
    const backs = [fare("2026-11-18", 80), fare("2026-11-18", 70), fare("2026-11-19", 75), fare("2026-11-20", 50)];
    const byPair = new Map(build(outs, backs).map((s) => [`${s.departDate}>${s.returnDate}`, s.priceAmount]));
    expect(Object.fromEntries(byPair)).toEqual({
      "2026-11-12>2026-11-18": 130, // 60 + 70
      "2026-11-12>2026-11-19": 135, // 60 + 75
      "2026-11-13>2026-11-18": 140, // 70 + 70
      "2026-11-13>2026-11-19": 145,
      "2026-11-13>2026-11-20": 120, // 70 + 50
    });
  });

  it("only builds pairs inside the stay range", () => {
    const outs = [fare("2026-11-12", 60)];
    const backs = [fare("2026-11-16", 10), fare("2026-11-18", 70), fare("2026-11-20", 10)]; // 4, 6 and 8 nights
    const pairs = build(outs, backs).map((s) => s.returnDate);
    expect(pairs).toEqual(["2026-11-18"]);
  });

  it("normalises mixed currencies through ILS and says so", () => {
    const [s] = build([fare("2026-11-12", 60)], [fare("2026-11-18", 100, { priceCurrency: "EUR" })], r, FX, 2);
    expect(s).toMatchObject({ priceCurrency: "ILS", priceAmount: (60 * 3 + 100 * 3.5) * 2, ticketStructure: "split", source: "travelpayouts" });
  });

  it("keeps the same currency when both legs share it, scaled to the party", () => {
    const [s] = build([fare("2026-11-12", 60)], [fare("2026-11-18", 70)], r, FX, 3);
    expect(s).toMatchObject({ priceCurrency: "USD", priceAmount: 390 });
  });

  it("compares fares across currencies when choosing the cheapest of a day", () => {
    // EUR 50 = 175 ILS beats USD 60 = 180 ILS
    const [s] = build([fare("2026-11-12", 60), fare("2026-11-12", 50, { priceCurrency: "EUR" })], [fare("2026-11-18", 70)]);
    expect(s?.priceCurrency).toBe("ILS");
    expect(s?.priceAmount).toBe(175 + 210);
  });

  it("adds a variant inside the preferred hour windows next to the overall cheapest", () => {
    const outs = [fare("2026-11-12", 50, { leg: leg({ departTime: "05:00", airlines: ["W6"] }) }), fare("2026-11-12", 65, { leg: leg({ departTime: "09:00", airlines: ["W6"] }) })];
    const backs = [fare("2026-11-18", 70, { leg: leg({ departTime: "19:00", airlines: ["FR"] }) })];
    expect(build(outs, backs).map((s) => s.priceAmount)).toEqual([120]);
    const timed = build(outs, backs, req({ outHours: [7, 12] }));
    expect(timed.map((s) => s.priceAmount).sort((a, b) => a - b)).toEqual([120, 135]);
    expect(timed.find((s) => s.priceAmount === 135)?.outbound.departTime).toBe("09:00");
  });

  it("does not duplicate the variant when the cheapest legs already fit the windows", () => {
    const outs = [fare("2026-11-12", 50, { leg: leg({ departTime: "09:00" }) })];
    const backs = [fare("2026-11-18", 70, { leg: leg({ departTime: "19:00" }) })];
    expect(build(outs, backs, req({ outHours: [7, 12], retHours: [15, 23] }))).toHaveLength(1);
  });

  it("skips fares whose currency has no rate", () => {
    expect(build([fare("2026-11-12", 60, { priceCurrency: "XXX" })], [fare("2026-11-18", 70)])).toEqual([]);
  });

  it("returns nothing when one direction is missing", () => {
    expect(build([fare("2026-11-12", 60)], [])).toEqual([]);
    expect(build([], [fare("2026-11-18", 60)])).toEqual([]);
  });

  it("does not share leg objects with its inputs", () => {
    const out = fare("2026-11-12", 60);
    const [s] = build([out], [fare("2026-11-18", 70)]);
    s?.outbound.airlines.push("ZZ");
    expect(out.leg.airlines).toEqual(["W6"]);
  });
});

describe("date-pair helpers", () => {
  it("validPairs mirrors Python's valid_pairs", () => {
    const pairs = validPairs(req({ windowStart: "2026-11-10", windowEnd: "2026-11-16", stayMin: 5, stayMax: 6 }));
    expect(pairs).toEqual([["2026-11-10", "2026-11-15"], ["2026-11-10", "2026-11-16"], ["2026-11-11", "2026-11-16"]]);
  });

  it("countValidPairs agrees with validPairs", () => {
    for (const [ws, we, a, b] of [["2026-11-10", "2026-11-25", 5, 7], ["2026-11-10", "2026-12-31", 1, 3], ["2026-02-20", "2026-03-05", 2, 30], ["2026-11-10", "2026-11-11", 1, 1]] as const) {
      expect(countValidPairs(ws, we, a, b)).toBe(validPairs({ windowStart: ws, windowEnd: we, stayMin: a, stayMax: b }).length);
    }
  });

  it("pairOk checks window and stay range on real calendar dates", () => {
    const w = req();
    expect(pairOk(w, "2026-11-12", "2026-11-18")).toBe(true);
    expect(pairOk(w, "2026-11-09", "2026-11-15")).toBe(false); // before the window
    expect(pairOk(w, "2026-11-20", "2026-11-26")).toBe(false); // after the window
    expect(pairOk(w, "2026-11-12", "2026-11-16")).toBe(false); // 4 nights
    expect(pairOk(w, "2026-02-30", "2026-03-05")).toBe(false); // not a real date
  });
});

describe("failure handling (SPEC §6 source reliability)", () => {
  it("Travelpayouts unconfigured and nothing stored: a typed source_unavailable error", async () => {
    const { deps } = setup({ tp: mockTp({ configured: false }) });
    await expect(runSearch(deps, req())).rejects.toMatchObject({ name: "PipelineError", code: "source_unavailable" });
    await expect(runSearch(deps, req())).rejects.toBeInstanceOf(PipelineError);
  });

  it("Travelpayouts unconfigured but recent fares stored: serves them and shows the failure in sources", async () => {
    const { repo, deps } = setup({ tp: mockTp({ configured: false }) });
    await repo.savePrices([offer(100, { checkedAt: ago(2 * HOUR) })]);
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
    expect(res.meta.fromCache).toBe(false);
    expect(res.meta.sources[0]).toMatchObject({ name: "travelpayouts", enabled: false, ok: false, calls: 0 });
    expect(res.meta.sources[0]?.error).toBeTruthy();
  });

  it("Travelpayouts failing: serves stored fares, reports a safe error, records health, caches nothing", async () => {
    const tp = mockTp({ rt: () => { throw new TravelpayoutsError('HTTP 500: {"echo":"UPSTREAM-BODY-SECRET"}', 500); } });
    const { db, repo, deps } = setup({ tp });
    await repo.savePrices([offer(100, { checkedAt: ago(2 * HOUR) })]);
    const res = await runSearch(deps, req());
    expect(res.cards).toHaveLength(1);
    const status = res.meta.sources[0];
    expect(status).toMatchObject({ ok: false });
    expect(status?.error).toBe("Travelpayouts: HTTP 500");
    expect(JSON.stringify(res)).not.toContain("UPSTREAM-BODY-SECRET");
    const health = await rows<{ source: string; consecutive_failures: number }>(db, "SELECT source, consecutive_failures FROM source_health");
    expect(health).toEqual([{ source: "travelpayouts", consecutive_failures: 1 }]);
    expect(await count(db, "search_cache")).toBe(0);
  });

  it("does not leak details of foreign errors", async () => {
    const tp = mockTp({ rt: () => { throw new Error("token=abc123 exploded"); } });
    const { repo, deps } = setup({ tp });
    await repo.savePrices([offer(100, { checkedAt: ago(HOUR) })]);
    const res = await runSearch(deps, req());
    expect(res.meta.sources[0]?.error).toBe("Travelpayouts: unexpected error");
  });

  it("stops scanning after an authentication failure instead of burning the budget", async () => {
    const tp = mockTp({ rt: () => { throw new TravelpayoutsError("HTTP 401: nope", 401); } });
    const { repo, deps } = setup({ tp, });
    await repo.savePrices([offer(100, { checkedAt: ago(HOUR) })]);
    await runSearch(deps, req({ nearbyAirports: true }));
    expect(tp.log).toEqual(["rt:TLV-BCN"]);
  });

  it("a partial failure keeps what worked, reports it and does not cache the incomplete result", async () => {
    const tp = mockTp({
      rt: rtFor([offer(164)]),
      ow: () => { throw new TravelpayoutsError("network error: reset", null); },
    });
    const { db, deps } = setup({ tp });
    const res = await runSearch(deps, req());
    expect(res.cards).toHaveLength(1);
    expect(res.meta.sources[0]).toMatchObject({ ok: false, error: "Travelpayouts: network error" });
    expect(await count(db, "search_cache")).toBe(0);
    const [h] = await rows<{ consecutive_failures: number }>(db, "SELECT consecutive_failures FROM source_health WHERE source = 'travelpayouts'");
    expect(h?.consecutive_failures).toBe(1);
  });

  it("a pair Travelpayouts rejects with HTTP 400 is a note, not a failure: the sibling airport still answers", async () => {
    // Eilat has two airports in the bundled table; Aviasales serves Ramon (ETM) but answers 400 for Ovda (VDA).
    const tp = mockTp({
      rt: (o) => {
        if (o === "VDA") throw new TravelpayoutsError("HTTP 400: bad request", 400);
        return o === "ETM" ? [offer(120, { origin: "ETM" })] : [];
      },
    });
    const { deps } = setup({ tp });
    const res = await runSearch(deps, req({ origin: "ETM" }));
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.offer.origin).toBe("ETM");
    expect(res.meta.sources[0]).toMatchObject({ ok: true });
    expect(res.meta.sources[0]?.error).toContain("not searchable at Travelpayouts: VDA-BCN");
  });

  it("when every pair is rejected with HTTP 400 the answer is an empty result, not source_unavailable", async () => {
    const tp = mockTp({ rt: () => { throw new TravelpayoutsError("HTTP 400: bad request", 400); } });
    const { deps } = setup({ tp });
    const res = await runSearch(deps, req());
    expect(res.cards).toEqual([]);
    expect(res.meta.sources[0]).toMatchObject({ ok: true });
    expect(res.meta.sources[0]?.error).toContain("not searchable at Travelpayouts");
  });

  it("carries the contract version", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }) });
    expect((await runSearch(deps, req())).meta.apiVersion).toBe(1);
  });

  it("records a healthy source after a successful scan", async () => {
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }) });
    await runSearch(deps, req());
    const [h] = await rows<{ last_ok_at: string; consecutive_failures: number }>(db, "SELECT last_ok_at, consecutive_failures FROM source_health");
    expect(h).toMatchObject({ last_ok_at: NOW.toISOString(), consecutive_failures: 0 });
  });

  it("fails with fx_unavailable when no exchange rate can be had", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), fx: async () => { throw new Error("no rates"); } });
    await expect(runSearch(deps, req())).rejects.toMatchObject({ code: "fx_unavailable" });
  });

  it("accepts plain FxRates instead of a loader", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), fx: FX });
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.offer.totalIls).toBe(492);
  });

  it("a broken database never fails the search itself", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const { repo, deps } = setup({ tp });
    const broken = new Proxy(repo, { get: () => async () => { throw new Error("D1 down"); } });
    const res = await runSearch({ ...deps, repo: broken }, req());
    expect(res.cards).toHaveLength(1);
  });

  it("stored rows older than the fallback age are not served", async () => {
    const { repo, deps } = setup({ tp: mockTp({ configured: false }) });
    await repo.savePrices([offer(100, { checkedAt: ago(FALLBACK_MAX_AGE_HOURS * HOUR + 1000) })]);
    await expect(runSearch(deps, req())).rejects.toMatchObject({ code: "source_unavailable" });
  });
});

describe("airports, nearby airports and the request budget (SPEC §7 step 1)", () => {
  it("expands a city to all its airports and orders pairs primary-first", () => {
    const pairs = airportPairs(defaultResolver, req({ origin: "LON", destination: "PAR" }));
    expect(pairs).toHaveLength(18);
    expect(pairs[0]).toEqual({ origin: "LHR", dest: "CDG" });
    expect(new Set(pairs.map((p) => `${p.origin}-${p.dest}`)).size).toBe(18);
  });

  it("adds nearby airports only when asked", () => {
    expect(airportPairs(defaultResolver, req()).map((p) => p.dest)).toEqual(["BCN"]);
    expect(airportPairs(defaultResolver, req({ nearbyAirports: true })).map((p) => p.dest)).toEqual(["BCN", "GRO", "REU"]);
  });

  it("an airport code searches just that airport", () => {
    expect(airportPairs(defaultResolver, req({ origin: "LHR", destination: "CDG" }))).toEqual([{ origin: "LHR", dest: "CDG" }]);
  });

  it("an unknown code is passed through rather than dropped", () => {
    expect(airportPairs(defaultResolver, req({ destination: "zzz" }))).toEqual([{ origin: "TLV", dest: "ZZZ" }]);
  });

  it("scans nearby airports when enabled", async () => {
    const tp = mockTp();
    const { deps } = setup({ tp });
    await runSearch(deps, req({ nearbyAirports: true }));
    expect(tp.log).toContain("rt:TLV-GRO");
    expect(tp.log).toContain("rt:TLV-REU");
    const off = mockTp();
    await runSearch(setup({ tp: off }).deps, req());
    expect(off.log).toEqual(["rt:TLV-BCN", "ow:TLV-BCN", "ow:BCN-TLV"]);
  });

  it("caps outgoing Travelpayouts requests, primary round trips first, and reports the truncation", async () => {
    const tp = mockTp();
    const { deps } = setup({ tp });
    // Nov 10 - Jan 5 spans 3 months: 6 round-trip + 6 one-way requests per airport pair, 18 pairs.
    const res = await runSearch(deps, req({ origin: "LON", destination: "PAR", windowEnd: "2027-01-05", stayMin: 5, stayMax: 7 }));
    expect(tp.callCount()).toBeLessThanOrEqual(MAX_TP_REQUESTS);
    expect(res.meta.sources[0]?.calls).toBe(tp.callCount());
    expect(tp.log.slice(0, 4)).toEqual(["rt:LHR-CDG", "ow:LHR-CDG", "ow:CDG-LHR", "rt:LHR-ORY"]);
    expect(res.meta.sources[0]?.ok).toBe(true);
    expect(res.meta.sources[0]?.error).toMatch(/^truncated: \d+ of \d+ planned requests skipped \(limit 30\)$/);
  });

  it("the primary pair always fits, even for a five-month window", async () => {
    const tp = mockTp();
    const { deps } = setup({ tp });
    const res = await runSearch(deps, req({ windowStart: "2026-11-10", windowEnd: "2027-03-09", nearbyAirports: true, stayMin: 3, stayMax: 3 }));
    expect(tp.log).toEqual(["rt:TLV-BCN", "ow:TLV-BCN", "ow:BCN-TLV"]);
    expect(tp.callCount()).toBe(25);
    expect(res.meta.sources[0]?.error).toMatch(/truncated/);
  });

  it("does not report truncation when everything fit", async () => {
    const { deps } = setup({ tp: mockTp() });
    const res = await runSearch(deps, req());
    expect(res.meta.sources[0]?.error).toBeNull();
  });
});

describe("merge with the shared DB (SPEC §7 step 6)", () => {
  it("merges recent google_flights enrichment: it can win a card and is counted in sources", async () => {
    const tp = mockTp({ rt: rtFor([offer(100)]) });
    const { db, repo, deps } = setup({ tp });
    await repo.savePrices([offer(80, { source: "google_flights", checkedAt: ago(2 * HOUR), deeplink: "https://www.aviasales.com/gf" })]);
    const res = await runSearch(deps, req());
    const cheapest = cardOf(res.cards, "cheapest");
    expect(cheapest?.offer.source).toBe("google_flights");
    expect(cheapest?.offer.totalIls).toBe(240);
    expect(cheapest?.ageHours).toBe(2);
    expect(res.meta.sources[1]).toMatchObject({ name: "google_flights", ok: true, offers: 1, calls: 0 });
    expect(tp.callCount()).toBeGreaterThan(0); // Travelpayouts was still scanned
    // the enrichment row is not written back as a duplicate
    expect(await rows(db, "SELECT id FROM prices WHERE source = 'google_flights'")).toHaveLength(1);
  });

  it("enrichment also applies on a cache hit", async () => {
    const tp = mockTp({ rt: rtFor([offer(100)]) });
    const { repo, deps } = setup({ tp });
    await runSearch(deps, req());
    await repo.savePrices([offer(70, { source: "google_flights", checkedAt: ago(HOUR) })]);
    const res = await runSearch(deps, req());
    expect(res.meta.fromCache).toBe(true);
    expect(cardOf(res.cards, "cheapest")?.offer.source).toBe("google_flights");
  });

  it("a healthy scan is not mixed with our own older saved Travelpayouts fares", async () => {
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]) }) });
    await repo.savePrices([offer(50, { checkedAt: ago(2 * HOUR) })]); // an earlier search's history row
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
    expect(res.cards).toHaveLength(1);
  });

  it("ignores enrichment older than two monitor runs", async () => {
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]) }) });
    await repo.savePrices([offer(10, { source: "google_flights", checkedAt: ago(13 * HOUR) })]);
    const res = await runSearch(deps, req());
    expect(cardOf(res.cards, "cheapest")?.offer.source).toBe("travelpayouts");
    expect(res.meta.sources[1]).toMatchObject({ ok: false, offers: 0 });
  });

  it("stored fares are per passenger and scaled to the party", async () => {
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(500)]) }) });
    await repo.savePrices([offer(80, { source: "google_flights", checkedAt: ago(HOUR) })]);
    const res = await runSearch(deps, req({ adults: 2 }));
    const cheapest = cardOf(res.cards, "cheapest");
    expect(cheapest?.offer).toMatchObject({ source: "google_flights", priceAmount: 160, totalIls: 480 });
  });

  it("only the newest snapshot of a flight counts in fallback mode", async () => {
    const { repo, deps } = setup({ tp: mockTp({ configured: false }) });
    await repo.savePrices([offer(300, { checkedAt: ago(10 * HOUR) }), offer(100, { checkedAt: ago(HOUR) })]);
    const res = await runSearch(deps, req());
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
  });
});

describe("persistence (SPEC §7 step 9)", () => {
  it("saves the search, per-passenger price history and the raw cache", async () => {
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]) }) });
    await runSearch(deps, req({ adults: 2 }));
    const searches = await rows<{ origin: string; destination: string; pax_json: string }>(db, "SELECT origin, destination, pax_json FROM searches");
    expect(searches).toHaveLength(1);
    expect(JSON.parse(searches[0]?.pax_json ?? "{}")).toEqual({ adults: 2, children: 0, infants: 0 });

    const prices = await rows<{ price_amount: number }>(db, "SELECT price_amount FROM prices");
    expect(prices.map((p) => p.price_amount)).toEqual([100]); // per passenger, not the party's 200
    const cache = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    expect((JSON.parse(cache[0]?.offers_json ?? "[]") as Offer[])[0]?.priceAmount).toBe(200); // whole party
  });

  it("history keeps only the cheapest fare per date pair, source and structure", async () => {
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor([offer(100), offer(120, { outbound: leg({ departTime: "15:00" }) }), offer(90, { departDate: "2026-11-13", returnDate: "2026-11-19" })]) }) });
    await runSearch(deps, req());
    const prices = await rows<{ depart_date: string; price_amount: number }>(db, "SELECT depart_date, price_amount FROM prices ORDER BY depart_date");
    expect(prices).toEqual([{ depart_date: "2026-11-12", price_amount: 100 }, { depart_date: "2026-11-13", price_amount: 90 }]);
    // ...while the cache keeps every offer so ranking can still choose by times and bags
    const cache = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    expect(JSON.parse(cache[0]?.offers_json ?? "[]")).toHaveLength(3);
  });

  it("bounds what it writes: cache and history are capped", async () => {
    const many: Offer[] = [];
    for (let i = 0; i < 1500; i++) {
      const dep = 10 + (i % 12);
      many.push(offer(100 + i, { departDate: `2026-11-${dep}`, returnDate: `2026-11-${dep + 6}`, outbound: leg({ departTime: `${String(i % 24).padStart(2, "0")}:00` }) }));
    }
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor(many) }) });
    await runSearch(deps, req({ windowEnd: "2026-11-30" }));
    const [{ offers_json } = { offers_json: "[]" }] = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    const cached = JSON.parse(offers_json) as Offer[];
    expect(cached.length).toBeLessThanOrEqual(MAX_CACHED_OFFERS);
    expect(cached.length).toBeGreaterThan(0);
    expect(Math.min(...cached.map((o) => o.priceAmount))).toBe(100); // cheapest kept
  });

  it("caps the price history written per search, keeping the cheapest date pairs", async () => {
    const wide = req({ windowEnd: "2027-03-09", stayMin: 5, stayMax: 7 });
    const pairs = validPairs(wide).slice(0, MAX_PERSISTED_PRICES + 100);
    const offers = pairs.map(([dep, ret], i) => offer(100 + i, { departDate: dep, returnDate: ret }));
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor(offers) }) });
    await runSearch(deps, wide);
    expect(await count(db, "prices")).toBe(MAX_PERSISTED_PRICES);
    const [worst] = await rows<{ p: number }>(db, "SELECT MAX(price_amount) AS p FROM prices");
    expect(worst?.p).toBe(100 + MAX_PERSISTED_PRICES - 1);
  });

  it("with waitUntil the writes are handed off and complete afterwards", async () => {
    const pending: Promise<unknown>[] = [];
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), waitUntil: (p) => void pending.push(p) });
    const res = await runSearch(deps, req());
    expect(res.cards).toHaveLength(1);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await count(db, "prices")).toBe(1);
    expect(await count(db, "search_cache")).toBe(1);
    expect(await count(db, "searches")).toBe(1);
  });

  it("the deferred job never rejects, even when storage is down", async () => {
    const pending: Promise<unknown>[] = [];
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), waitUntil: (p) => void pending.push(p) });
    const failingWrites = new Proxy(repo, { get: (t, k) => (k === "saveSearch" || k === "savePrices" || k === "putCachedOffers" || k === "recordSourceHealth" ? async () => { throw new Error("D1 down"); } : Reflect.get(t, k)) });
    await runSearch({ ...deps, repo: failingWrites as typeof repo }, req());
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});

describe("price context and card metadata (SPEC §8)", () => {
  it("attaches history in the original currency, scaled to the party, and the fare's age", async () => {
    const tp = mockTp({ rt: rtFor([offer(100, { checkedAt: ago(90 * 60_000) })]) });
    const { repo, deps } = setup({ tp });
    await repo.savePrices([offer(80, { checkedAt: ago(30 * DAY) }), offer(90, { checkedAt: ago(8 * DAY) })]);
    const res = await runSearch(deps, req({ adults: 2 }));
    const card = res.cards[0];
    expect(card?.ageHours).toBe(1.5);
    expect(card?.priceContext).toEqual({ currency: "USD", weekAgoAmount: 180, lowestAmount: 160 });
  });

  it("has no price context when nothing is known about the pair", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100)]) }) });
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.priceContext).toBeNull();
  });

  it("never reports a negative age", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100, { checkedAt: ago(-HOUR) })]) }) });
    const res = await runSearch(deps, req());
    expect(res.cards[0]?.ageHours).toBe(0);
  });

  it("meta describes the scan: key, sources, candidate pairs, timestamp", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100), offer(110, { departDate: "2026-11-13", returnDate: "2026-11-19" }), offer(120, { departDate: "2026-11-14", returnDate: "2026-11-20" })]) }) });
    const res = await runSearch(deps, req());
    expect(res.meta.searchKey).toBe(await computeSearchKey(req()));
    expect(res.meta.candidatePairs).toBe(3);
    expect(res.meta.generatedAt).toBe(NOW.toISOString());
    expect(res.meta.sources.map((s) => s.name)).toEqual(["travelpayouts", "google_flights"]);
  });

  it("candidate pairs are capped at the configured top N", async () => {
    const offers = Array.from({ length: 9 }, (_, i) => offer(100 + i, { departDate: `2026-11-${10 + i}`, returnDate: `2026-11-${16 + i}` }));
    const { deps } = setup({ tp: mockTp({ rt: rtFor(offers) }) });
    const res = await runSearch(deps, req({ windowEnd: "2026-11-30" }));
    expect(res.meta.candidatePairs).toBe(SCORING.topNCandidates);
  });
});

describe("sanitizeOffers", () => {
  it("keeps well-formed offers, resets derived fields and drops malformed ones", () => {
    const good = { ...offer(100), totalIls: 999, extrasAmountIls: 5, tags: ["bonus_checked_bag"] };
    const out = sanitizeOffers([good, null, 3, { ...offer(100), priceAmount: -1 }, { ...offer(100), source: "evil" }, { ...offer(100), outbound: null }, { ...offer(100), checkedAt: "nope" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ priceAmount: 100, totalIls: null, extrasAmountIls: 0, tags: [] });
    expect(sanitizeOffers("nope")).toEqual([]);
  });
});

// --- fix pass: split tickets follow the request, links, caps -------------------------------------------------

const OUT_DAY = "2026-11-12";
const BACK_DAY = "2026-11-18"; // 6 nights
const splitFares = (outs: OneWayFare[], backs: OneWayFare[]) => (o: string, d: string) => (o === "TLV" && d === "BCN" ? outs : o === "BCN" && d === "TLV" ? backs : []);
const at = (day: string, price: number, departTime: string, over: Partial<Leg> = {}, extra: Partial<OneWayFare> = {}) =>
  fare(day, price, { leg: leg({ departTime, airlines: ["W6"], ...over }), ...extra });

/** What a caller sees of the cards, without volatile detail. */
const shape = (cards: SearchResponse["cards"]) =>
  cards.map((c) => ({
    kinds: c.kinds,
    savings: c.savingsVsRoundtripIls,
    ageHours: c.ageHours,
    offer: {
      structure: c.offer.ticketStructure,
      dates: [c.offer.departDate, c.offer.returnDate],
      price: [c.offer.priceAmount, c.offer.priceCurrency],
      totalIls: c.offer.totalIls,
      tags: c.offer.tags,
      out: c.offer.outbound,
      back: c.offer.inbound,
      links: [c.offer.deeplink, c.offer.returnDeeplink ?? null],
    },
  }));

/** Small deterministic PRNG (LCG) so the metamorphic tests below are reproducible. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("split tickets are built per request, so the cache answers like a fresh scan", () => {
  const outs = [at(OUT_DAY, 50, "05:00"), at(OUT_DAY, 80, "10:00")];
  const backs = [at(BACK_DAY, 50, "05:30"), at(BACK_DAY, 80, "18:00")];
  const hours = { outHours: [9, 12] as [number, number], retHours: [17, 20] as [number, number] };

  it("hour windows added later still find their 🎯 split (the first searcher no longer decides)", async () => {
    const fresh = await runSearch(setup({ tp: mockTp({ ow: splitFares(outs, backs) }) }).deps, req(hours));
    expect(cardOf(fresh.cards, "my_times")?.offer).toMatchObject({ priceAmount: 160, outbound: { departTime: "10:00" }, inbound: { departTime: "18:00" } });

    const { deps } = setup({ tp: mockTp({ ow: splitFares(outs, backs) }) });
    const plain = await runSearch(deps, req()); // caches the answer without hours
    expect(kindsOf(plain.cards)).not.toContain("my_times");
    const cached = await runSearch(deps, req(hours));
    expect(cached.meta.fromCache).toBe(true);
    expect(cardOf(cached.cards, "my_times")?.offer).toMatchObject({ priceAmount: 160, outbound: { departTime: "10:00" }, inbound: { departTime: "18:00" } });
    expect(shape(cached.cards)).toEqual(shape(fresh.cards));
  });

  it("does not cache the built splits at all, only the fares they are built from", async () => {
    const { db, deps } = setup({ tp: mockTp({ ow: splitFares(outs, backs) }) });
    await runSearch(deps, req());
    const [row] = await rows<{ offers_json: string; extra_json: string }>(db, "SELECT offers_json, extra_json FROM search_cache");
    expect(JSON.parse(row?.offers_json ?? "null")).toEqual([]);
    const extra = JSON.parse(row?.extra_json ?? "null") as { oneWayPairs: OneWayPair[] };
    expect(extra.oneWayPairs).toHaveLength(1);
    expect(extra.oneWayPairs[0]).toMatchObject({ origin: "TLV", destination: "BCN" });
    expect(extra.oneWayPairs[0]?.outs).toHaveLength(2);
    expect(extra.oneWayPairs[0]?.backs).toHaveLength(2);
  });

  it("holds on random data: hours, stops and bag added on top of a cached search answer like a scan of their own", async () => {
    const rnd = prng(20_261_101);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
    const hh = () => `${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
    const randomFares = (days: string[]) =>
      days.flatMap((day) =>
        Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => at(day, 30 + Math.floor(rnd() * 90), hh(), { stops: pick([0, 1, 2, null]), airlines: [pick(["W6", "VY", "FR", "LY", "U2"])] })),
      );
    for (let trial = 0; trial < 40; trial++) {
      const ow = splitFares(randomFares([OUT_DAY, "2026-11-13"]), randomFares([BACK_DAY, "2026-11-19", "2026-11-20"]));
      const rts = rnd() < 0.5 ? [offer(150 + Math.floor(rnd() * 100))] : [];
      const start = Math.floor(rnd() * 20);
      const filtered = req({
        adults: 1 + Math.floor(rnd() * 3),
        outHours: [start, start + 1 + Math.floor(rnd() * 4)],
        retHours: rnd() < 0.5 ? null : [Math.floor(rnd() * 10), 12 + Math.floor(rnd() * 12)],
        maxStops: pick([null, 0, 1]),
        checkedBag: rnd() < 0.5,
      });
      const fresh = await runSearch(setup({ tp: mockTp({ rt: rtFor(rts), ow }) }).deps, filtered);
      const { deps } = setup({ tp: mockTp({ rt: rtFor(rts), ow }) });
      await runSearch(deps, req({ adults: filtered.adults })); // same party, no filters: the cache entry
      const cached = await runSearch(deps, filtered);
      expect(cached.meta.fromCache, `trial ${trial}`).toBe(true);
      expect(shape(cached.cards), `trial ${trial}`).toEqual(shape(fresh.cards));
    }
  });

  it("the 🎯 split must satisfy the stops limit too, not just the hours (the cheapest in-window legs often stop)", async () => {
    const o = [at(OUT_DAY, 50, "10:00", { stops: 1 }), at(OUT_DAY, 70, "10:30", { stops: 0 })];
    const b = [at(BACK_DAY, 50, "10:00", { stops: 1 }), at(BACK_DAY, 70, "10:30", { stops: 0 })];
    const { deps } = setup({ tp: mockTp({ ow: splitFares(o, b) }) });
    const res = await runSearch(deps, req({ outHours: [9, 12], retHours: [9, 12], maxStops: 0 }));
    expect(cardOf(res.cards, "cheapest")?.offer).toMatchObject({ priceAmount: 100, outbound: { stops: 1 } }); // cheapest ignores stops
    const mine = cardOf(res.cards, "my_times");
    expect(mine?.offer).toMatchObject({ ticketStructure: "split", priceAmount: 140, totalIls: 420, outbound: { departTime: "10:30", stops: 0 }, inbound: { departTime: "10:30", stops: 0 } });
  });

  it("a leg with unknown stops cannot satisfy a stops limit", async () => {
    const o = [at(OUT_DAY, 50, "10:00", { stops: null }), at(OUT_DAY, 70, "10:30", { stops: 0 })];
    const b = [at(BACK_DAY, 50, "10:00", { stops: null }), at(BACK_DAY, 70, "10:30", { stops: 0 })];
    const { deps } = setup({ tp: mockTp({ ow: splitFares(o, b) }) });
    const res = await runSearch(deps, req({ outHours: [9, 12], retHours: [9, 12], maxStops: 0 }));
    expect(cardOf(res.cards, "my_times")?.offer).toMatchObject({ priceAmount: 140 });
  });

  it("without a stops limit the 🎯 split is just the cheapest in the hours", async () => {
    const o = [at(OUT_DAY, 50, "10:00", { stops: 1 }), at(OUT_DAY, 70, "10:30", { stops: 0 })];
    const b = [at(BACK_DAY, 50, "10:00", { stops: 1 }), at(BACK_DAY, 70, "10:30", { stops: 0 })];
    const { deps } = setup({ tp: mockTp({ ow: splitFares(o, b) }) });
    const res = await runSearch(deps, req({ outHours: [9, 12], retHours: [9, 12] }));
    expect(res.cards).toHaveLength(1); // the cheapest split already fits every filter, so it carries all the tags
    expect(res.cards[0]?.kinds).toEqual(expect.arrayContaining(["cheapest", "my_times"]));
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
  });

  it("with a checked bag each leg is picked on fare + bag fee (SPEC §4.1), not on the base fare", async () => {
    const w6 = BAG_FEES.W6?.checkedBag;
    const vy = BAG_FEES.VY?.checkedBag;
    expect(w6 && vy && w6.currency === "EUR" && vy.currency === "EUR" && w6.amount > vy.amount).toBe(true); // premise of the scenario
    const o = [at(OUT_DAY, 50, "10:00", {}), at(OUT_DAY, 55, "11:00", { airlines: ["VY"] })];
    const b = [at(BACK_DAY, 50, "10:00", {}), at(BACK_DAY, 55, "11:00", { airlines: ["VY"] })];
    const { deps } = setup({ tp: mockTp({ ow: splitFares(o, b) }) });

    const bag = await runSearch(deps, req({ checkedBag: true }));
    const cheapest = cardOf(bag.cards, "cheapest")?.offer;
    expect(cheapest?.outbound.airlines).toEqual(["VY"]);
    expect(cheapest?.inbound.airlines).toEqual(["VY"]);
    expect(cheapest?.totalIls).toBe(110 * 3 + 2 * vy!.amount * 3.5);
    // The chosen split really is the cheapest of the four combinations once bags are counted.
    const combos = [50, 55].flatMap((x) => [50, 55].map((y) => x * 3 + y * 3 + (x === 50 ? w6!.amount : vy!.amount) * 3.5 + (y === 50 ? w6!.amount : vy!.amount) * 3.5));
    expect(cheapest?.totalIls).toBe(Math.min(...combos));

    const noBag = await runSearch(deps, req({ checkedBag: false })); // from the cache: the bag choice re-picks the legs
    expect(noBag.meta.fromCache).toBe(true);
    expect(cardOf(noBag.cards, "cheapest")?.offer).toMatchObject({ priceAmount: 100, totalIls: 300, outbound: { airlines: ["W6"] } });
  });
});

describe("booking links (SPEC G5)", () => {
  const link = (path: string) => `https://www.aviasales.com/search/${path}?marker=m`;
  const owLinks = splitFares([at(OUT_DAY, 60, "10:00", {}, { deeplink: link("TLV1211BCN1") })], [at(BACK_DAY, 70, "18:00", {}, { deeplink: link("BCN1811TLV1") })]);

  it("a split ticket card carries the outbound AND the return booking link", async () => {
    const { deps } = setup({ tp: mockTp({ ow: owLinks }) });
    const res = await runSearch(deps, req());
    const offer = cardOf(res.cards, "cheapest")?.offer;
    expect(offer?.ticketStructure).toBe("split");
    expect(offer?.deeplink).toBe(link("TLV1211BCN1"));
    expect(offer?.returnDeeplink).toBe(link("BCN1811TLV1"));
  });

  it("links search for the whole party the price is for, not for one adult", async () => {
    const roundTrip = offer(500, { deeplink: "https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=m" });
    const { deps } = setup({ tp: mockTp({ rt: rtFor([roundTrip]), ow: owLinks }) });
    const res = await runSearch(deps, req({ adults: 2, children: 1 }));
    const split = cardOf(res.cards, "cheapest")?.offer;
    expect(split?.priceAmount).toBe(390); // 3 travellers
    expect(split?.deeplink).toBe(link("TLV1211BCN21"));
    expect(split?.returnDeeplink).toBe(link("BCN1811TLV21"));

    const rtOnly = setup({ tp: mockTp({ rt: rtFor([roundTrip]) }) });
    const rt = await runSearch(rtOnly.deps, req({ adults: 2, children: 1, infants: 1 }));
    expect(rt.cards[0]?.offer.deeplink).toBe("https://www.aviasales.com/search/TLV1211BCN1811211?t=W6_example&marker=m");
    expect(rt.cards[0]?.offer).not.toHaveProperty("returnDeeplink");
  });

  it("a cache hit keeps both links and the party", async () => {
    const { repo, deps } = setup({ tp: mockTp({ ow: owLinks }) });
    await repo.saveFxRates(FX);
    await runSearch(deps, req({ adults: 2 }));
    const hit = await runSearch(deps, req({ adults: 2 }));
    expect(hit.meta.fromCache).toBe(true);
    expect(hit.cards[0]?.offer).toMatchObject({ deeplink: link("TLV1211BCN2"), returnDeeplink: link("BCN1811TLV2") });
  });

  it("history rows keep the return link, so a stored split can still be booked when Travelpayouts is down", async () => {
    const first = setup({ tp: mockTp({ ow: owLinks }) });
    await runSearch(first.deps, req());
    const [row] = await rows<{ legs_json: string }>(first.db, "SELECT legs_json FROM prices WHERE ticket_structure = 'split'");
    expect(JSON.parse(row?.legs_json ?? "{}").returnDeeplink).toBe(link("BCN1811TLV1"));

    const down = setup({ tp: mockTp({ configured: false }) });
    await down.repo.savePrices([
      offer(130, { ticketStructure: "split", deeplink: link("TLV1211BCN1"), returnDeeplink: link("BCN1811TLV1"), checkedAt: ago(HOUR) }),
    ]);
    const res = await runSearch(down.deps, req({ adults: 2 }));
    expect(res.cards[0]?.offer).toMatchObject({ deeplink: link("TLV1211BCN2"), returnDeeplink: link("BCN1811TLV2") });
  });

  it("links that are not Aviasales search links are left as they are", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(100, { deeplink: "https://example.com/book?id=7" })]) }) });
    const res = await runSearch(deps, req({ adults: 3 }));
    expect(res.cards[0]?.offer.deeplink).toBe("https://example.com/book?id=7");
  });
});

describe("what is cached is capped, what is ranked is not (SPEC §8)", () => {
  /** Per date pair: cheap night flights that fill the budget, plus one evening flight that matches the user's hours. */
  function busyRoute(): Offer[] {
    const all: Offer[] = [];
    for (const [dep, ret] of validPairs(req({ windowEnd: "2026-12-20" }))) {
      for (let i = 0; i < 12; i++) {
        all.push(offer(100 + i, { departDate: dep, returnDate: ret, outbound: leg({ departTime: `0${i % 6}:00` }), inbound: leg({ departTime: `0${Math.floor(i / 2) % 6}:30` }) }));
      }
      all.push(offer(400, { departDate: dep, returnDate: ret, outbound: leg({ departTime: "19:30" }), inbound: leg({ departTime: "20:30" }) }));
    }
    return all;
  }
  const evening = { outHours: [18, 22] as [number, number], retHours: [18, 22] as [number, number] };

  it("the 🎯 card still exists when there are more offers than the cache holds", async () => {
    const offers = busyRoute();
    expect(offers.length).toBeGreaterThan(MAX_CACHED_OFFERS); // premise: the old global "cheapest 1200" cut drops every evening flight
    const { deps } = setup({ tp: mockTp({ rt: rtFor(offers) }) });
    const res = await runSearch(deps, req({ windowEnd: "2026-12-20", ...evening }));
    expect(res.meta.sources[0]?.offers).toBe(offers.length); // ranking saw everything
    expect(cardOf(res.cards, "my_times")?.offer).toMatchObject({ priceAmount: 400, outbound: { departTime: "19:30" }, inbound: { departTime: "20:30" } });
  });

  it("the cached copy is cut by shape, so it keeps the evening flights and a later hit finds the same 🎯 card", async () => {
    const offers = busyRoute();
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor(offers) }) });
    const wide = req({ windowEnd: "2026-12-20" });
    await runSearch(deps, wide);
    const [row] = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    const cached = JSON.parse(row?.offers_json ?? "[]") as Offer[];
    expect(cached.length).toBeLessThanOrEqual(MAX_CACHED_OFFERS);
    expect(cached.some((o) => o.outbound.departTime === "19:30")).toBe(true);
    expect(Math.min(...cached.map((o) => o.priceAmount))).toBe(100);

    const hit = await runSearch(deps, { ...wide, ...evening });
    expect(hit.meta.fromCache).toBe(true);
    expect(cardOf(hit.cards, "my_times")?.offer).toMatchObject({ priceAmount: 400, outbound: { departTime: "19:30" } });
  });

  it("when even one offer per date pair is too many, the cheapest date pairs are kept", async () => {
    const wide = req({ windowStart: "2026-11-10", windowEnd: "2027-03-09", stayMin: 1, stayMax: 20 });
    const all = validPairs(wide).map(([dep, ret], i) => offer(100 + i, { departDate: dep, returnDate: ret }));
    expect(all.length).toBeGreaterThan(MAX_CACHED_OFFERS);
    const { db, deps } = setup({ tp: mockTp({ rt: rtFor(all) }) });
    await runSearch(deps, wide);
    const [row] = await rows<{ offers_json: string }>(db, "SELECT offers_json FROM search_cache");
    const cached = JSON.parse(row?.offers_json ?? "[]") as Offer[];
    expect(cached).toHaveLength(MAX_CACHED_OFFERS);
    const prices = cached.map((o) => o.priceAmount);
    expect(Math.min(...prices)).toBe(100);
    expect(Math.max(...prices)).toBe(100 + MAX_CACHED_OFFERS - 1); // exactly the cheapest ones
  });

  it("caps the cached one-way fares too, keeping the cheapest of every day and hour band", async () => {
    // 6 days x 2 directions x 200 fares (distinct minutes): far over MAX_CACHED_ONEWAYS
    const days = ["2026-11-12", "2026-11-13", "2026-11-14"];
    const backDays = ["2026-11-18", "2026-11-19", "2026-11-20"];
    const many = (ds: string[]) => ds.flatMap((d) => Array.from({ length: 400 }, (_, i) => at(d, 60 + (i % 40), `${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`)));
    const outs = many(days);
    const backs = many(backDays);
    expect(outs.length + backs.length).toBeGreaterThan(MAX_CACHED_ONEWAYS);
    const { db, deps } = setup({ tp: mockTp({ ow: splitFares(outs, backs) }) });
    await runSearch(deps, req());
    const [row] = await rows<{ extra_json: string }>(db, "SELECT extra_json FROM search_cache");
    const pair = (JSON.parse(row?.extra_json ?? "{}") as { oneWayPairs: OneWayPair[] }).oneWayPairs[0];
    const kept = (pair?.outs.length ?? 0) + (pair?.backs.length ?? 0);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(MAX_CACHED_ONEWAYS);
    expect(Math.min(...(pair?.outs ?? []).map((f) => f.priceAmount))).toBe(60);
    for (const d of days) expect(pair?.outs.some((f) => f.date === d)).toBe(true);
  });
});

describe("global upstream budget", () => {
  it("a denied budget means no Travelpayouts call: stored fares answer, and nothing is cached", async () => {
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const scanBudget = vi.fn(async () => false);
    const { db, repo, deps } = setup({ tp, scanBudget });
    await repo.savePrices([offer(100, { checkedAt: ago(2 * HOUR) })]);
    const res = await runSearch(deps, req());
    expect(scanBudget).toHaveBeenCalledTimes(1);
    expect(tp.callCount()).toBe(0);
    expect(res.cards[0]?.offer.priceAmount).toBe(100);
    expect(res.meta.sources[0]).toMatchObject({ ok: false, calls: 0, error: "Travelpayouts: too many searches right now" });
    expect(await count(db, "search_cache")).toBe(0);
  });

  it("with nothing stored it is a typed source_unavailable, like an outage", async () => {
    const { deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), scanBudget: async () => false });
    await expect(runSearch(deps, req())).rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("is asked before a fresh scan only: a cache hit costs no budget", async () => {
    const scanBudget = vi.fn(async () => true);
    const { repo, deps } = setup({ tp: mockTp({ rt: rtFor([offer(164)]) }), scanBudget });
    await repo.saveFxRates(FX);
    await runSearch(deps, req());
    const hit = await runSearch(deps, req());
    expect(hit.meta.fromCache).toBe(true);
    expect(scanBudget).toHaveBeenCalledTimes(1);
  });

  it("an unconfigured source does not spend budget either", async () => {
    const scanBudget = vi.fn(async () => true);
    const { deps } = setup({ tp: mockTp({ configured: false }), scanBudget });
    await expect(runSearch(deps, req())).rejects.toBeInstanceOf(PipelineError);
    expect(scanBudget).not.toHaveBeenCalled();
  });
});

describe("sanitizeOneWayPairs", () => {
  const good = { origin: "TLV", destination: "BCN", outs: [fare("2026-11-12", 60)], backs: [fare("2026-11-18", 70)] };

  it("keeps well-formed fares and drops malformed ones, like sanitizeOffers", () => {
    const bad = [
      null,
      { ...fare("2026-11-12", 60), priceAmount: -1 },
      { ...fare("2026-11-12", 60), date: "2026-02-30" },
      { ...fare("2026-11-12", 60), priceCurrency: "" },
      { ...fare("2026-11-12", 60), leg: null },
      fare("2026-11-13", 61),
    ];
    const out = sanitizeOneWayPairs([{ ...good, outs: bad }, { origin: 1 }, "nope", null]);
    expect(out).toHaveLength(1);
    expect(out[0]?.outs.map((f) => f.priceAmount)).toEqual([61]);
    expect(out[0]?.backs).toHaveLength(1);
    expect(sanitizeOneWayPairs("nope")).toEqual([]);
    expect(sanitizeOneWayPairs([{ ...good, outs: "x", backs: undefined }])).toEqual([{ origin: "TLV", destination: "BCN", outs: [], backs: [] }]);
  });
});

describe("stale-while-revalidate (SearchDeps.staleWhileRevalidate)", () => {
  const later = (h: number) => new Date(NOW.getTime() + h * HOUR);
  /** Fills the cache at NOW with one round trip at `price`, then returns deps for a search `hours` later. */
  async function staleSetup(hours: number, over: Partial<SearchDeps> = {}) {
    const pending: Promise<unknown>[] = [];
    const tp = mockTp({ rt: rtFor([offer(164)]) });
    const base = setup({ tp });
    await runSearch(base.deps, req());
    const deps: SearchDeps = { ...base.deps, now: later(hours), staleWhileRevalidate: true, waitUntil: (p) => void pending.push(p), ...over };
    return { ...base, tp, deps, pending };
  }

  /** A Travelpayouts client whose every request waits until release() is called. */
  function gatedTp() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockTp({ rt: rtFor([offer(170)]) });
    const tp: TravelpayoutsClient = {
      ...inner,
      roundTrips: async (...a) => (await gate, inner.roundTrips(...a)),
      oneWays: async (...a) => (await gate, inner.oneWays(...a)),
    };
    return { tp, release, inner };
  }

  it("bounds are what the SPEC states: 24h stale bound, 10 min lock", () => {
    expect(STALE_MAX_AGE_HOURS).toBe(24);
    expect(REFRESH_LOCK_SECONDS).toBe(600);
  });

  it("off by default (the scheduled snapshot path): a row past the TTL is a miss and the scan runs in the request", async () => {
    const { deps, tp } = await staleSetup(7);
    const before = tp.callCount();
    const res = await runSearch({ ...deps, staleWhileRevalidate: undefined }, req());
    expect(res.meta.fromCache).toBe(false);
    expect(res.meta.stale).toBeUndefined();
    expect(tp.callCount()).toBeGreaterThan(before);
  });

  it("needs waitUntil: without it a stale row is not served", async () => {
    const { deps } = await staleSetup(7);
    const res = await runSearch({ ...deps, waitUntil: undefined }, req());
    expect(res.meta.fromCache).toBe(false);
    expect(res.meta.stale).toBeUndefined();
  });

  it("answers from the stale row WITHOUT waiting for the rescan, which runs in waitUntil and rewrites the row", async () => {
    const { deps, pending, db } = await staleSetup(7);
    const g = gatedTp();
    const res = await runSearch({ ...deps, tp: g.tp }, req()); // resolves while every upstream request is still blocked
    expect(res.meta.fromCache).toBe(true);
    expect(res.meta.stale).toMatchObject({ cachedAt: NOW.toISOString(), ageHours: 7, revalidating: true });
    expect(res.cards[0]?.offer.priceAmount).toBe(164); // the old fare, not the rescan's 170
    expect(res.cards[0]?.ageHours).toBe(7); // the card's own age is the old scan's
    expect(g.inner.log).toEqual([]); // no upstream request has completed
    g.release();
    await Promise.all(pending);
    expect(g.inner.log.length).toBeGreaterThan(0);
    const [row] = await rows<{ created_at: string }>(db, "SELECT created_at FROM search_cache");
    expect(row?.created_at).toBe(later(7).toISOString());
    expect(await count(db, "searches")).toBe(2); // the stale answer's log row only, not one more for the rescan
  });

  it("a row inside the TTL is an ordinary hit: no stale mark, no rescan", async () => {
    const { deps, tp, pending } = await staleSetup(5);
    const before = tp.callCount();
    const res = await runSearch(deps, req());
    expect(res.meta.fromCache).toBe(true);
    expect(res.meta.stale).toBeUndefined();
    await Promise.all(pending);
    expect(tp.callCount()).toBe(before);
  });

  it("Travelpayouts not configured: stale answer, revalidating false, no background job", async () => {
    const { deps, pending } = await staleSetup(7);
    const res = await runSearch({ ...deps, tp: mockTp({ configured: false }) }, req());
    expect(res.meta.stale?.revalidating).toBe(false);
    expect(pending).toHaveLength(1); // only the search-log write
  });

  it("the lock storage failing means no rescan (fail closed), and the answer says so", async () => {
    const { deps, tp, pending, repo } = await staleSetup(7);
    const broken = new Proxy(repo, { get: (t, k) => (k === "claimWindowLock" ? async () => { throw new Error("D1 down"); } : Reflect.get(t, k)) });
    const before = tp.callCount();
    const res = await runSearch({ ...deps, repo: broken as typeof repo }, req());
    expect(res.meta.fromCache).toBe(true);
    expect(res.meta.stale?.revalidating).toBe(false);
    await Promise.all(pending);
    expect(tp.callCount()).toBe(before);
  });

  it("the global scan budget is asked only after the per-key lock is won", async () => {
    const budget = vi.fn(async () => true);
    const { deps } = await staleSetup(7, { scanBudget: budget });
    const g = gatedTp(); // the first rescan stays in flight, so the row is still stale for the second search
    await runSearch({ ...deps, tp: g.tp }, req());
    expect(budget).toHaveBeenCalledTimes(1);
    const second = await runSearch({ ...deps, tp: g.tp }, req()); // lock held now
    expect(second.meta.stale?.revalidating).toBe(false);
    expect(budget).toHaveBeenCalledTimes(1);
  });

  it("a failed background scan leaves the stale row untouched and never rejects", async () => {
    const { deps, pending, db } = await staleSetup(7);
    const failing: TravelpayoutsClient = { ...mockTp(), roundTrips: async () => { throw new TravelpayoutsError("HTTP 502"); }, oneWays: async () => { throw new TravelpayoutsError("HTTP 502"); } };
    const res = await runSearch({ ...deps, tp: failing }, req());
    expect(res.meta.stale?.revalidating).toBe(true);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    const [row] = await rows<{ created_at: string }>(db, "SELECT created_at FROM search_cache");
    expect(row?.created_at).toBe(NOW.toISOString());
  });

  /** A configured stand-in quote vendor that answers every date pair with one fare a little below the cached one. */
  function quoteVendor(seenAt: Date = later(7)) {
    const asked: string[] = [];
    const src: FareQuoteSource = {
      name: "serpapi",
      configured: true,
      quota: { period: "monthly", cap: 100, allowance: 250 },
      callCount: () => asked.length,
      quote: async (q) => {
        asked.push(`${q.departDate}|${q.returnDate}`);
        return [offer(160, { source: "serpapi", departDate: q.departDate, returnDate: q.returnDate, checkedAt: seenAt.toISOString() })];
      },
    };
    return { src, asked };
  }
  const extraOf = async (db: D1Database) =>
    JSON.parse((await db.prepare("SELECT extra_json FROM search_cache").first<string>("extra_json")) ?? "{}") as { quotes?: Offer[] };

  it("carried quotes expired + a quote source configured: the rescan runs the whole pipeline, so the key gets live quotes again", async () => {
    const { deps, pending, db } = await staleSetup(7);
    const v = quoteVendor();
    const res = await runSearch({ ...deps, quoteSources: [v.src] }, req());
    expect(res.meta.stale?.revalidating).toBe(true);
    expect(v.asked).toEqual([]); // not before the answer
    await Promise.all(pending);
    expect(v.asked.length).toBeGreaterThan(0);
    expect((await extraOf(db)).quotes?.length).toBeGreaterThan(0);
    expect(await count(db, "searches")).toBe(2); // the background pipeline did not log a search of its own
    // The next identical search is an in-TTL hit that ranks the refreshed quotes.
    const again = await runSearch({ ...deps, quoteSources: [v.src] }, req());
    expect(again.meta.fromCache).toBe(true);
    expect(again.meta.stale).toBeUndefined();
    expect(again.cards.some((c) => c.offer.source === "serpapi")).toBe(true);
  });

  it("the whole-pipeline rescan takes no second unit of the global scan budget", async () => {
    const budget = vi.fn(async () => true);
    const { deps, pending } = await staleSetup(7, { scanBudget: budget });
    await runSearch({ ...deps, quoteSources: [quoteVendor().src] }, req());
    await Promise.all(pending);
    expect(budget).toHaveBeenCalledTimes(1);
  });

  it("still-live carried quotes: the lean rescan asks no vendor and keeps them on the rewritten row", async () => {
    const { deps, pending, db } = await staleSetup(7);
    const live = offer(160, { source: "serpapi", checkedAt: later(5).toISOString() }); // 2h old at the stale hit
    const extra = await extraOf(db);
    await db.prepare("UPDATE search_cache SET extra_json = ?").bind(JSON.stringify({ ...extra, quotes: [live] })).run();
    const v = quoteVendor();
    const res = await runSearch({ ...deps, quoteSources: [v.src] }, req());
    expect(res.meta.stale?.revalidating).toBe(true);
    await Promise.all(pending);
    expect(v.asked).toEqual([]);
    const [row] = await rows<{ created_at: string }>(db, "SELECT created_at FROM search_cache");
    expect(row?.created_at).toBe(later(7).toISOString());
    expect((await extraOf(db)).quotes).toEqual([JSON.parse(JSON.stringify(live))]);
  });

  it("staleInfo: Hebrew hour forms, and the 'search again' line only while revalidating", () => {
    const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
    expect(staleInfo(NOW.toISOString(), at(1.5), false).messageHe).toContain("לפני שעה,");
    expect(staleInfo(NOW.toISOString(), at(2.2), false).messageHe).toContain("לפני שעתיים,");
    const s = staleInfo(NOW.toISOString(), at(13.26), true);
    expect(s).toMatchObject({ ageHours: 13.3, revalidating: true, cachedAt: NOW.toISOString() });
    expect(s.messageHe).toContain("לפני 13 שעות");
    expect(s.messageHe).toContain("חפשו שוב");
    expect(staleInfo(NOW.toISOString(), at(13), false).messageHe).not.toContain("חפשו שוב");
  });
});
