import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRepo, pruneHistory, PRICES_GRACE_DAYS, SEARCHES_RETENTION_DAYS } from "../src/db";
import type { Offer, OneWayPair, SearchRequest, SourceName } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function mkOffer(o: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV",
    destination: "BCN",
    departDate: "2026-11-10",
    returnDate: "2026-11-15",
    priceAmount: 164,
    priceCurrency: "USD",
    source: "travelpayouts",
    ticketStructure: "roundtrip",
    outbound: { departTime: "07:30", arriveTime: "11:05", stops: 0, durationMin: 215, airlines: ["LY"] },
    inbound: { departTime: "12:10", arriveTime: "16:45", stops: 1, durationMin: 275, airlines: ["W6", "LY"] },
    includes: { checkedBag: true },
    deeplink: "https://www.aviasales.com/search/TLV1011BCN1511?marker=m",
    verifyLink: null,
    checkedAt: ago(HOUR),
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
    ...o,
  };
}

function mkRequest(o: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV",
    destination: "BCN",
    windowStart: "2026-11-10",
    windowEnd: "2026-11-25",
    stayMin: 5,
    stayMax: 7,
    adults: 2,
    children: 1,
    infants: 0,
    cabin: "economy",
    checkedBag: true,
    outHours: [6, 12],
    retHours: null,
    maxStops: 1,
    nearbyAirports: false,
    ...o,
  };
}

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
}

const loadAll = (repo: ReturnType<typeof createRepo>, maxAgeHours = 24, sources?: SourceName[]) =>
  repo.loadRecentOffers("TLV", "BCN", "2026-11-01", "2026-12-31", maxAgeHours, NOW, sources);

describe("schema", () => {
  it("applies all migrations and creates every SPEC section 12 table plus the additive ones", async () => {
    const db = createTestD1();
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of [
      "airports", "fx_rates", "bag_fees", "searches", "prices", "users", "watches", "alerts", "source_health",
      "search_cache", "rate_limits",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("indexes prices on (origin, destination, depart_date, return_date, checked_at)", async () => {
    const db = createTestD1();
    const { results } = await db.prepare("PRAGMA index_info(idx_prices_route)").all<{ seqno: number; name: string }>();
    expect(results.sort((a, b) => a.seqno - b.seqno).map((r) => r.name)).toEqual([
      "origin", "destination", "depart_date", "return_date", "checked_at",
    ]);
  });

  it("adds the cache extras column and the recent-fares index (migration 0003)", async () => {
    const db = createTestD1();
    const cols = (await db.prepare("PRAGMA table_info(search_cache)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toEqual(["search_key", "offers_json", "created_at", "extra_json"]);
    const idx = (await db.prepare("PRAGMA index_info(idx_prices_recent)").all<{ seqno: number; name: string }>()).results;
    expect(idx.sort((a, b) => a.seqno - b.seqno).map((r) => r.name)).toEqual(["origin", "destination", "checked_at"]);
  });

  it("uses composite primary keys where the SPEC needs them", async () => {
    const db = createTestD1();
    const pk = async (t: string) =>
      (await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string; pk: number }>()).results
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(await pk("fx_rates")).toEqual(["date", "currency"]);
    expect(await pk("rate_limits")).toEqual(["key", "window_start"]);
    expect(await pk("search_cache")).toEqual(["search_key"]);
    expect(await pk("source_health")).toEqual(["source"]);
  });

  it("stays D1-safe: no BEGIN/PRAGMA, and the file runs statement by statement", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files[0]).toBe("0001_init.sql");
    for (const f of files) {
      const stripped = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      expect(stripped, f).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i);
    }
    // A naive splitter is what breaks on a stray semicolon in a comment: emulate it for our own file.
    const db = new DatabaseSync(":memory:");
    const statements = readFileSync(join(dir, "0001_init.sql"), "utf8").split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(15);
    for (const s of statements) db.exec(s);
    // ...and every later migration on top of it, split the same naive way.
    for (const f of files.slice(1)) {
      for (const s of readFileSync(join(dir, f), "utf8").split(";").map((x) => x.trim()).filter(Boolean)) db.exec(s);
    }
    db.close();
  });
});

describe("test D1 shim", () => {
  it("returns D1-shaped results and supports RETURNING through first() and all()", async () => {
    const db = createTestD1();
    const res = await db.prepare("INSERT INTO source_health (source, consecutive_failures) VALUES (?, 0) RETURNING source").bind("x").all();
    expect(res.success).toBe(true);
    expect(res.results).toEqual([{ source: "x" }]);
    expect(res.meta.changes).toBe(1);
    const one = await db.prepare("SELECT 1 AS a, 'b' AS b").first();
    expect(one).toEqual({ a: 1, b: "b" });
    expect(await db.prepare("SELECT 1 AS a WHERE 0").first()).toBeNull();
    expect(await db.prepare("SELECT 7 AS a").first("a")).toBe(7);
  });

  it("applies every migration file in name order, ignores non-SQL files, and works with only 0001", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-shim-"));
    try {
      writeFileSync(join(dir, "0002_seed.sql"), "INSERT INTO t (v) VALUES ('seeded');");
      writeFileSync(join(dir, "0001_init.sql"), "CREATE TABLE t (v TEXT);");
      writeFileSync(join(dir, "0010_more.sql"), "INSERT INTO t (v) VALUES ('later');");
      writeFileSync(join(dir, "README.md"), "not sql");
      mkdirSync(join(dir, "nested"));
      const db = createTestD1(dir);
      const { results } = await db.prepare("SELECT v FROM t ORDER BY rowid").all<{ v: string }>();
      expect(results.map((r) => r.v)).toEqual(["seeded", "later"]);

      rmSync(join(dir, "0002_seed.sql"));
      rmSync(join(dir, "0010_more.sql"));
      expect(await count(createTestD1(dir), "t")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects undefined binds like D1", () => {
    const db = createTestD1();
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow(/undefined/);
  });

  it("rolls a failing batch back as a unit", async () => {
    const db = createTestD1();
    const ins = (s: string) => db.prepare("INSERT INTO source_health (source, consecutive_failures) VALUES (?, 0)").bind(s);
    await expect(db.batch([ins("a"), ins("a")])).rejects.toThrow(/UNIQUE|constraint/i); // 2nd violates the primary key
    expect(await count(db, "source_health")).toBe(0);
    await db.batch([ins("a"), ins("b")]);
    expect(await count(db, "source_health")).toBe(2);
  });
});

describe("savePrices / loadRecentOffers", () => {
  it("round-trips offers incl. unicode and null leg fields; pipeline fields reset", async () => {
    const repo = createRepo(createTestD1());
    const full = mkOffer({
      deeplink: "https://example.com/חיפוש?q=תל-אביב&emoji=✈️",
      verifyLink: "https://www.google.com/travel/flights?q=Flights%20TLV%20to%20BCN",
      extrasAmountIls: 250,
      totalIls: 855.5,
      tags: ["bonus_checked_bag"],
    });
    const sparse = mkOffer({
      departDate: "2026-11-11",
      returnDate: "2026-11-17",
      priceAmount: 1234.56,
      priceCurrency: "EUR",
      outbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] },
      inbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] },
      includes: {},
      deeplink: null,
    });
    const split = mkOffer({ departDate: "2026-11-12", returnDate: "2026-11-18", ticketStructure: "split", source: "google_flights", includes: { checkedBag: false } });
    await repo.savePrices([full, sparse, split]);

    const loaded = await loadAll(repo);
    expect(loaded).toEqual([
      { ...full, extrasAmountIls: 0, totalIls: null, tags: [] },
      { ...sparse, extrasAmountIls: 0, totalIls: null, tags: [] },
      { ...split, extrasAmountIls: 0, totalIls: null, tags: [] },
    ]);
    expect(loaded[0]?.deeplink).toBe("https://example.com/חיפוש?q=תל-אביב&emoji=✈️");
    expect(loaded[1]?.outbound.stops).toBeNull();
    expect(loaded[1]?.includes).toEqual({});
    expect(loaded[2]?.includes.checkedBag).toBe(false);
  });

  it("keeps a split ticket's return link (in legs_json) and leaves round trips without one", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.savePrices([
      mkOffer({ ticketStructure: "split", deeplink: "https://www.aviasales.com/search/TLV1011BCN1?t=out", returnDeeplink: "https://www.aviasales.com/search/BCN1511TLV1?t=back" }),
      mkOffer({ departDate: "2026-11-11", returnDate: "2026-11-16" }),
    ]);
    const [split, rt] = await loadAll(repo);
    expect(split?.returnDeeplink).toBe("https://www.aviasales.com/search/BCN1511TLV1?t=back");
    expect(split?.deeplink).toContain("t=out");
    expect(rt).not.toHaveProperty("returnDeeplink");
    const row = await db.prepare("SELECT legs_json FROM prices ORDER BY id LIMIT 1").first<{ legs_json: string }>();
    expect(Object.keys(JSON.parse(String(row?.legs_json))).sort()).toEqual(["inbound", "outbound", "returnDeeplink"]);
  });

  it("finds recent rows through idx_prices_recent, so the scan does not grow with the route's history", async () => {
    const db = createTestD1();
    const prepare = vi.spyOn(db, "prepare");
    const repo = createRepo(db);
    await repo.savePrices([mkOffer({ source: "google_flights" })]);
    await loadAll(repo, 12, ["google_flights"]);
    const sql = String(prepare.mock.calls.map((c) => String(c[0])).find((q) => q.includes("FROM prices INDEXED BY")));
    expect(sql).toBeTruthy();
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array.from({ length: sql.split("?").length - 1 }, () => "x")).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" | ");
    expect(detail).toContain("idx_prices_recent (origin=? AND destination=? AND checked_at>?)");
    expect(detail).not.toContain("TEMP B-TREE"); // newest-first comes straight from the index
  });

  it("returns the same rows however much older history the route has", async () => {
    const repo = createRepo(createTestD1());
    const old = Array.from({ length: 300 }, (_, i) => mkOffer({ priceAmount: 500 + i, checkedAt: ago(20 * DAY + i), source: "google_flights" }));
    await repo.savePrices([...old, mkOffer({ priceAmount: 77, source: "google_flights" })]);
    expect((await loadAll(repo, 12, ["google_flights"])).map((o) => o.priceAmount)).toEqual([77]);
  });

  it("keeps original amount and currency and the airlines / legs / includes columns", async () => {
    const db = createTestD1();
    await createRepo(db).savePrices([mkOffer({ priceAmount: 1234.5, priceCurrency: "JPY" })]);
    const row = await db.prepare("SELECT * FROM prices").first<Record<string, unknown>>();
    expect(row?.price_amount).toBe(1234.5);
    expect(row?.price_currency).toBe("JPY");
    expect(JSON.parse(String(row?.airlines_json))).toEqual(["LY", "W6"]);
    const legs = JSON.parse(String(row?.legs_json));
    expect(legs.outbound.departTime).toBe("07:30");
    expect(legs.inbound.stops).toBe(1);
    expect(JSON.parse(String(row?.includes_json))).toEqual({ checked_bag: true });
    expect(row?.checked_at).toBe(ago(HOUR));
  });

  it("stores Python-style timestamps in canonical form so cutoffs compare correctly", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([mkOffer({ checkedAt: "2026-11-01T11:00:00.123456+00:00" })]);
    const [o] = await loadAll(repo);
    expect(o?.checkedAt).toBe("2026-11-01T11:00:00.123Z");
  });

  it("writes >50 offers in batches of at most 50 statements", async () => {
    const db = createTestD1();
    const spy = vi.spyOn(db, "batch");
    const repo = createRepo(db);
    const offers = Array.from({ length: 120 }, (_, i) => mkOffer({ priceAmount: 100 + i }));
    await repo.savePrices(offers);
    const sizes = spy.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(await count(db, "prices")).toBe(120);
    expect(await loadAll(repo)).toHaveLength(120);
  });

  it("saving nothing is a no-op", async () => {
    const db = createTestD1();
    const spy = vi.spyOn(db, "batch");
    await createRepo(db).savePrices([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips offers that are not safe to persist instead of failing the batch", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.savePrices([
      mkOffer({ priceAmount: Number.NaN }),
      mkOffer({ priceAmount: -5 }),
      mkOffer({ priceAmount: 0 }),
      mkOffer({ priceCurrency: "" }),
      mkOffer({ departDate: "10/11/2026" }),
      mkOffer({ checkedAt: "not a date" }),
      mkOffer({ priceAmount: 111 }),
    ]);
    expect(await count(db, "prices")).toBe(1);
    expect((await loadAll(repo))[0]?.priceAmount).toBe(111);
  });

  it("filters by route, date window, source and age", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([
      mkOffer({ priceAmount: 1 }), // in
      mkOffer({ priceAmount: 2, destination: "ATH" }), // other route
      mkOffer({ priceAmount: 3, origin: "ETM" }), // other route
      mkOffer({ priceAmount: 4, departDate: "2026-10-31" }), // departs before window
      mkOffer({ priceAmount: 5, returnDate: "2027-01-01" }), // returns after window
      mkOffer({ priceAmount: 6, source: "google_flights" }), // in, other source
      mkOffer({ priceAmount: 7, checkedAt: ago(30 * HOUR) }), // too old for 24h
    ]);
    const all = await loadAll(repo);
    expect(all.map((o) => o.priceAmount)).toEqual([1, 6]);
    expect((await loadAll(repo, 24, ["google_flights"])).map((o) => o.priceAmount)).toEqual([6]);
    expect((await loadAll(repo, 24, ["travelpayouts", "google_flights"])).map((o) => o.priceAmount)).toEqual([1, 6]);
    expect(await loadAll(repo, 24, [])).toEqual([]);
    expect((await loadAll(repo, 48)).map((o) => o.priceAmount)).toEqual([1, 6, 7]);
  });

  it("age cutoff is strict: a row exactly maxAgeHours old is not recent", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([
      mkOffer({ priceAmount: 1, checkedAt: ago(6 * HOUR) }),
      mkOffer({ priceAmount: 2, checkedAt: ago(6 * HOUR - 1) }),
    ]);
    expect((await loadAll(repo, 6)).map((o) => o.priceAmount)).toEqual([2]);
  });

  it("ignores rows whose source or structure this build does not know", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.savePrices([mkOffer({ priceAmount: 1 }), mkOffer({ priceAmount: 2, source: "kayak" as SourceName })]);
    expect((await loadAll(repo)).map((o) => o.priceAmount)).toEqual([1]);
  });

  it("tolerates corrupt JSON columns by falling back to empty legs", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.savePrices([mkOffer()]);
    await db.prepare("UPDATE prices SET legs_json = ?, includes_json = ?").bind("{nope", "[]").run();
    const [o] = await loadAll(repo);
    expect(o?.outbound).toEqual({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] });
    expect(o?.includes).toEqual({});
  });
});

describe("search cache", () => {
  const offers = [mkOffer({ totalIls: 606.5, tags: ["bonus_checked_bag"], extrasAmountIls: 40 })];

  it("returns a miss for an unknown key", async () => {
    expect(await createRepo(createTestD1()).getCachedOffers("nope", 6, NOW)).toBeNull();
  });

  it("round-trips the offers exactly as stored, with createdAt", async () => {
    const repo = createRepo(createTestD1());
    await repo.putCachedOffers("k1", offers, NOW);
    const hit = await repo.getCachedOffers("k1", 6, new Date(NOW.getTime() + HOUR));
    expect(hit).toEqual({ offers, createdAt: NOW.toISOString() });
  });

  it("honors maxAgeHours strictly at the boundary", async () => {
    const repo = createRepo(createTestD1());
    await repo.putCachedOffers("k", offers, NOW);
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(await repo.getCachedOffers("k", 6, at(6 * HOUR - 1))).not.toBeNull();
    expect(await repo.getCachedOffers("k", 6, at(6 * HOUR))).toBeNull();
    expect(await repo.getCachedOffers("k", 6, at(6 * HOUR + 1))).toBeNull();
    expect(await repo.getCachedOffers("k", 6, at(24 * HOUR))).toBeNull();
    expect(await repo.getCachedOffers("k", 0, NOW)).toBeNull();
    expect(await repo.getCachedOffers("k", Number.NaN, NOW)).toBeNull();
    // A longer TTL from another caller still sees the row.
    expect(await repo.getCachedOffers("k", 12, at(7 * HOUR))).not.toBeNull();
  });

  it("put replaces the previous entry and refreshes its age", async () => {
    const repo = createRepo(createTestD1());
    await repo.putCachedOffers("k", offers, NOW);
    const later = new Date(NOW.getTime() + 5 * HOUR);
    await repo.putCachedOffers("k", [mkOffer({ priceAmount: 999 })], later);
    const hit = await repo.getCachedOffers("k", 6, new Date(later.getTime() + 2 * HOUR));
    expect(hit?.offers.map((o) => o.priceAmount)).toEqual([999]);
    expect(hit?.createdAt).toBe(later.toISOString());
  });

  const pairs: OneWayPair[] = [
    {
      origin: "TLV",
      destination: "BCN",
      outs: [{ date: "2026-11-12", priceAmount: 79, priceCurrency: "USD", leg: { departTime: "06:15", arriveTime: null, stops: 0, durationMin: 290, airlines: ["W6"] }, deeplink: "https://www.aviasales.com/search/TLV1211BCN1?t=ow1" }],
      backs: [],
    },
  ];

  it("keeps the one-way fares and the scan notes beside the offers", async () => {
    const repo = createRepo(createTestD1());
    await repo.putCachedOffers("k", offers, NOW, { oneWayPairs: pairs, notes: ["truncated: 6 of 36 planned requests skipped (limit 30)"] });
    const hit = await repo.getCachedOffers("k", 6, NOW);
    expect(hit).toEqual({ offers, createdAt: NOW.toISOString(), oneWayPairs: pairs, notes: ["truncated: 6 of 36 planned requests skipped (limit 30)"] });
  });

  it("a row without extras (older writes, or none given) comes back without them, and a later put clears old extras", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.putCachedOffers("k", offers, NOW, { oneWayPairs: pairs, notes: [] });
    await repo.putCachedOffers("k", offers, NOW);
    expect(await repo.getCachedOffers("k", 6, NOW)).toEqual({ offers, createdAt: NOW.toISOString() });
    await db.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind("legacy", JSON.stringify(offers), NOW.toISOString()).run();
    expect(await repo.getCachedOffers("legacy", 6, NOW)).toEqual({ offers, createdAt: NOW.toISOString() });
  });

  it("damaged extras make the row a miss (half a row would silently drop the split tickets)", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    for (const [key, extra] of [["a", "{oops"], ["b", "[]"], ["c", JSON.stringify({ oneWayPairs: "x", notes: [] })]] as const) {
      await db.prepare("INSERT INTO search_cache (search_key, offers_json, extra_json, created_at) VALUES (?, ?, ?, ?)").bind(key, "[]", extra, NOW.toISOString()).run();
      expect(await repo.getCachedOffers(key, 6, NOW), key).toBeNull();
    }
  });

  it("caches an empty result set (a search that found nothing is still a search)", async () => {
    const repo = createRepo(createTestD1());
    await repo.putCachedOffers("k", [], NOW);
    expect(await repo.getCachedOffers("k", 6, NOW)).toEqual({ offers: [], createdAt: NOW.toISOString() });
  });

  it("treats an unreadable row as a miss and prunes very old rows on write", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await db.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind("bad", "{oops", NOW.toISOString()).run();
    expect(await repo.getCachedOffers("bad", 6, NOW)).toBeNull();
    await db.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind("ancient", "[]", ago(10 * DAY)).run();
    await repo.putCachedOffers("fresh", [], NOW);
    expect(await count(db, "search_cache")).toBe(2); // "bad" (now) + "fresh"; "ancient" pruned
  });
});

describe("priceContext", () => {
  const P = ["TLV", "BCN", "2026-11-10", "2026-11-15"] as const;
  const ctx = (repo: ReturnType<typeof createRepo>) => repo.priceContext(...P, NOW);
  const row = (amount: number, currency: string, ms: number, o: Partial<Offer> = {}) =>
    mkOffer({ priceAmount: amount, priceCurrency: currency, checkedAt: ago(ms), ...o });

  it("is null when there is no history for the exact pair", async () => {
    const repo = createRepo(createTestD1());
    expect(await ctx(repo)).toBeNull();
    await repo.savePrices([
      mkOffer({ departDate: "2026-11-11" }), // same route, other dates
      mkOffer({ destination: "ATH" }),
    ]);
    expect(await ctx(repo)).toBeNull();
  });

  it("never mixes currencies: the most recent row's currency wins for both numbers", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([
      row(300, "USD", 30 * DAY), // cheapest ever, but USD
      row(500, "USD", 8 * DAY),
      row(400, "EUR", 9 * DAY),
      row(350, "EUR", 3 * DAY),
      row(380, "EUR", HOUR), // most recent -> EUR
    ]);
    expect(await ctx(repo)).toEqual({ currency: "EUR", lowestAmount: 350, weekAgoAmount: 400 });

    // Flip the newest observation to USD and the same history reads in USD.
    await repo.savePrices([row(520, "USD", 10 * 60_000)]);
    expect(await ctx(repo)).toEqual({ currency: "USD", lowestAmount: 300, weekAgoAmount: 500 });
  });

  it("weekAgo is the most recent same-currency price at or before now-7d and within 14d", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([
      row(600, "USD", 20 * DAY), // older than 14d: never used as weekAgo
      row(550, "USD", 12 * DAY),
      row(530, "USD", 8 * DAY), // most recent eligible
      row(480, "USD", 6 * DAY), // too recent to be "a week ago"
      row(470, "USD", HOUR),
    ]);
    expect(await ctx(repo)).toEqual({ currency: "USD", lowestAmount: 470, weekAgoAmount: 530 });
  });

  it("weekAgo window boundaries are inclusive at both ends", async () => {
    const at = async (ms: number) => {
      const repo = createRepo(createTestD1());
      await repo.savePrices([row(700, "USD", ms), row(400, "USD", HOUR)]);
      return (await ctx(repo))?.weekAgoAmount;
    };
    expect(await at(7 * DAY)).toBe(700);
    expect(await at(7 * DAY - 1)).toBeNull();
    expect(await at(14 * DAY)).toBe(700);
    expect(await at(14 * DAY + 1)).toBeNull();
  });

  it("weekAgo is null but lowest is set when history is all recent", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([row(410, "USD", 2 * DAY), row(400, "USD", HOUR)]);
    expect(await ctx(repo)).toEqual({ currency: "USD", lowestAmount: 400, weekAgoAmount: null });
  });

  it("weekAgo ignores other-currency history even when it is the only week-old data", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([row(1500, "ILS", 9 * DAY), row(400, "USD", HOUR)]);
    expect(await ctx(repo)).toEqual({ currency: "USD", lowestAmount: 400, weekAgoAmount: null });
  });

  it("spans sources and ticket structures for the same pair", async () => {
    const repo = createRepo(createTestD1());
    await repo.savePrices([
      row(420, "USD", 3 * DAY, { source: "google_flights", ticketStructure: "split" }),
      row(450, "USD", HOUR),
    ]);
    expect(await ctx(repo)).toMatchObject({ currency: "USD", lowestAmount: 420 });
  });
});

describe("checkRateLimit", () => {
  const T = new Date("2026-11-01T12:00:30.000Z"); // 30s into a 60s window

  it("allows up to the limit, then denies", async () => {
    const repo = createRepo(createTestD1());
    const r = [] as Awaited<ReturnType<typeof repo.checkRateLimit>>[];
    for (let i = 0; i < 5; i++) r.push(await repo.checkRateLimit("ip:1", 3, 60, T));
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false, false]);
    expect(r.map((x) => x.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(r.slice(0, 3).map((x) => x.retryAfterSec)).toEqual([0, 0, 0]);
  });

  it("denied requests still count, so the retry hint grows with the hammering", async () => {
    const repo = createRepo(createTestD1());
    const wait: number[] = [];
    for (let i = 0; i < 5; i++) wait.push((await repo.checkRateLimit("ip:1", 3, 60, T)).retryAfterSec);
    // 4th request: this window ends in 30s, and its 4 requests weigh on the next window until 1 - 2/4 of it has passed
    expect(wait.slice(3)).toEqual([60, 66]);
  });

  it("retryAfterSec is honest: waiting that long makes the next request go through", async () => {
    for (const [limit, windowSec, before, hits] of [[3, 60, 30_000, 5], [3, 60, 0, 3], [10, 100, 50_000, 12], [1, 60, 45_000, 1], [30, 600, 599_000, 40]] as const) {
      const repo = createRepo(createTestD1());
      const start = new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + before);
      let last = { allowed: true, retryAfterSec: 0 };
      for (let i = 0; i <= hits; i++) last = await repo.checkRateLimit("ip:w", limit, windowSec, start);
      if (last.allowed) continue;
      const later = await repo.checkRateLimit("ip:w", limit, windowSec, new Date(start.getTime() + last.retryAfterSec * 1000));
      expect(later.allowed, `limit ${limit}/${windowSec}s after ${hits} hits`).toBe(true);
    }
  });

  it("does not let a client spend a full quota on both sides of a window boundary (no 2x burst)", async () => {
    const repo = createRepo(createTestD1());
    const boundary = Math.ceil(T.getTime() / 600_000) * 600_000; // a 10-minute boundary
    let allowed = 0;
    for (let i = 0; i < 30; i++) if ((await repo.checkRateLimit("ip:b", 30, 600, new Date(boundary - 1000))).allowed) allowed += 1;
    for (let i = 0; i < 30; i++) if ((await repo.checkRateLimit("ip:b", 30, 600, new Date(boundary))).allowed) allowed += 1;
    expect(allowed).toBe(30); // it used to be 60 within one second
  });

  it("fades the previous window's traffic in linearly", async () => {
    const repo = createRepo(createTestD1());
    const boundary = Math.ceil(T.getTime() / 100_000) * 100_000;
    for (let i = 0; i < 10; i++) await repo.checkRateLimit("ip:f", 10, 100, new Date(boundary - 1000)); // a full window
    // Halfway into the next window half of that traffic still counts: exactly 5 more requests fit.
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await repo.checkRateLimit("ip:f", 10, 100, new Date(boundary + 50_000))).allowed) allowed += 1;
    expect(allowed).toBe(5);
  });

  it("gives a client that was quiet in the previous window its full quota again", async () => {
    const repo = createRepo(createTestD1());
    const boundary = Math.ceil(T.getTime() / 60_000) * 60_000;
    await repo.checkRateLimit("ip:q", 3, 60, new Date(boundary - 1000)); // one request, long before
    const inNextWindow: boolean[] = [];
    for (let i = 0; i < 4; i++) inNextWindow.push((await repo.checkRateLimit("ip:q", 3, 60, new Date(boundary + 59_000))).allowed);
    // A minute-old request has almost faded out (1/60 left), but a full quota of 3 no longer fits next to it.
    expect(inNextWindow).toEqual([true, true, false, false]);
    // Two windows later nothing is left at all.
    const far = new Date(boundary + 3 * 60_000);
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push((await repo.checkRateLimit("ip:q", 3, 60, far)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it("keeps keys independent (callers namespace one key per limiter, e.g. search:<ip>)", async () => {
    const repo = createRepo(createTestD1());
    for (let i = 0; i < 3; i++) await repo.checkRateLimit("search:1", 2, 60, T);
    expect((await repo.checkRateLimit("search:1", 2, 60, T)).allowed).toBe(false);
    expect((await repo.checkRateLimit("search:2", 2, 60, T)).allowed).toBe(true);
    expect((await repo.checkRateLimit("watch:1", 2, 600, T)).allowed).toBe(true);
  });

  it("counts concurrent requests atomically: exactly `limit` are allowed", async () => {
    const repo = createRepo(createTestD1());
    const results = await Promise.all(Array.from({ length: 40 }, () => repo.checkRateLimit("ip:burst", 30, 600, T)));
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
    expect(new Set(results.map((r) => r.remaining)).size).toBe(30); // 29..0 for the allowed, 0 for the denied
    expect(Math.min(...results.map((r) => r.remaining))).toBe(0);
  });

  it("counts with one atomic upsert, and only reads the previous window in the same batch", async () => {
    const db = createTestD1();
    const prepare = vi.spyOn(db, "prepare");
    const batch = vi.spyOn(db, "batch");
    await createRepo(db).checkRateLimit("k", 5, 60, T);
    const sql = prepare.mock.calls.map((c) => String(c[0]));
    expect(sql[0]).toMatch(/INSERT INTO rate_limits[\s\S]*ON CONFLICT[\s\S]*DO UPDATE SET count = count \+ 1[\s\S]*RETURNING count/);
    expect(sql[1]).toMatch(/^SELECT count FROM rate_limits WHERE key = \? AND window_start = \?$/);
    expect(batch).toHaveBeenCalledTimes(1); // no read-modify-write race: the read cannot change the count
  });

  it("drops dead windows opportunistically when a new window starts", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const old = new Date(T.getTime() - 3 * DAY);
    await repo.checkRateLimit("ip:old", 5, 60, old);
    await repo.checkRateLimit("ip:old", 5, 60, new Date(old.getTime() + 120_000));
    expect(await count(db, "rate_limits")).toBe(2);
    await repo.checkRateLimit("ip:new", 5, 60, T); // first hit of a new window triggers the cleanup
    expect(await count(db, "rate_limits")).toBe(1);
    // A live window from another key is left alone.
    await repo.checkRateLimit("ip:live", 5, 3600, T);
    await repo.checkRateLimit("ip:other", 5, 60, new Date(T.getTime() + 5 * 60_000));
    expect(await count(db, "rate_limits")).toBe(3);
  });
});

describe("saveSearch", () => {
  it("stores the request as bound values and JSON columns", async () => {
    const db = createTestD1();
    await createRepo(db).saveSearch(mkRequest(), "key-1", NOW);
    const r = await db.prepare("SELECT * FROM searches").first<Record<string, unknown>>();
    expect(r).toMatchObject({
      search_key: "key-1", origin: "TLV", destination: "BCN", window_start: "2026-11-10", window_end: "2026-11-25",
      stay_min: 5, stay_max: 7, cabin: "economy", created_at: NOW.toISOString(), user_id: null,
    });
    expect(JSON.parse(String(r?.pax_json))).toEqual({ adults: 2, children: 1, infants: 0 });
    expect(JSON.parse(String(r?.extras_json))).toEqual({ checked_bag: true });
    expect(JSON.parse(String(r?.filters_json))).toEqual({ out_hours: [6, 12], ret_hours: null, max_stops: 1, nearby_airports: false });
  });

  it("stores an empty destination (spontaneous mode) as NULL", async () => {
    const db = createTestD1();
    await createRepo(db).saveSearch(mkRequest({ destination: "" }), "key-2", NOW);
    expect(await db.prepare("SELECT destination FROM searches").first("destination")).toBeNull();
  });
});

describe("fx rates", () => {
  const fx = { date: "2026-11-01", source: "bank_of_israel", ratesToIls: { USD: 3.65, EUR: 4.2, JPY: 0.024, ILS: 1 } };

  it("returns null for a date with no rows, and for an empty database", async () => {
    const repo = createRepo(createTestD1());
    expect(await repo.getFxRates("2026-11-01")).toBeNull();
    expect(await repo.getLatestFxRates()).toBeNull();
  });

  it("round-trips a day, always with ILS: 1", async () => {
    const repo = createRepo(createTestD1());
    await repo.saveFxRates({ ...fx, ratesToIls: { USD: 3.65, eur: 4.2 } });
    expect(await repo.getFxRates("2026-11-01")).toEqual({
      date: "2026-11-01", source: "bank_of_israel", ratesToIls: { USD: 3.65, EUR: 4.2, ILS: 1 },
    });
    expect(await repo.getFxRates("2026-11-02")).toBeNull();
  });

  it("re-saving the same day overwrites instead of failing on the primary key", async () => {
    const repo = createRepo(createTestD1());
    await repo.saveFxRates(fx);
    await repo.saveFxRates({ ...fx, source: "open.er-api.com", ratesToIls: { USD: 3.7, ILS: 1 } });
    const got = await repo.getFxRates("2026-11-01");
    expect(got?.source).toBe("open.er-api.com");
    expect(got?.ratesToIls.USD).toBe(3.7);
  });

  it("getLatestFxRates returns the newest stored day", async () => {
    const repo = createRepo(createTestD1());
    await repo.saveFxRates({ ...fx, date: "2026-10-20" });
    await repo.saveFxRates({ ...fx, date: "2026-10-30", ratesToIls: { USD: 3.5, ILS: 1 } });
    await repo.saveFxRates({ ...fx, date: "2026-10-25" });
    expect(await repo.getLatestFxRates()).toEqual({ date: "2026-10-30", source: "bank_of_israel", ratesToIls: { USD: 3.5, ILS: 1 } });
  });

  it("drops invalid rates and refuses to write a day with nothing usable", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.saveFxRates({ ...fx, ratesToIls: { USD: 3.65, EUR: -1, GBP: Number.NaN, JPY: 0, CHF: Number.POSITIVE_INFINITY, "BAD!": 2 } });
    expect((await repo.getFxRates("2026-11-01"))?.ratesToIls).toEqual({ USD: 3.65, ILS: 1 });
    await repo.saveFxRates({ ...fx, date: "2026-11-02", ratesToIls: { USD: -1 } });
    expect(await repo.getFxRates("2026-11-02")).toBeNull();
    await expect(repo.saveFxRates({ ...fx, date: "yesterday" })).rejects.toThrow();
  });

  it("a day without its ILS row (interrupted write) reads as missing, not as a partial table", async () => {
    const db = createTestD1();
    await db.prepare("INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES ('2026-11-01', 'USD', 3.65, 'x')").run();
    const repo = createRepo(db);
    expect(await repo.getFxRates("2026-11-01")).toBeNull();
    expect(await repo.getLatestFxRates()).toBeNull();
  });

  it("writes large rate tables in chunks of at most 50 statements", async () => {
    const db = createTestD1();
    const spy = vi.spyOn(db, "batch");
    const ratesToIls: Record<string, number> = {};
    for (let i = 0; i < 120; i++) ratesToIls[String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26), 65)] = 1 + i;
    await createRepo(db).saveFxRates({ date: "2026-11-01", source: "open.er-api.com", ratesToIls });
    expect(spy.mock.calls.every((c) => (c[0] as unknown[]).length <= 50)).toBe(true);
    expect(await count(db, "fx_rates")).toBe(121);
  });
});

describe("recordSourceHealth", () => {
  const health = (db: D1Database) => db.prepare("SELECT * FROM source_health WHERE source = 'travelpayouts'").first<Record<string, unknown>>();

  it("counts consecutive failures and resets on success", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.recordSourceHealth("travelpayouts", false, "HTTP 500", NOW);
    await repo.recordSourceHealth("travelpayouts", false, "HTTP 502", new Date(NOW.getTime() + HOUR));
    expect(await health(db)).toMatchObject({
      consecutive_failures: 2, last_error: "HTTP 502", last_error_at: new Date(NOW.getTime() + HOUR).toISOString(), last_ok_at: null,
    });
    await repo.recordSourceHealth("travelpayouts", true, null, new Date(NOW.getTime() + 2 * HOUR));
    expect(await health(db)).toMatchObject({
      consecutive_failures: 0, last_ok_at: new Date(NOW.getTime() + 2 * HOUR).toISOString(), last_error: "HTTP 502",
    });
    await repo.recordSourceHealth("travelpayouts", false, null, NOW);
    expect(await health(db)).toMatchObject({ consecutive_failures: 1, last_error: null });
  });

  it("never stores credentials from error text and caps its length", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const secret = "s3cr3t-T0KEN-value";
    await repo.recordSourceHealth(
      "travelpayouts",
      false,
      `fetch failed: https://api.travelpayouts.com/aviasales/v3/prices?token=${secret}&origin=TLV ` +
        `X-Access-Token: ${secret} Authorization: Bearer ${secret} {"api_key":"${secret}"} ` +
        "x".repeat(2000),
      NOW,
    );
    const stored = String((await health(db))?.last_error);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("origin=TLV");
    expect(stored.length).toBeLessThanOrEqual(300);
  });
});

describe("hostile strings", () => {
  const evil = "TLV'; DROP TABLE prices; --";
  const evil2 = `BCN" OR 1=1; DELETE FROM prices WHERE '1'='1`;

  it("cannot break out of any statement, and the data comes back exactly", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    const o = mkOffer({
      origin: evil,
      destination: evil2,
      deeplink: `https://x.example/?q='; DROP TABLE prices; --`,
      outbound: { departTime: "07:30", arriveTime: null, stops: 0, durationMin: null, airlines: ["L'Y", `W"6`] },
    });
    await repo.savePrices([o, mkOffer()]);

    const got = await repo.loadRecentOffers(evil, evil2, "2026-11-01", "2026-12-31", 24, NOW);
    expect(got).toEqual([{ ...o, extrasAmountIls: 0, totalIls: null, tags: [] }]);

    // Injection-shaped lookups match nothing rather than everything.
    expect(await repo.loadRecentOffers("TLV' OR '1'='1", "BCN", "2026-11-01", "2026-12-31", 24, NOW)).toEqual([]);
    expect(await repo.loadRecentOffers("TLV", "BCN", "2026-11-01", "2026-12-31", 24, NOW, ["x'); DROP TABLE prices; --" as SourceName])).toEqual([]);
    expect(await repo.priceContext(evil, evil2, "2026-11-10", "2026-11-15", NOW)).toMatchObject({ currency: "USD" });
    expect(await repo.priceContext("TLV' OR '1'='1", "BCN", "2026-11-10", "2026-11-15", NOW)).toBeNull();

    await repo.saveSearch(mkRequest({ origin: evil, destination: evil2 }), evil, NOW);
    await repo.putCachedOffers(evil, [o], NOW);
    expect((await repo.getCachedOffers(evil, 6, NOW))?.offers).toEqual([o]);
    expect(await repo.getCachedOffers("' OR '1'='1", 6, NOW)).toBeNull();
    expect((await repo.checkRateLimit(evil, 2, 60, NOW)).allowed).toBe(true);
    await repo.recordSourceHealth("travelpayouts", false, evil, NOW);

    // Every table is still there and holds what was written.
    expect(await count(db, "prices")).toBe(2);
    expect(await count(db, "searches")).toBe(1);
    expect(await count(db, "search_cache")).toBe(1);
    expect(await count(db, "rate_limits")).toBe(1);
    expect(await db.prepare("SELECT origin FROM searches").first("origin")).toBe(evil);
    expect(await db.prepare("SELECT key FROM rate_limits").first("key")).toBe(evil);
    expect(await db.prepare("SELECT last_error FROM source_health").first("last_error")).toBe(evil);
  });
});


describe("pruneHistory (daily retention)", () => {
  const dayIso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString().slice(0, 10);

  it("drops fares of trips that departed long ago and keeps everything that can still be searched", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.savePrices([
      mkOffer({ priceAmount: 1, departDate: dayIso(-PRICES_GRACE_DAYS - 1), returnDate: dayIso(-PRICES_GRACE_DAYS + 4) }), // gone
      mkOffer({ priceAmount: 2, departDate: dayIso(-PRICES_GRACE_DAYS), returnDate: dayIso(-PRICES_GRACE_DAYS + 5) }), // edge: kept
      mkOffer({ priceAmount: 3, departDate: dayIso(30), returnDate: dayIso(35), checkedAt: ago(200 * DAY) }), // old row, future trip: kept
    ]);
    const res = await pruneHistory(db, NOW);
    expect(res.prices).toBe(1);
    const left = (await db.prepare("SELECT price_amount FROM prices ORDER BY id").all<{ price_amount: number }>()).results.map((r) => r.price_amount);
    expect(left).toEqual([2, 3]);
  });

  it("trims the search log, the cache and the rate-limit windows by age", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    await repo.saveSearch(mkRequest(), "old", new Date(NOW.getTime() - (SEARCHES_RETENTION_DAYS + 1) * DAY));
    await repo.saveSearch(mkRequest(), "new", new Date(NOW.getTime() - (SEARCHES_RETENTION_DAYS - 1) * DAY));
    await db.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind("stale", "[]", ago(8 * DAY)).run();
    await db.prepare("INSERT INTO search_cache (search_key, offers_json, created_at) VALUES (?, ?, ?)").bind("fresh", "[]", ago(HOUR)).run();
    const nowSec = Math.floor(NOW.getTime() / 1000);
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1), (?, ?, 1)").bind("dead", nowSec - 2 * 86_400, "live", nowSec - 60).run();
    const res = await pruneHistory(db, NOW);
    expect(res).toEqual({ prices: 0, searches: 1, search_cache: 1, rate_limits: 1 });
    expect(await count(db, "searches")).toBe(1);
    expect(await count(db, "search_cache")).toBe(1);
    expect(await count(db, "rate_limits")).toBe(1);
  });

  it("is a no-op on an empty database", async () => {
    expect(await pruneHistory(createTestD1(), NOW)).toEqual({ prices: 0, searches: 0, search_cache: 0, rate_limits: 0 });
  });
});
