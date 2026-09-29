/**
 * Price guard (src/priceguard.ts): unit tests of the two signals, the D1 history read (one indexed query, bounded rows), and the
 * pipeline wiring (a suspicious cached fare does not win 💰 while anything else is priced, and is not written to the history).
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { runSearch, type SearchDeps } from "../src/pipeline";
import {
  applyPriceGuard,
  createPriceGuard,
  HISTORY_PAIRS,
  historyTargets,
  PRICE_GUARD_CONFIG,
  PRICE_SUSPICIOUS_TAG,
  type HistoryRow,
} from "../src/priceguard";
import type { FxRates, Leg, Offer, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };

const leg = (over: Partial<Leg> = {}): Leg => ({ departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over });

function offer(price: number, depart: string, ret: string, over: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV",
    destination: "BCN",
    departDate: depart,
    returnDate: ret,
    priceAmount: price,
    priceCurrency: "USD",
    source: "travelpayouts",
    ticketStructure: "roundtrip",
    outbound: leg(),
    inbound: leg({ departTime: "18:00" }),
    includes: {},
    deeplink: `https://www.aviasales.com/search/TLV${depart}BCN?marker=m`,
    verifyLink: null,
    checkedAt: ago(0),
    extrasAmountIls: 0,
    totalIls: price * 3,
    tags: [],
    ...over,
  };
}

/** 6-night trips departing on consecutive November days from `firstDay`, all at `price` unless overridden. */
function week(price: number, firstDay = 10, days = 7, over: Record<number, number> = {}): Offer[] {
  return Array.from({ length: days }, (_, i) => {
    const d = firstDay + i;
    const dep = `2026-11-${String(d).padStart(2, "0")}`;
    const ret = `2026-11-${String(d + 6).padStart(2, "0")}`;
    return offer(over[d] ?? price, dep, ret);
  });
}

const hist = (price: number, depart: string, ret: string, msAgo: number, currency = "USD"): HistoryRow => ({
  origin: "TLV",
  destination: "BCN",
  depart_date: depart,
  return_date: ret,
  price_amount: price,
  price_currency: currency,
  checked_at: ago(msAgo),
});

// --- peers ---------------------------------------------------------------------------------------------

describe("peer signal", () => {
  it("flags a cached fare at half or less of the median of its neighbouring dates", () => {
    const offers = week(200, 10, 7, { 13: 90 });
    const g = createPriceGuard(offers, [], FX, 1);
    expect(g.check(offers[3]!)).toBe("peers");
    for (const o of offers.filter((_, i) => i !== 3)) expect(g.check(o)).toBeNull();
  });

  it("the boundary is inclusive: exactly 50% is suspicious, a cent above is not", () => {
    const at = week(200, 10, 7, { 13: 100 });
    expect(createPriceGuard(at, [], FX, 1).check(at[3]!)).toBe("peers");
    const above = week(200, 10, 7, { 13: 100.01 });
    expect(createPriceGuard(above, [], FX, 1).check(above[3]!)).toBeNull();
  });

  it("an ordinary cheap day (40% below its neighbours) is not flagged", () => {
    const offers = week(200, 10, 7, { 13: 120 });
    expect(createPriceGuard(offers, [], FX, 1).check(offers[3]!)).toBeNull();
  });

  it("stays silent with fewer than minPeers neighbouring date pairs", () => {
    const offers = week(200, 10, PRICE_GUARD_CONFIG.minPeers, { 10: 20 }); // the cheap one has minPeers - 1 neighbours
    expect(createPriceGuard(offers, [], FX, 1).check(offers[0]!)).toBeNull();
  });

  it("only neighbours count: dates further than peerDepartDays away, or a very different trip length, are ignored", () => {
    const cheap = offer(50, "2026-11-10", "2026-11-16");
    const far = week(900, 20, 7); // 10+ days away
    const long = Array.from({ length: 6 }, (_, i) => offer(900, `2026-11-${String(9 + i).padStart(2, "0")}`, `2026-11-${String(9 + i + 14).padStart(2, "0")}`)); // 14 nights
    expect(createPriceGuard([cheap, ...far, ...long], [], FX, 1).check(cheap)).toBeNull();
  });

  it("uses each neighbour's CHEAPEST fare, so an expensive extra flight on a neighbour does not make the guard stricter", () => {
    const offers = [...week(200, 10, 7, { 13: 110 }), ...week(5000, 10, 7).filter((_, i) => i !== 3)];
    expect(createPriceGuard(offers, [], FX, 1).check(offers[3]!)).toBeNull();
  });

  it("compares per passenger in ILS across currencies and party sizes", () => {
    // Neighbours are 2 travellers x 200 USD = 400 USD (1200 ILS for the party); the odd one is 700 ILS for 2 = 350 ILS each vs 600.
    const offers = week(400, 10, 7);
    const odd = offer(700, "2026-11-13", "2026-11-19", { priceCurrency: "ILS" });
    const g = createPriceGuard([...offers.filter((_, i) => i !== 3), odd], [], FX, 2);
    expect(g.check(odd)).toBeNull(); // 350 vs 600 is 58%: fine
    const odder = offer(600, "2026-11-13", "2026-11-19", { priceCurrency: "ILS" });
    expect(createPriceGuard([...offers.filter((_, i) => i !== 3), odder], [], FX, 2).check(odder)).toBe("peers"); // 300 vs 600
  });

  it("never judges a non-Travelpayouts offer (live quotes and monitor rows) and never judges an unpriceable one", () => {
    const offers = week(200, 10, 7, { 13: 50 });
    const quote = { ...offers[3]!, source: "ignav" as const };
    const gf = { ...offers[3]!, source: "google_flights" as const };
    const noRate = { ...offers[3]!, priceCurrency: "XYZ" };
    const g = createPriceGuard(offers, [], FX, 1);
    expect(g.check(quote)).toBeNull();
    expect(g.check(gf)).toBeNull();
    expect(g.check(noRate)).toBeNull();
  });

  it("does not compare airport pairs with each other", () => {
    const cheap = offer(50, "2026-11-13", "2026-11-19", { origin: "ETM" });
    const offers = [...week(200, 10, 7).filter((_, i) => i !== 3), cheap];
    expect(createPriceGuard(offers, [], FX, 1).check(cheap)).toBeNull();
  });

  it("survives malformed dates and prices in the pool", () => {
    const offers = week(200, 10, 7, { 13: 50 });
    const junk = [offer(NaN, "2026-11-12", "2026-11-18"), offer(10, "not-a-date", "2026-11-18"), offer(10, "2026-11-20", "2026-11-12"), offer(-5, "2026-11-12", "2026-11-18")];
    const g = createPriceGuard([...offers, ...junk], [], FX, 1);
    expect(g.check(offers[3]!)).toBe("peers");
    for (const j of junk) expect(() => g.check(j)).not.toThrow();
  });
});

// --- history -------------------------------------------------------------------------------------------

describe("history signal", () => {
  const D = "2026-11-13";
  const R = "2026-11-19";

  it("flags a fare at half or less of the median of its own date pair's older snapshots", () => {
    const o = offer(90, D, R);
    const h = [hist(200, D, R, 1 * DAY), hist(210, D, R, 2 * DAY), hist(190, D, R, 3 * DAY)];
    expect(createPriceGuard([o], h, FX, 1).check(o)).toBe("history");
  });

  it("needs minHistoryBins bins: several snapshots in one 6-hour bin are one look", () => {
    const o = offer(90, D, R);
    // NOW is 12:00Z: 1 day + 1..3 hours ago all fall in the 06:00-12:00 bin of that day
    const burst = [hist(200, D, R, DAY + HOUR), hist(200, D, R, DAY + 2 * HOUR), hist(200, D, R, DAY + 3 * HOUR), hist(200, D, R, 3 * DAY)];
    expect(createPriceGuard([o], burst, FX, 1).check(o)).toBeNull();
  });

  it("needs minHistoryDays distinct days", () => {
    const o = offer(90, D, R);
    const oneDay = ["01", "08", "15"].map((h) => ({ ...hist(200, D, R, 0), checked_at: `2026-10-30T${h}:00:00.000Z` })); // 3 bins, 1 day
    expect(createPriceGuard([o], oneDay, FX, 1).check(o)).toBeNull();
  });

  it("ignores snapshots at or after the offer's own check time (a cache hit's own history row) and other date pairs", () => {
    const o = offer(90, D, R, { checkedAt: ago(2 * DAY) });
    const h = [hist(200, D, R, 1 * DAY), hist(200, D, R, 2 * DAY), hist(200, D, R, 3 * DAY), hist(200, "2026-11-14", R, 4 * DAY), hist(200, D, R, 5 * DAY)];
    // older than the offer: 3d and 5d only -> 2 bins, not enough
    expect(createPriceGuard([o], h, FX, 1).check(o)).toBeNull();
  });

  it("a history at the same low level clears the fare; rows in a currency without a rate are skipped", () => {
    const o = offer(90, D, R);
    expect(createPriceGuard([o], [hist(95, D, R, DAY), hist(92, D, R, 2 * DAY), hist(99, D, R, 3 * DAY)], FX, 1).check(o)).toBeNull();
    const h = [hist(200, D, R, DAY, "XYZ"), hist(200, D, R, 2 * DAY, "XYZ"), hist(200, D, R, 3 * DAY)];
    expect(createPriceGuard([o], h, FX, 1).check(o)).toBeNull();
  });

  it("history rows are per passenger", () => {
    const o = offer(400, D, R); // 2 travellers: 200 USD each
    const h = [hist(200, D, R, DAY), hist(200, D, R, 2 * DAY), hist(200, D, R, 3 * DAY)];
    expect(createPriceGuard([o], h, FX, 2).check(o)).toBeNull();
    expect(createPriceGuard([offer(200, D, R)], h, FX, 2).check(offer(200, D, R))).toBe("history");
  });
});

// --- targets and applying ------------------------------------------------------------------------------

describe("historyTargets and applyPriceGuard", () => {
  it("targets the cheapest distinct Travelpayouts date pairs, at most HISTORY_PAIRS", () => {
    const offers = [...week(200, 10, 7, { 12: 150, 14: 100 }), offer(50, "2026-11-12", "2026-11-18", { source: "ignav" }), offer(210, "2026-11-12", "2026-11-18")];
    const t = historyTargets(offers, FX, 1);
    expect(t).toHaveLength(HISTORY_PAIRS);
    expect(t[0]).toMatchObject({ departDate: "2026-11-14" });
    expect(t[1]).toMatchObject({ departDate: "2026-11-12" });
    expect(new Set(t.map((p) => p.departDate)).size).toBe(t.length);
  });

  it("tags and removes suspicious offers, keeps the rest", () => {
    const offers = week(200, 10, 7, { 13: 50 });
    const out = applyPriceGuard(offers, [], createPriceGuard(offers, [], FX, 1));
    expect(out.pool).toHaveLength(6);
    expect(out.excluded).toBe(1);
    expect(offers[3]!.tags).toEqual([PRICE_SUSPICIOUS_TAG]);
    expect(out.suspicious.has(offers[3]!)).toBe(true);
  });

  it("falls back to the whole pool (tagged) when nothing else is priced", () => {
    const only = offer(50, "2026-11-13", "2026-11-19");
    const unpriced = offer(200, "2026-11-12", "2026-11-18", { totalIls: null });
    const guard = { check: (o: Offer) => (o === only ? ("history" as const) : null) };
    const out = applyPriceGuard([only, unpriced], [], guard);
    expect(out.pool).toEqual([only, unpriced]);
    expect(out.excluded).toBe(0);
    expect(only.tags).toContain(PRICE_SUSPICIOUS_TAG);
  });

  it("filters the 🎯-only candidates the same way and never tags twice", () => {
    const offers = week(200, 10, 7, { 13: 50 });
    const guard = createPriceGuard(offers, [], FX, 1);
    applyPriceGuard(offers, [], guard);
    const out = applyPriceGuard(offers, [offers[3]!], guard);
    expect(out.timeOnly).toEqual([]);
    expect(offers[3]!.tags).toEqual([PRICE_SUSPICIOUS_TAG]);
  });
});

// --- D1 read -------------------------------------------------------------------------------------------

describe("repo.priceHistory", () => {
  const P = (dep: string, ret: string) => ({ origin: "TLV", destination: "BCN", departDate: dep, returnDate: ret });

  async function seeded() {
    const db = createTestD1();
    const repo = createRepo(db);
    const rows = [];
    for (let i = 0; i < 80; i++) rows.push(offer(100 + i, "2026-11-13", "2026-11-19", { checkedAt: ago(i * HOUR) }));
    for (let i = 0; i < 5; i++) rows.push(offer(300 + i, "2026-11-14", "2026-11-20", { checkedAt: ago(i * DAY) }));
    rows.push(offer(999, "2026-11-13", "2026-11-19", { checkedAt: ago(60 * DAY) })); // outside the lookback
    rows.push(offer(1, "2026-11-13", "2026-11-19", { destination: "ATH", checkedAt: ago(HOUR) })); // other route
    await repo.savePrices(rows);
    return { db, repo };
  }

  it("returns the newest rows per pair after `since`, capped per pair, in ONE query", async () => {
    const { db, repo } = await seeded();
    const prepare = vi.spyOn(db, "prepare");
    const out = await repo.priceHistory!([P("2026-11-13", "2026-11-19"), P("2026-11-14", "2026-11-20")], new Date(NOW.getTime() - 30 * DAY), 40);
    expect(prepare).toHaveBeenCalledTimes(1);
    const a = out.filter((r) => r.depart_date === "2026-11-13");
    const b = out.filter((r) => r.depart_date === "2026-11-14");
    expect(a).toHaveLength(40);
    expect(Math.max(...a.map((r) => r.price_amount))).toBe(139); // the newest 40 of 80
    expect(b).toHaveLength(5);
    expect(out.every((r) => r.origin === "TLV" && r.destination === "BCN")).toBe(true);
  });

  it("each subquery is served by idx_prices_route with no sort step", async () => {
    const { db, repo } = await seeded();
    const prepare = vi.spyOn(db, "prepare");
    await repo.priceHistory!([P("2026-11-13", "2026-11-19"), P("2026-11-14", "2026-11-20")], new Date(0), 10);
    const sql = String(prepare.mock.calls[0]?.[0]);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array.from({ length: sql.split("?").length - 1 }, () => "x")).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" | ");
    expect(detail).toContain("idx_prices_route (origin=? AND destination=? AND depart_date=? AND return_date=? AND checked_at>?)");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("makes no query for nothing to read, and bounds pairs and rows per pair", async () => {
    const { db, repo } = await seeded();
    const prepare = vi.spyOn(db, "prepare");
    expect(await repo.priceHistory!([], new Date(0), 40)).toEqual([]);
    expect(await repo.priceHistory!([P("2026-11-13", "2026-11-19")], new Date(0), 0)).toEqual([]);
    expect(await repo.priceHistory!([P("bad", "2026-11-19")], new Date(0), 40)).toEqual([]);
    expect(await repo.priceHistory!([P("2026-11-13", "2026-11-19")], new Date(NaN), 40)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    const many = Array.from({ length: 30 }, () => P("2026-11-13", "2026-11-19"));
    const out = await repo.priceHistory!(many, new Date(0), 10_000);
    expect(out.length).toBeLessThanOrEqual(10 * 100);
    const sql = String(prepare.mock.calls[0]?.[0]);
    expect(sql.split("?").length - 1).toBeLessThanOrEqual(100); // D1's bound-parameter limit
  });

  it("binds hostile text as values", async () => {
    const { repo } = await seeded();
    const out = await repo.priceHistory!([{ origin: "TLV' OR '1'='1", destination: "BCN", departDate: "2026-11-13", returnDate: "2026-11-19" }], new Date(0), 40);
    expect(out).toEqual([]);
  });
});

// --- pipeline ------------------------------------------------------------------------------------------

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

function tpWith(rts: Offer[]): TravelpayoutsClient {
  let calls = 0;
  return {
    configured: true,
    callCount: () => calls,
    async roundTrips(o, d) {
      calls += 1;
      return o === "TLV" && d === "BCN" ? rts.map((x) => ({ ...structuredClone(x), totalIls: null, tags: [] })) : [];
    },
    async oneWays() {
      calls += 1;
      return [];
    },
  };
}

function setup(rts: Offer[]) {
  const db = createTestD1();
  const repo = createRepo(db);
  const deps: SearchDeps = { repo, tp: tpWith(rts), fx: FX, now: NOW };
  return { db, repo, deps };
}

describe("pipeline wiring", () => {
  it("a suspicious cached fare does not win 💰 or ⚖️; the next honest fare does, and meta says one was excluded", async () => {
    const { deps } = setup(week(200, 10, 7, { 13: 50 }));
    const res = await runSearch(deps, req());
    const cheapest = res.cards.find((c) => c.kinds.includes("cheapest"));
    expect(cheapest?.offer.priceAmount).toBe(200);
    for (const c of res.cards) expect(c.offer.tags).not.toContain(PRICE_SUSPICIOUS_TAG);
    expect(res.meta.priceGuard).toEqual({ suspicious: 1, excluded: 1 });
  });

  it("a history of the same date pair far above the fare flags it too (one extra D1 query)", async () => {
    const { db, repo, deps } = setup([offer(90, "2026-11-13", "2026-11-19"), offer(150, "2026-11-12", "2026-11-18")]);
    await repo.savePrices([1, 2, 3].map((d) => offer(200, "2026-11-13", "2026-11-19", { checkedAt: ago(d * DAY) })));
    const prepare = vi.spyOn(db, "prepare");
    const res = await runSearch(deps, req());
    expect(res.cards.find((c) => c.kinds.includes("cheapest"))?.offer.priceAmount).toBe(150);
    expect(res.meta.priceGuard).toEqual({ suspicious: 1, excluded: 1 });
    expect(prepare.mock.calls.filter((c) => String(c[0]).includes("idx_prices_route")).length).toBe(1);
  });

  it("when every priced offer is suspicious it is still shown, tagged, and excluded is 0", async () => {
    const { repo, deps } = setup([offer(90, "2026-11-13", "2026-11-19")]);
    await repo.savePrices([1, 2, 3].map((d) => offer(200, "2026-11-13", "2026-11-19", { checkedAt: ago(d * DAY) })));
    const res = await runSearch(deps, req());
    const c = res.cards.find((x) => x.kinds.includes("cheapest"));
    expect(c?.offer.priceAmount).toBe(90);
    expect(c?.offer.tags).toContain(PRICE_SUSPICIOUS_TAG);
    expect(res.meta.priceGuard).toEqual({ suspicious: 1, excluded: 0 });
  });

  it("an ordinary search has no priceGuard field (the contract is unchanged)", async () => {
    const { deps } = setup(week(200, 10, 7));
    const res = await runSearch(deps, req());
    expect("priceGuard" in res.meta).toBe(false);
  });

  it("a suspicious fare is not written to the price history; the honest fares are", async () => {
    const { db, deps } = setup(week(200, 10, 7, { 13: 50 }));
    await runSearch(deps, req());
    const stored = (await db.prepare("SELECT depart_date, price_amount FROM prices").all<{ depart_date: string; price_amount: number }>()).results;
    expect(stored.map((r) => r.price_amount)).not.toContain(50);
    expect(stored).toHaveLength(6);
  });

  it("a history read that fails degrades to peers only, never fails the search", async () => {
    const { repo, deps } = setup(week(200, 10, 7, { 13: 50 }));
    repo.priceHistory = async () => {
      throw new Error("D1 down");
    };
    const res = await runSearch(deps, req());
    expect(res.cards.find((c) => c.kinds.includes("cheapest"))?.offer.priceAmount).toBe(200);
  });

  it("a cache hit applies the guard the same way, with no upstream call", async () => {
    const { deps } = setup(week(200, 10, 7, { 13: 50 }));
    await runSearch(deps, req());
    const tp = deps.tp;
    const before = tp.callCount();
    const res = await runSearch({ ...deps, now: new Date(NOW.getTime() + HOUR) }, req());
    expect(res.meta.fromCache).toBe(true);
    expect(tp.callCount()).toBe(before);
    expect(res.cards.find((c) => c.kinds.includes("cheapest"))?.offer.priceAmount).toBe(200);
    expect(res.meta.priceGuard).toEqual({ suspicious: 1, excluded: 1 });
  });
});
