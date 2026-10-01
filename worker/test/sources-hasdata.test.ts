/**
 * HasData live fare source (src/sources/hasdata.ts).
 * FIXTURES: built from the vendor docs (https://docs.hasdata.com/apis/google-travel/flights.md for the request, the vendor's
 * scraping guide https://hasdata.com/blog/how-to-scrape-google-flights for the answer's field names), NOT from a live call:
 * the live service was never contacted, and nothing here leaves the machine (every request goes to a stub). The values are
 * invented in the documented shape.
 * Owner rule under test: nothing may cost money. HasData's free plan is 1,000 credits a month and a flights search costs 15,
 * so 66 requests; the cap (55) sits below that, one unit is reserved BEFORE every request, a counter that cannot be read
 * means no request, and nothing is retried.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { quotaSpecIsSafe, QuoteError, type QuoteQuery } from "../src/quotes";
import { createHasDataSource, HASDATA_QUOTA, hasDataAdapter } from "../src/sources/hasdata";
import { createTestD1 } from "./helpers/d1";

const KEY = "hasdata-SECRET-key-0123456789abcdef";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const Q: QuoteQuery = { origin: "TLV", destination: "ATH", departDate: "2026-11-10", returnDate: "2026-11-17", party: { adults: 1 } };
/** 1,000 free credits a month at 15 credits per Google Flights request. */
const DOCUMENTED_ALLOWANCE = Math.floor(1000 / 15);

type Rec = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const seg = (over: Rec = {}): Rec => ({
  departureAirport: { id: "TLV", name: "Ben Gurion", time: "2026-11-10 07:30" },
  arrivalAirport: { id: "ATH", name: "Athens", time: "2026-11-10 10:00" },
  duration: 150,
  airplane: "Airbus A320",
  airline: "Aegean",
  flightNumber: "A3 902",
  travelClass: "Economy",
  ...over,
});
const DIRECT: Rec = { price: 212, type: "Round trip", totalDuration: 150, flights: [seg()], departureToken: "tok1" };
const ONE_STOP: Rec = {
  price: 180,
  type: "Round trip",
  totalDuration: 400,
  flights: [
    seg({ arrivalAirport: { id: "LCA", name: "Larnaca", time: "2026-11-10 09:00" }, airline: "Cyprus Airways", flightNumber: "CY 336" }),
    seg({ departureAirport: { id: "LCA", name: "Larnaca", time: "2026-11-10 12:00" }, airline: "Cyprus Airways", flightNumber: "CY 311" }),
  ],
};
const ANSWER: Rec = { requestMetadata: { status: "ok" }, bestFlights: [DIRECT], otherFlights: [ONE_STOP], priceInsights: { lowestPrice: 180 } };

function setup(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => json(ANSWER), apiKey: string | null = KEY) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init));
  const source = createHasDataSource({ apiKey: apiKey ?? undefined, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW, marker: "mk" });
  return { db, fetchFn, source };
}
const used = async (db: D1Database): Promise<number> => (await db.prepare("SELECT used FROM source_quota WHERE source = 'hasdata' AND period = '2026-10'").first<number>("used")) ?? 0;
const seedUsed = (db: D1Database, n: number) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('hasdata', '2026-10', ?, ?)").bind(n, NOW.toISOString()).run();
async function rejection(p: Promise<unknown>): Promise<QuoteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QuoteError);
    return e as QuoteError;
  }
  throw new Error("expected the promise to reject");
}

describe("quota", () => {
  it("the cap is below the documented monthly allowance and the core accepts the spec", () => {
    expect(HASDATA_QUOTA.period).toBe("monthly");
    expect(HASDATA_QUOTA.allowance).toBe(DOCUMENTED_ALLOWANCE);
    expect(HASDATA_QUOTA.cap).toBeLessThan(DOCUMENTED_ALLOWANCE);
    expect(quotaSpecIsSafe(HASDATA_QUOTA)).toBe(true);
    expect(hasDataAdapter.quota).toBe(HASDATA_QUOTA);
  });

  it("reserves the unit BEFORE the request goes out", async () => {
    const { db, fetchFn, source } = setup(async () => {
      expect(await used(db)).toBe(1);
      return json(ANSWER);
    });
    await source.quote(Q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(db)).toBe(1);
  });

  it("refuses the request once the counter is at the cap, and lets exactly the last unit through", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, HASDATA_QUOTA.cap - 1);
    await expect(source.quote(Q)).resolves.toHaveLength(2);
    expect((await rejection(source.quote(Q))).code).toBe("quota_exhausted");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(db)).toBe(HASDATA_QUOTA.cap);
  });

  it("without a key the source is not configured: never called, never counted", async () => {
    for (const k of [null, "", "   "]) {
      const { db, fetchFn, source } = setup(undefined, k);
      expect(source.configured).toBe(false);
      expect((await rejection(source.quote(Q))).code).toBe("not_configured");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await used(db)).toBe(0);
    }
  });

  it("a failed request still used its unit and is never retried", async () => {
    const { db, fetchFn, source } = setup(() => json({ error: "boom" }, 500));
    expect((await rejection(source.quote(Q))).code).toBe("http");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(db)).toBe(1);
  });
});

describe("request", () => {
  it("is one GET: the key in the x-api-key header only, ONE adult, economy, round trip in USD", async () => {
    const { fetchFn, source } = setup();
    await source.quote({ ...Q, party: { adults: 3, children: 2 } });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.hasdata.com/scrape/google/flights");
    expect(init.method).toBe("GET");
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({ departureId: "TLV", arrivalId: "ATH", outboundDate: "2026-11-10", returnDate: "2026-11-17", type: "roundTrip", adults: "1", travelClass: "Economy", currency: "USD" });
    expect(p).not.toHaveProperty("departureToken");
    expect(p).not.toHaveProperty("bookingToken");
  });

  it("a query that cannot be sent fails before a unit is spent", async () => {
    for (const q of [{ ...Q, origin: "tlv" }, { ...Q, destination: "TLV" }, { ...Q, departDate: "2026-02-30" }, { ...Q, returnDate: "2026-11-01" }]) {
      const { db, fetchFn, source } = setup();
      await expect(source.quote(q)).rejects.toBeDefined();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await used(db)).toBe(0);
    }
  });
});

describe("answer", () => {
  it("maps bestFlights and otherFlights to round-trip offers, per adult in USD, with the return unknown", async () => {
    const offers = await setup().source.quote(Q);
    expect(offers.map((o) => o.priceAmount).sort((a, b) => a - b)).toEqual([180, 212]);
    for (const o of offers) {
      expect(o).toMatchObject({ source: "hasdata", priceCurrency: "USD", ticketStructure: "roundtrip", departDate: "2026-11-10", returnDate: "2026-11-17" });
      expect(o.inbound).toEqual({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] });
      expect(o.verifyLink).toBeNull();
    }
    const direct = offers.find((o) => o.priceAmount === 212)!;
    expect(direct.outbound).toMatchObject({ departTime: "07:30", arriveTime: "10:00", stops: 0, durationMin: 150, airlines: ["A3"] });
    const oneStop = offers.find((o) => o.priceAmount === 180)!;
    expect(oneStop.outbound).toMatchObject({ stops: 1, airlines: ["CY"] });
  });

  it("drops what it cannot vouch for and keeps the good fare next to it", () => {
    const bad = (f: (x: Rec) => void) => {
      const x = clone(DIRECT);
      f(x);
      return x;
    };
    const list = [
      bad((x) => (x.price = 0)),
      bad((x) => (x.price = "212")),
      bad((x) => (x.type = "One way")),
      bad((x) => ((x.flights as Rec[])[0]!.travelClass = "Business")),
      bad((x) => ((x.flights as Rec[])[0]!.departureAirport = { id: "SKG", time: "2026-11-10 07:30" })),
      bad((x) => ((x.flights as Rec[])[0]!.departureAirport = { id: "TLV", time: "2026-11-11 07:30" })),
      bad((x) => (x.flights = [])),
      "junk",
      null,
      DIRECT,
    ];
    const fares = hasDataAdapter.parse({ bestFlights: list }, Q) as unknown[];
    expect(fares).toHaveLength(1);
  });

  it("leaves unknown values null, never guessed (unreadable time, no duration, no flight number)", () => {
    const f = clone(DIRECT);
    delete f.totalDuration;
    const s = (f.flights as Rec[])[0]!;
    s.departureAirport = { id: "TLV", time: "soon" };
    delete s.flightNumber;
    const [fare] = hasDataAdapter.parse({ bestFlights: [f] }, Q);
    expect(fare!.outbound).toMatchObject({ departTime: null, durationMin: null, airlines: [] });
  });

  it("an empty or unreadable answer is no fares and no crash; a non-JSON body is a response error", async () => {
    for (const body of [{}, { bestFlights: [] }, { bestFlights: "x" }, [], "text", null]) {
      await expect(setup(() => json(body)).source.quote(Q), JSON.stringify(body)).resolves.toEqual([]);
    }
    expect((await rejection(setup(() => new Response("<html>", { status: 200 })).source.quote(Q))).code).toBe("response");
  });

  it("errors never carry the key", async () => {
    for (const status of [401, 403, 429, 500]) {
      const err = await rejection(setup(() => json({ error: `bad key ${KEY}` }, status)).source.quote(Q));
      expect(JSON.stringify(err)).not.toContain(KEY);
      expect(err.message).not.toContain(KEY);
    }
  });
});
