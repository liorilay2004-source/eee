/**
 * Fare freshness (freshness.ts): the card must say how old the FARE is when that is known, and say plainly when it is
 * not (every Travelpayouts v3 fare), never passing our own scan time off as the fare's age. Expired fares are never ranked.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import {
  classifyAge,
  earlierOf,
  FARE_AGING_MAX_HOURS,
  FARE_FRESH_MAX_HOURS,
  fareExpired,
  fareFreshness,
  FOUND_AT_MAX_SKEW_MS,
  hebrewAgo,
  LIVE_FARE_SOURCES,
  olderOf,
  vendorTimestamp,
} from "../src/freshness";
import { runSearch, sanitizeOffers, sanitizeOneWayPairs, type SearchDeps } from "../src/pipeline";
import { QUOTE_SOURCE_NAMES } from "../src/quotes";
import { buildSplits } from "../src/splits";
import { createTravelpayoutsClient, monthsBetween } from "../src/travelpayouts";
import type { FxRates, Leg, Offer, OneWayFare, SearchRequest, TravelpayoutsClient } from "../src/types";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import { createTestD1 } from "./helpers/d1";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3 } };

const leg = (over: Partial<Leg> = {}): Leg => ({ departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over });

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
    checkedAt: NOW.toISOString(),
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
    ...over,
  };
}

const fare = (date: string, price: number, over: Partial<OneWayFare> = {}): OneWayFare => ({
  date,
  priceAmount: price,
  priceCurrency: "USD",
  leg: leg({ airlines: ["W6"] }),
  deeplink: `https://www.aviasales.com/x/${date}`,
  ...over,
});

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7,
    adults: 1, children: 0, infants: 0, cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null,
    nearbyAirports: false, ...over,
  };
}

function mockTp(rt: Offer[], ow: { outs?: OneWayFare[]; backs?: OneWayFare[] } = {}): TravelpayoutsClient {
  let calls = 0;
  return {
    configured: true,
    callCount: () => calls,
    async roundTrips(o, d, ws, we) {
      calls += monthsBetween(ws, we).length;
      return o === "TLV" && d === "BCN" ? rt.map((x) => structuredClone(x)) : [];
    },
    async oneWays(o, d, ws, we) {
      calls += monthsBetween(ws, we).length;
      if (o === "TLV" && d === "BCN") return (ow.outs ?? []).map((x) => structuredClone(x));
      if (o === "BCN" && d === "TLV") return (ow.backs ?? []).map((x) => structuredClone(x));
      return [];
    },
  };
}

function deps(tp: TravelpayoutsClient, now: Date = NOW): SearchDeps {
  return { repo: createRepo(createTestD1()), tp, fx: vi.fn(async () => FX), now };
}

// --- units ------------------------------------------------------------------------------------------------

describe("vendorTimestamp", () => {
  it("accepts zoned ISO times and returns canonical UTC", () => {
    expect(vendorTimestamp("2015-09-22T14:08:45+04:00")).toBe("2015-09-22T10:08:45.000Z");
    expect(vendorTimestamp("2015-01-08T18:30:40Z")).toBe("2015-01-08T18:30:40.000Z");
    expect(vendorTimestamp(" 2026-10-30T08:00Z ")).toBe("2026-10-30T08:00:00.000Z");
    expect(vendorTimestamp("2028-02-29T00:00:00.5-0100")).toBe("2028-02-29T01:00:00.500Z");
  });

  it("rejects what would have to be guessed: zoneless, date-only, non-ISO, non-strings, impossible dates", () => {
    for (const v of ["2026-10-30T08:00:00", "2026-10-30", "Oct 30 2026 08:00 GMT", "", "garbage", "2026-13-40T99:99:99Z", "2026-02-30T08:00:00Z", "2026-10-30T24:00:00Z", "2026-10-30T08:60:00Z", 1_700_000_000, null, undefined, {}]) {
      expect(vendorTimestamp(v), String(v)).toBeNull();
    }
  });

  it("does not believe a found_at later than our own fetch beyond a small clock skew", () => {
    const at = NOW.getTime();
    expect(vendorTimestamp(later(FOUND_AT_MAX_SKEW_MS), at)).toBe(later(FOUND_AT_MAX_SKEW_MS));
    expect(vendorTimestamp(later(FOUND_AT_MAX_SKEW_MS + 1000), at)).toBeNull();
    expect(vendorTimestamp(later(DAY))).toBe(later(DAY)); // no bound given (expiry): future is normal
  });
});

describe("olderOf / earlierOf / fareExpired", () => {
  it("a split's found time is the older leg's, and unknown if either leg is unknown", () => {
    expect(olderOf(ago(HOUR), ago(2 * HOUR))).toBe(ago(2 * HOUR));
    expect(olderOf(ago(HOUR), null)).toBeNull();
    expect(olderOf(undefined, ago(HOUR))).toBeNull();
  });

  it("a split expires with its first known leg expiry", () => {
    expect(earlierOf(later(HOUR), later(2 * HOUR))).toBe(later(HOUR));
    expect(earlierOf(later(HOUR), null)).toBe(later(HOUR));
    expect(earlierOf(undefined, later(HOUR))).toBe(later(HOUR));
    expect(earlierOf(null, undefined)).toBeNull();
  });

  it("expired only when a stated expiry is at or before now", () => {
    expect(fareExpired({}, NOW)).toBe(false);
    expect(fareExpired({ fareExpiresAt: null }, NOW)).toBe(false);
    expect(fareExpired({ fareExpiresAt: later(1) }, NOW)).toBe(false);
    expect(fareExpired({ fareExpiresAt: NOW.toISOString() }, NOW)).toBe(true);
    expect(fareExpired({ fareExpiresAt: ago(MIN) }, NOW)).toBe(true);
    expect(fareExpired({ fareExpiresAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("classifyAge / hebrewAgo", () => {
  it("fresh < 24h <= aging < 72h <= stale", () => {
    expect(classifyAge(0)).toBe("fresh");
    expect(classifyAge(FARE_FRESH_MAX_HOURS - 0.1)).toBe("fresh");
    expect(classifyAge(FARE_FRESH_MAX_HOURS)).toBe("aging");
    expect(classifyAge(FARE_AGING_MAX_HOURS - 0.1)).toBe("aging");
    expect(classifyAge(FARE_AGING_MAX_HOURS)).toBe("stale");
  });

  it("uses Hebrew singular/dual/plural forms and rounds down", () => {
    expect(hebrewAgo(0)).toBe("ממש עכשיו");
    expect(hebrewAgo(0.9)).toBe("ממש עכשיו");
    expect(hebrewAgo(-5)).toBe("ממש עכשיו");
    expect(hebrewAgo(1)).toBe("לפני דקה");
    expect(hebrewAgo(2)).toBe("לפני שתי דקות");
    expect(hebrewAgo(59)).toBe("לפני 59 דקות");
    expect(hebrewAgo(60)).toBe("לפני שעה");
    expect(hebrewAgo(119)).toBe("לפני שעה");
    expect(hebrewAgo(120)).toBe("לפני שעתיים");
    expect(hebrewAgo(5 * 60)).toBe("לפני 5 שעות");
    expect(hebrewAgo(24 * 60)).toBe("לפני יום");
    expect(hebrewAgo(48 * 60)).toBe("לפני יומיים");
    expect(hebrewAgo(6 * 24 * 60)).toBe("לפני 6 ימים");
  });
});

describe("fareFreshness", () => {
  it("a Travelpayouts fare without found_at: age unknown, and the label says so instead of implying a live check", () => {
    const f = fareFreshness(offer(100, { checkedAt: ago(7 * MIN) }), NOW);
    expect(f).toEqual({
      fareFoundAt: null,
      fareAgeHours: null,
      fareAgeMinutes: null,
      scanAgeMinutes: 7,
      fareAgeBasis: "unknown",
      freshness: "unknown",
      ageLabelKey: "cached_fare_unknown_age",
      ageLabelHe: expect.stringContaining("לא ידוע"),
    });
    expect(f.ageLabelHe).toContain("לפני 7 דקות");
    expect(f.ageLabelHe).not.toMatch(/נמצא לפני|נבדק עכשיו/);
  });

  it("every live source counts as seen at checkedAt; Travelpayouts never does", () => {
    expect([...LIVE_FARE_SOURCES].sort()).toEqual(["google_flights", ...QUOTE_SOURCE_NAMES].sort());
    expect(LIVE_FARE_SOURCES).not.toContain("travelpayouts");
    for (const source of LIVE_FARE_SOURCES) {
      const f = fareFreshness(offer(100, { source, checkedAt: ago(90 * MIN) }), NOW);
      expect(f).toMatchObject({ fareFoundAt: ago(90 * MIN), fareAgeMinutes: 90, fareAgeHours: 1.5, scanAgeMinutes: 90, fareAgeBasis: "live", freshness: "fresh", ageLabelKey: "fare_found_ago", ageLabelHe: "המחיר נמצא לפני שעה" });
    }
  });

  it("a source-stated found_at wins over checkedAt and is classified by the fare's own age", () => {
    const f = fareFreshness(offer(100, { checkedAt: ago(10 * MIN), fareFoundAt: ago(3 * DAY + HOUR) }), NOW);
    expect(f).toMatchObject({ fareAgeBasis: "source", fareAgeMinutes: 73 * 60, fareAgeHours: 73, scanAgeMinutes: 10, freshness: "stale", ageLabelHe: "המחיר נמצא לפני 3 ימים" });
    expect(fareFreshness(offer(100, { fareFoundAt: ago(30 * HOUR) }), NOW).freshness).toBe("aging");
  });

  it("an expired fare is stale whatever else is known", () => {
    expect(fareFreshness(offer(100, { fareExpiresAt: ago(MIN) }), NOW)).toMatchObject({ freshness: "stale", ageLabelKey: "fare_expired", fareAgeBasis: "unknown" });
    expect(fareFreshness(offer(100, { source: "serpapi", fareExpiresAt: ago(MIN) }), NOW)).toMatchObject({ freshness: "stale", ageLabelKey: "fare_expired", fareAgeBasis: "live" });
  });

  it("a found time slightly ahead of now (clock skew) reads as zero, never negative", () => {
    expect(fareFreshness(offer(100, { fareFoundAt: later(MIN) }), NOW)).toMatchObject({ fareAgeMinutes: 0, fareAgeHours: 0, freshness: "fresh", ageLabelHe: "המחיר נמצא ממש עכשיו" });
  });

  it("a malformed checkedAt yields scanAgeMinutes 0 and an unknown live age rather than a crash", () => {
    const f = fareFreshness(offer(100, { source: "ignav", checkedAt: "bad" }), NOW);
    expect(f).toMatchObject({ scanAgeMinutes: 0, fareAgeBasis: "unknown", fareFoundAt: null, freshness: "unknown" });
  });
});

// --- the Travelpayouts client -------------------------------------------------------------------------------

describe("Travelpayouts client: found_at / expires_at", () => {
  const client = (rows: Record<string, unknown>[]) =>
    createTravelpayoutsClient({
      token: "t",
      fetchFn: (async () => new Response(JSON.stringify({ success: true, currency: "usd", data: rows }), { status: 200 })) as unknown as typeof fetch,
    });
  const base = () => structuredClone(roundtripFixture.data[0]) as Record<string, unknown>;

  it("v3 rows (no timestamps) come back without the new keys at all", async () => {
    const [o] = await client([base()]).roundTrips("TLV", "BCN", "2026-11-01", "2026-11-30");
    expect(o).toBeDefined();
    expect(Object.keys(o as object)).not.toContain("fareFoundAt");
    expect(Object.keys(o as object)).not.toContain("fareExpiresAt");
    const [f] = await client([base()]).oneWays("TLV", "BCN", "2026-11-01", "2026-11-30");
    expect(Object.keys(f as object)).not.toContain("foundAt");
    expect(Object.keys(f as object)).not.toContain("expiresAt");
  });

  it("parses valid timestamps and drops invalid ones", async () => {
    const good = { ...base(), found_at: "2020-01-01T10:00:00+02:00", expires_at: "2099-01-01T00:00:00Z" };
    const [o] = await client([good]).roundTrips("TLV", "BCN", "2026-11-01", "2026-11-30");
    expect(o).toMatchObject({ fareFoundAt: "2020-01-01T08:00:00.000Z", fareExpiresAt: "2099-01-01T00:00:00.000Z" });
    const [f] = await client([good]).oneWays("TLV", "BCN", "2026-11-01", "2026-11-30");
    expect(f).toMatchObject({ foundAt: "2020-01-01T08:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });

    const bad = { ...base(), found_at: "2099-01-01T00:00:00Z", expires_at: "tomorrow" }; // found in the future: not believed
    const [b] = await client([bad]).roundTrips("TLV", "BCN", "2026-11-01", "2026-11-30");
    expect(b?.fareFoundAt).toBeUndefined();
    expect(b?.fareExpiresAt).toBeUndefined();
  });
});

// --- splits and cache payloads -------------------------------------------------------------------------------

describe("buildSplits carries the legs' stated times", () => {
  const r = req({ windowStart: "2026-11-10", windowEnd: "2026-11-17", stayMin: 5, stayMax: 5 });
  it("older found time, earlier expiry", () => {
    const [s] = buildSplits("TLV", "BCN", r, [fare("2026-11-10", 50, { foundAt: ago(HOUR), expiresAt: later(DAY) })], [fare("2026-11-15", 60, { foundAt: ago(2 * HOUR) })], "travelpayouts", FX, 1, NOW.toISOString());
    expect(s).toMatchObject({ fareFoundAt: ago(2 * HOUR), fareExpiresAt: later(DAY) });
  });
  it("no stated times: no keys", () => {
    const [s] = buildSplits("TLV", "BCN", r, [fare("2026-11-10", 50, { foundAt: ago(HOUR) })], [fare("2026-11-15", 60)], "travelpayouts", FX, 1, NOW.toISOString());
    expect(s).toBeDefined();
    expect(Object.keys(s as object)).not.toContain("fareFoundAt");
    expect(Object.keys(s as object)).not.toContain("fareExpiresAt");
  });
});

describe("cache payloads keep the stated times", () => {
  it("sanitizeOffers keeps valid times and drops invalid ones", () => {
    const [a, b] = sanitizeOffers([offer(1, { fareFoundAt: ago(HOUR), fareExpiresAt: later(HOUR) }), { ...offer(2), fareFoundAt: "junk", fareExpiresAt: 5 }]);
    expect(a).toMatchObject({ fareFoundAt: ago(HOUR), fareExpiresAt: later(HOUR) });
    expect(Object.keys(b as object)).not.toContain("fareFoundAt");
    expect(Object.keys(b as object)).not.toContain("fareExpiresAt");
  });
  it("sanitizeOneWayPairs keeps valid times", () => {
    const [p] = sanitizeOneWayPairs([{ origin: "TLV", destination: "BCN", outs: [fare("2026-11-10", 5, { foundAt: ago(HOUR), expiresAt: "x" })], backs: [] }]);
    expect(p?.outs[0]?.foundAt).toBe(ago(HOUR));
    expect(p?.outs[0]?.expiresAt).toBeUndefined();
  });
});

// --- the pipeline ------------------------------------------------------------------------------------------

describe("runSearch: card freshness fields", () => {
  it("a Travelpayouts card says its fare age is unknown and keeps ageHours = our check's age", async () => {
    const res = await runSearch(deps(mockTp([offer(100)])), req());
    const c = res.cards[0];
    expect(c).toMatchObject({ ageHours: 0, scanAgeMinutes: 0, fareFoundAt: null, fareAgeHours: null, fareAgeMinutes: null, fareAgeBasis: "unknown", freshness: "unknown", ageLabelKey: "cached_fare_unknown_age" });
  });

  it("a stated found_at reaches the card, and survives a cache hit with the age advanced", async () => {
    const d = deps(mockTp([offer(100, { fareFoundAt: ago(2 * DAY) })]));
    const first = await runSearch(d, req());
    expect(first.cards[0]).toMatchObject({ fareAgeBasis: "source", fareAgeHours: 48, freshness: "aging", ageLabelHe: "המחיר נמצא לפני יומיים" });
    const second = await runSearch({ ...d, now: new Date(NOW.getTime() + 2 * HOUR) }, req());
    expect(second.meta.fromCache).toBe(true);
    expect(second.cards[0]).toMatchObject({ fareAgeHours: 50, scanAgeMinutes: 120, ageHours: 2 });
  });

  it("an expired fare is never Cheapest (nor any card); the next valid fare wins", async () => {
    const res = await runSearch(deps(mockTp([offer(50, { fareExpiresAt: ago(MIN) }), offer(100, { departDate: "2026-11-13", returnDate: "2026-11-19" })])), req());
    expect(res.cards.map((c) => c.offer.priceAmount)).not.toContain(50);
    expect(res.cards.find((c) => c.kinds.includes("cheapest"))?.offer.priceAmount).toBe(100);
  });

  it("a fare that expires between the scan and a cache hit drops out on the hit", async () => {
    const d = deps(mockTp([offer(50, { fareExpiresAt: later(HOUR) }), offer(100, { departDate: "2026-11-13", returnDate: "2026-11-19" })]));
    expect((await runSearch(d, req())).cards.find((c) => c.kinds.includes("cheapest"))?.offer.priceAmount).toBe(50);
    const hit = await runSearch({ ...d, now: new Date(NOW.getTime() + 2 * HOUR) }, req());
    expect(hit.meta.fromCache).toBe(true);
    expect(hit.cards.map((c) => c.offer.priceAmount)).not.toContain(50);
  });

  it("an expired cheap one-way leg does not hide a valid split behind it", async () => {
    const r = req({ windowStart: "2026-11-10", windowEnd: "2026-11-17", stayMin: 5, stayMax: 5 });
    const outs = [fare("2026-11-10", 10, { expiresAt: ago(MIN) }), fare("2026-11-10", 30)];
    const backs = [fare("2026-11-15", 30)];
    const res = await runSearch(deps(mockTp([offer(500, { departDate: "2026-11-10", returnDate: "2026-11-15" })], { outs, backs })), r);
    const cheapest = res.cards.find((c) => c.kinds.includes("cheapest"));
    expect(cheapest?.offer.ticketStructure).toBe("split");
    expect(cheapest?.offer.priceAmount).toBe(60);
  });
});
