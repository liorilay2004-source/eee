/**
 * Deal reports (src/dealreports.ts) and GET /api/deals: the bounded two-query read must give the detector exactly the
 * verdicts it would give on the whole table, the labels must say only what the data supports, and the endpoint must
 * be cheap (cached, one small read) and never call out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import { createRepo } from "../src/db";
import {
  computeRouteReport,
  FX_MAX_AGE_DAYS,
  routeAirports,
  loadDeals,
  MAX_REPORT_ROWS,
  RECENT_LIMIT,
  refreshDealReport,
  REPORT_MAX_AGE_HOURS,
  resetDealsCache,
  routeView,
  STATUS_LABELS_HE,
  type RouteReport,
} from "../src/dealreports";
import { DEAL_CONFIG, detectDeals, type DealPriceRow } from "../src/deals";
import { pickSnapshotRoute, runSnapshot, SNAPSHOT_ROUTES } from "../src/snapshots";
import type { Env, Offer, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

async function put(db: D1Database, r: { o?: string; d?: string; dep: string; ret: string; price: number; cur?: string; at: string; structure?: string }): Promise<void> {
  await db
    .prepare(
      "INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, legs_json, includes_json, checked_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'travelpayouts', ?, '[\"LY\"]', '{}', '{}', ?)",
    )
    .bind(r.o ?? "TLV", r.d ?? "BCN", r.dep, r.ret, r.price, r.cur ?? "ILS", r.structure ?? "roundtrip", r.at)
    .run();
}

/** 14 daily observations of one pair around 1000 ILS, then a fresh check at `fresh`. */
async function seedPair(db: D1Database, dep: string, ret: string, fresh: number, o = "TLV", d = "BCN"): Promise<void> {
  for (let i = 1; i <= 14; i++) await put(db, { o, d, dep, ret, price: 1000 + ((i * 17) % 40), at: at(i * DAY + 3 * HOUR) });
  await put(db, { o, d, dep, ret, price: fresh, at: at(HOUR) });
}

async function allRows(db: D1Database): Promise<DealPriceRow[]> {
  return (await db.prepare("SELECT origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, checked_at FROM prices").all<DealPriceRow>()).results;
}

const report = (over: Partial<RouteReport> = {}): RouteReport => ({
  v: 1,
  origin: "TLV",
  destination: "BCN",
  computedAt: NOW.toISOString(),
  deals: [],
  dealsTotal: 0,
  stats: { rows: 0, buckets: 0, staleBuckets: 0, insufficientBuckets: 0, skippedNoRate: 0, missingCurrencies: [], skippedInvalid: 0, skippedFuture: 0 },
  judgedBuckets: 0,
  readiness: null,
  rowsRead: { recent: 0, history: 0 },
  truncated: false,
  fx: null,
  ...over,
});

beforeEach(() => resetDealsCache());

describe("computeRouteReport", () => {
  it("an empty history is no data, not a verdict", async () => {
    const r = await computeRouteReport(createTestD1(), "TLV", "BCN", NOW);
    expect(r).toMatchObject({ deals: [], judgedBuckets: 0, readiness: null, truncated: false, rowsRead: { recent: 0, history: 0 } });
    expect(routeView("TLV", "BCN", r, NOW).status).toBe("no_recent_data");
  });

  it("finds a deal against the pair's own history", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 600);
    const r = await computeRouteReport(db, "TLV", "BCN", NOW);
    expect(r.deals).toHaveLength(1);
    expect(r.deals[0]).toMatchObject({ verdict: "deal", departDate: "2026-11-10", returnDate: "2026-11-15", priceIls: 600 });
    expect(r.judgedBuckets).toBe(1);
    const view = routeView("TLV", "BCN", r, NOW);
    expect(view.status).toBe("deals");
    expect(view.deals[0]).toMatchObject({ ageHours: 1, labelHe: expect.stringMatching(/[֐-׿]/) });
  });

  it("labels a 50%+ unusual drop an error fare", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 400);
    expect((await computeRouteReport(db, "TLV", "BCN", NOW)).deals[0]?.verdict).toBe("error_fare");
  });

  it("a normal price in a judged bucket is no_deal", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 1010);
    const r = await computeRouteReport(db, "TLV", "BCN", NOW);
    expect(r.deals).toEqual([]);
    expect(routeView("TLV", "BCN", r, NOW).status).toBe("no_deal");
  });

  it("thin history is insufficient_data, with readiness counting what exists", async () => {
    const db = createTestD1();
    for (let i = 1; i <= 5; i++) await put(db, { dep: "2026-11-10", ret: "2026-11-15", price: 1000, at: at(i * DAY) });
    await put(db, { dep: "2026-11-10", ret: "2026-11-15", price: 300, at: at(HOUR) });
    const r = await computeRouteReport(db, "TLV", "BCN", NOW);
    expect(r.deals).toEqual([]);
    expect(r.readiness).toEqual({ sampleSize: 5, spanDays: 4 });
    const view = routeView("TLV", "BCN", r, NOW);
    expect(view.status).toBe("insufficient_data");
    expect(view.labelHe).toBe(STATUS_LABELS_HE.insufficient_data);
  });

  it("gives the same deals as the detector over the whole table (noise, other routes, other pairs, past trips)", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 600); // Nov, 4-6n: a deal
    await seedPair(db, "2026-12-03", "2026-12-10", 450); // Dec, 7-10n: an error fare
    await seedPair(db, "2026-11-20", "2026-11-28", 1005); // Nov, 7-10n: normal
    await seedPair(db, "2026-11-10", "2026-11-15", 500, "TLV", "ATH"); // another route
    // Same bucket as the first pair, a cheaper fare seen only long ago: must not become the baseline or the candidate.
    for (let i = 3; i <= 10; i++) await put(db, { dep: "2026-11-12", ret: "2026-11-17", price: 300, at: at(i * DAY) });
    // A stale bucket (nothing in the last 48h) and a trip that already departed.
    for (let i = 3; i <= 10; i++) await put(db, { dep: "2027-01-05", ret: "2027-01-10", price: 900, at: at(i * DAY) });
    await put(db, { dep: "2026-09-20", ret: "2026-09-25", price: 10, at: at(HOUR) });

    const r = await computeRouteReport(db, "TLV", "BCN", NOW);
    const full = detectDeals((await allRows(db)).filter((x) => x.destination === "BCN" && x.depart_date >= "2026-10-01"), {}, NOW);
    expect(r.deals).toEqual(full.deals);
    expect(r.deals.map((d) => d.verdict)).toEqual(["error_fare", "deal"]);
    expect(r.judgedBuckets).toBe(3);
    // Only the three candidate pairs' rows older than 48h were read (13 each: the 27h-old one is recent), not the
    // stale bucket, not the old cheap pair.
    expect(r.rowsRead.history).toBe(3 * 13);
  });

  it("skips rows without a stored rate (never guessed) and uses stored FX when there is one, with no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = createTestD1();
    for (let i = 1; i <= 14; i++) await put(db, { dep: "2026-11-10", ret: "2026-11-15", price: 270 + (i % 3), cur: "USD", at: at(i * DAY + HOUR) });
    await put(db, { dep: "2026-11-10", ret: "2026-11-15", price: 160, cur: "USD", at: at(HOUR) });
    const without = await computeRouteReport(db, "TLV", "BCN", NOW);
    // Only the recent rows are read: with no rate there is no candidate, so no history is loaded for it.
    expect(without.stats).toMatchObject({ skippedNoRate: 2, missingCurrencies: ["USD"] });
    expect(without.rowsRead.history).toBe(0);
    expect(without.deals).toEqual([]);
    expect(without.fx).toBeNull();

    for (const [cur, rate] of [["USD", 3.7], ["ILS", 1]] as const) {
      await db.prepare("INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES ('2026-09-30', ?, ?, 'bank_of_israel')").bind(cur, rate).run();
    }
    const withFx = await computeRouteReport(db, "TLV", "BCN", NOW);
    expect(withFx.fx).toEqual({ date: "2026-09-30", source: "bank_of_israel" });
    expect(withFx.deals[0]).toMatchObject({ verdict: "deal", priceCurrency: "USD", priceIls: 592 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reports a hit read limit as truncated", async () => {
    const db = createTestD1();
    const stmts = [];
    for (let i = 0; i < RECENT_LIMIT + 100; i++) {
      stmts.push(
        db
          .prepare("INSERT INTO prices (origin, destination, depart_date, return_date, price_amount, price_currency, source, ticket_structure, airlines_json, legs_json, includes_json, checked_at) VALUES ('TLV', 'BCN', '2026-11-10', '2026-11-15', ?, 'ILS', 'travelpayouts', 'roundtrip', '[]', '{}', '{}', ?)")
          .bind(900 + i, at((i % 40) * HOUR)),
      );
    }
    await db.batch(stmts);
    const r = await computeRouteReport(db, "TLV", "BCN", NOW);
    expect(r.rowsRead.recent).toBe(RECENT_LIMIT);
    expect(r.truncated).toBe(true);
    expect(routeView("TLV", "BCN", r, NOW).truncated).toBe(true);
    // (B) continues where the cut-short (A) stopped: the older rows of the same pair inside the 48h window are history.
    expect(r.rowsRead.history).toBeGreaterThan(0);
  });
});

describe("refreshDealReport", () => {
  it("upserts one row per route", async () => {
    const db = createTestD1();
    await refreshDealReport(db, "TLV", "BCN", NOW);
    await refreshDealReport(db, "TLV", "BCN", new Date(NOW.getTime() + HOUR));
    const rows = (await db.prepare("SELECT route, computed_at FROM deal_reports").all()).results;
    expect(rows).toEqual([{ route: "TLV-BCN", computed_at: new Date(NOW.getTime() + HOUR).toISOString() }]);
  });

  it("never throws when the database is down", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refreshDealReport(broken, "TLV", "BCN", NOW)).resolves.toBeNull();
    err.mockRestore();
  });
});

describe("routeView (read-time honesty)", () => {
  const deal = { verdict: "deal" as const, origin: "TLV", destination: "BCN", departDate: "2026-11-10", returnDate: "2026-11-15", ticketStructure: "roundtrip", source: "travelpayouts", airlines: [], priceAmount: 600, priceCurrency: "ILS", priceIls: 600, dropPct: 40, bucket: "b", evidence: { baselineIls: 1000, madIls: 20, robustZ: -13, sampleSize: 14, spanDays: 13 }, reason: "r" };

  it("no report is not_computed", () => {
    expect(routeView("TLV", "BCN", null, NOW)).toMatchObject({ status: "not_computed", computedAt: null, buckets: null, deals: [] });
  });

  it("an old report is stale and shows no deals", () => {
    const old = report({ computedAt: at((REPORT_MAX_AGE_HOURS + 1) * HOUR), deals: [{ ...deal, checkedAt: at(HOUR) }], judgedBuckets: 1 });
    expect(routeView("TLV", "BCN", old, NOW)).toMatchObject({ status: "stale", deals: [] });
  });

  it("a deal checked more than liveWithinHours ago (counted from now) is not shown", () => {
    const r = report({ computedAt: at(2 * HOUR), deals: [{ ...deal, checkedAt: at((DEAL_CONFIG.liveWithinHours + 1) * HOUR) }], judgedBuckets: 1 });
    expect(routeView("TLV", "BCN", r, NOW)).toMatchObject({ status: "stale", deals: [] });
  });

  it("every status has a Hebrew label", () => {
    for (const label of Object.values(STATUS_LABELS_HE)) expect(label).toMatch(/[֐-׿]/);
  });
});

describe("loadDeals", () => {
  it("lists every watched route in watchlist order, uncomputed ones included", async () => {
    const db = createTestD1();
    await refreshDealReport(db, "TLV", "ATH", NOW);
    const body = await loadDeals(db, NOW);
    expect(body.routes.map((r) => `${r.origin}-${r.destination}`)).toEqual(SNAPSHOT_ROUTES.map(([o, d]) => `${o}-${d}`));
    expect(body.routes.find((r) => r.destination === "ATH")?.status).toBe("no_recent_data");
    expect(body.routes.find((r) => r.destination === "BCN")?.status).toBe("not_computed");
    expect(body).toMatchObject({ asOf: NOW.toISOString(), priceBasis: "per_traveller", thresholds: { minSamples: DEAL_CONFIG.minSamples } });
    expect(body.noteHe).toMatch(/[֐-׿]/);
    expect(MAX_REPORT_ROWS).toBeGreaterThan(SNAPSHOT_ROUTES.length);
  });

  it("reads only the watched routes, never a leftover row", async () => {
    const db = createTestD1();
    await db.prepare("INSERT INTO deal_reports (route, computed_at, report_json) VALUES ('TLV-XXX', ?, '{}')").bind(NOW.toISOString()).run();
    const body = await loadDeals(db, NOW, [["TLV", "BCN"]]);
    expect(body.routes.map((r) => r.status)).toEqual(["not_computed"]);
    resetDealsCache();
    expect((await loadDeals(db, NOW, [])).routes).toEqual([]);
  });

  it("a corrupt or mismatched stored report reads as not_computed", async () => {
    const db = createTestD1();
    await db.prepare("INSERT INTO deal_reports (route, computed_at, report_json) VALUES ('TLV-BCN', ?, '{not json')").bind(NOW.toISOString()).run();
    await db.prepare("INSERT INTO deal_reports (route, computed_at, report_json) VALUES ('TLV-ATH', ?, ?)").bind(NOW.toISOString(), JSON.stringify(report())).run();
    const body = await loadDeals(db, NOW);
    expect(body.routes.find((r) => r.destination === "BCN")?.status).toBe("not_computed");
    expect(body.routes.find((r) => r.destination === "ATH")?.status).toBe("not_computed"); // the stored JSON says TLV-BCN
  });

  it("caches the built response per isolate for a few minutes", async () => {
    const db = createTestD1();
    const spy = vi.spyOn(db, "prepare");
    await loadDeals(db, NOW);
    await loadDeals(db, new Date(NOW.getTime() + 60_000));
    expect(spy).toHaveBeenCalledTimes(1);
    await loadDeals(db, new Date(NOW.getTime() + 10 * 60_000));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/deals and the snapshot cron", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const ctxOf = (pending: Promise<unknown>[]) => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

  it("answers 200 JSON, no-store, and makes no outbound call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(new Request("https://api.example.test/api/deals"), { DB: createTestD1() } as Env, ctxOf([]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { routes: unknown[] };
    expect(body.routes).toHaveLength(SNAPSHOT_ROUTES.length);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is GET only", async () => {
    const res = await worker.fetch(new Request("https://api.example.test/api/deals", { method: "POST" }), { DB: createTestD1() } as Env, ctxOf([]));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("503 with a stable code when the database is down (and the failure is not cached)", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    const res = await worker.fetch(new Request("https://api.example.test/api/deals"), { DB: broken } as Env, ctxOf([]));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("deals_unavailable");
    const ok = await worker.fetch(new Request("https://api.example.test/api/deals"), { DB: createTestD1() } as Env, ctxOf([]));
    expect(ok.status).toBe(200);
  });

  it("the hourly cron writes the report of the route it scanned, even without a Travelpayouts token", async () => {
    const env = { DB: createTestD1() } as Env;
    await seedPair(env.DB, "2026-11-10", "2026-11-15", 600, ...pickSnapshotRoute(NOW));
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "43 * * * *", noRetry() {} } as ScheduledController, env, ctxOf(pending));
    await Promise.all(pending);
    const [o, d] = pickSnapshotRoute(NOW);
    const rows = (await env.DB.prepare("SELECT route FROM deal_reports").all<{ route: string }>()).results;
    expect(rows).toEqual([{ route: `${o}-${d}` }]);
    const res = await worker.fetch(new Request("https://api.example.test/api/deals"), env, ctxOf([]));
    const body = (await res.json()) as { routes: Array<{ origin: string; destination: string; status: string }> };
    expect(body.routes.find((r) => r.origin === o && r.destination === d)?.status).toBe("deals");
  });

  it("does not fetch airline pages on the hourly timer unless background collection is explicitly enabled", async () => {
    const fetchFn = vi.fn(async () => new Response("unexpected outbound request", { status: 500 }));
    vi.stubGlobal("fetch", fetchFn);
    const env = { DB: createTestD1(), TAP_PUBLISHED_ENABLED: "true", AIRLINE_BACKGROUND_COLLECTION_ENABLED: "false" } as Env;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "43 * * * *", noRetry() {} } as ScheduledController, env, ctxOf(pending));
    await Promise.all(pending);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the daily retention cron does not compute reports", async () => {
    const env = { DB: createTestD1() } as Env;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env, ctxOf(pending));
    await Promise.all(pending);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM deal_reports").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("watched city routes resolve to the airports the scan stores", () => {
  const offer = (dest: string, price: number, checkedAt: string): Offer => ({
    origin: "TLV",
    destination: dest,
    departDate: "2026-11-10",
    returnDate: "2026-11-15",
    priceAmount: price,
    priceCurrency: "ILS",
    source: "travelpayouts",
    ticketStructure: "roundtrip",
    outbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] },
    inbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] },
    includes: {},
    deeplink: null,
    verifyLink: null,
    checkedAt,
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
  });

  it("every watched route has airports; city routes expand like the scan (LON -> LHR, LGW, ...)", () => {
    for (const [o, d] of SNAPSHOT_ROUTES) {
      const a = routeAirports(o, d, NOW);
      expect(a.origins.length, `${o}-${d}`).toBeGreaterThan(0);
      expect(a.destinations.length, `${o}-${d}`).toBeGreaterThan(0);
    }
    expect(routeAirports("TLV", "LON", NOW).destinations).toEqual(expect.arrayContaining(["LHR", "LGW"]));
    expect(routeAirports("TLV", "LON", NOW).destinations).not.toContain("LON");
    // Since the route hints (#15) the scan skips Ovda (VDA, no scheduled service) when Ramon remains, so reports follow it.
    expect(routeAirports("ETM", "ATH", NOW).origins).toEqual(["ETM"]);
  });

  it("TLV-LON end to end: runSnapshot stores airport rows, refreshDealReport finds the LHR deal and judges LGW", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 1000, "TLV", "LHR");
    await seedPair(db, "2026-11-10", "2026-11-15", 1000, "TLV", "LGW");
    await db.prepare("DELETE FROM prices WHERE checked_at >= ?").bind(at(2 * HOUR)).run(); // drop the seeded fresh checks
    const asked: string[] = [];
    const tp: TravelpayoutsClient = {
      configured: true,
      callCount: () => asked.length,
      async roundTrips(origin, destination) {
        asked.push(`${origin}-${destination}`);
        if (destination === "LHR") return [offer("LHR", 600, NOW.toISOString())];
        if (destination === "LGW") return [offer("LGW", 1010, NOW.toISOString())];
        return [];
      },
      async oneWays() {
        return [];
      },
    };
    const snap = await runSnapshot({ repo: createRepo(db), tp, fx: { date: "2026-10-01", source: "test", ratesToIls: { ILS: 1, USD: 3.7 } }, now: NOW }, [["TLV", "LON"]]);
    expect(snap.ok).toBe(true);
    const stored = (await db.prepare("SELECT DISTINCT destination FROM prices WHERE checked_at = ?").bind(NOW.toISOString()).all<{ destination: string }>()).results;
    expect(stored.map((r) => r.destination).sort()).toEqual(["LGW", "LHR"]);

    const r = await refreshDealReport(db, "TLV", "LON", new Date(NOW.getTime() + 60_000));
    expect(r?.deals).toHaveLength(1);
    expect(r?.deals[0]).toMatchObject({ verdict: "deal", origin: "TLV", destination: "LHR", priceIls: 600 });
    expect(r?.judgedBuckets).toBe(2); // LHR and LGW are separate series
    const body = await loadDeals(db, new Date(NOW.getTime() + 120_000));
    expect(body.routes.find((x) => x.destination === "LON")?.status).toBe("deals");
  });

  it("ETM-ATH reads the airports the scan stores (Ramon), not a skipped sibling (Ovda)", async () => {
    const db = createTestD1();
    await seedPair(db, "2026-11-10", "2026-11-15", 600, "ETM", "ATH");
    const r = await computeRouteReport(db, "ETM", "ATH", NOW);
    expect(r.deals[0]).toMatchObject({ origin: "ETM", destination: "ATH", verdict: "deal" });
  });
});

describe("report freshness and FX", () => {
  it("a report is fresh for one whole watchlist cycle, plus slack", () => {
    expect(REPORT_MAX_AGE_HOURS).toBeGreaterThan(SNAPSHOT_ROUTES.length);
    expect(REPORT_MAX_AGE_HOURS).toBeLessThanOrEqual(SNAPSHOT_ROUTES.length + 12);
    const r = report({ computedAt: at((SNAPSHOT_ROUTES.length + 1) * HOUR), judgedBuckets: 1 });
    expect(routeView("TLV", "BCN", r, NOW).status).toBe("no_deal");
  });

  it("stored FX is shown with the report, and marked stale when it is old or a fallback day", () => {
    const fresh = routeView("TLV", "BCN", report({ fx: { date: "2026-10-01", source: "bank_of_israel" } }), NOW);
    expect(fresh.fx).toEqual({ date: "2026-10-01", source: "bank_of_israel", stale: false });
    const yesterday = routeView("TLV", "BCN", report({ fx: { date: "2026-09-30", source: "bank_of_israel" } }), NOW);
    expect(yesterday.fx?.stale).toBe(false);
    const old = routeView("TLV", "BCN", report({ fx: { date: "2026-09-28", source: "bank_of_israel" } }), NOW);
    expect(old.fx?.stale).toBe(true);
    const fallback = routeView("TLV", "BCN", report({ fx: { date: "2026-10-01", source: "bank_of_israel:stale" } }), NOW);
    expect(fallback.fx?.stale).toBe(true);
    expect(routeView("TLV", "BCN", report(), NOW).fx).toBeNull();
    expect(FX_MAX_AGE_DAYS).toBe(1);
  });
});
