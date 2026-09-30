/**
 * SerpApi (engine=google_flights) live fare source (src/sources/serpapi.ts).
 * FIXTURES: built from the vendor docs (https://serpapi.com/google-flights-api and /google-flights-results: the parameter
 * list, the field names of best_flights / other_flights, flights[] segments, layovers, price_insights), NOT from a live
 * call. The live service was never contacted, and nothing here leaves the machine: every request goes to a stub. The docs
 * leave open, and the fixtures therefore invent, the exact `time` format ("YYYY-MM-DD HH:MM" is assumed, a bare "HH:MM"
 * is tested too), the layovers[] and airports[] key names, and every value (routes, prices, carriers, tokens).
 * Owner rule under test: nothing may cost money. SerpApi's free allowance is 250 searches per MONTH, so the cap sits below
 * it, one unit is reserved BEFORE every request, a counter that cannot be read means no request, and nothing is retried.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { describeQuoteError, MAX_QUOTE_CALLS, QUOTE_TIMEOUT_MS, quotaSpecIsSafe, QuoteError, runQuotes, type QuoteQuery } from "../src/quotes";
import { createSerpApiSource, SERPAPI_QUOTA, serpApiAdapter } from "../src/sources/serpapi";
import type { Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const KEY = "serpapi-SECRET-key-0123456789abcdef";
const NOW = new Date("2026-09-29T12:00:00.000Z");
const PERIOD = "2026-09"; // the UTC month of NOW
const Q: QuoteQuery = { origin: "TLV", destination: "LHR", departDate: "2026-11-10", returnDate: "2026-11-17", party: { adults: 1 } };
/** The free allowance as the pricing page states it: "250 searches per month". */
const DOCUMENTED_ALLOWANCE = 250;

type Rec = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// --- fixtures (from the docs' Google Flights pages) -----------------------------------------------------------

const segment = (over: Rec = {}): Rec => ({
  departure_airport: { name: "Ben Gurion International Airport", id: "TLV", time: "2026-11-10 07:05" },
  arrival_airport: { name: "London Heathrow Airport", id: "LHR", time: "2026-11-10 10:55" },
  duration: 290,
  airplane: "Boeing 787",
  airline: "El Al",
  airline_logo: "https://www.gstatic.com/flights/airline_logos/70px/LY.png",
  travel_class: "Economy",
  flight_number: "LY 315",
  legroom: "31 in",
  extensions: ["Wi-Fi for a fee", "In-seat power & USB outlets"],
  ...over,
});

/** A nonstop, in best_flights. Round-trip answers list the OUTBOUND itinerary only: the return is behind departure_token. */
const DIRECT: Rec = {
  flights: [segment()],
  total_duration: 290,
  carbon_emissions: { this_flight: 190000, typical_for_this_route: 210000, difference_percent: -10 },
  price: 431,
  type: "Round trip",
  extensions: ["Bag and fare conditions depend on the return flight"],
  airline_logo: "https://www.gstatic.com/flights/airline_logos/70px/LY.png",
  booking_token: "WyJDalJJTVVOaGJHVjBSVUZCUVVGQlIxSkZSekJDUlVVdExTMHRMUzB0",
  departure_token: "WyJDalJJWVRGYVNVSkVSemsyWldOQlRVMVNVR2RDUnkwdExTMHRMUzB0",
};

/** One stop, in other_flights, cheaper: two segments and a layover. */
const ONE_STOP: Rec = {
  flights: [
    segment({
      departure_airport: { name: "Ben Gurion International Airport", id: "TLV", time: "2026-11-10 06:30" },
      arrival_airport: { name: "Athens International Airport", id: "ATH", time: "2026-11-10 08:25" },
      duration: 115,
      airline: "Aegean",
      flight_number: "A3 902",
    }),
    segment({
      departure_airport: { name: "Athens International Airport", id: "ATH", time: "2026-11-10 10:40" },
      arrival_airport: { name: "London Heathrow Airport", id: "LHR", time: "2026-11-10 12:55" },
      duration: 195,
      airline: "Aegean",
      flight_number: "A3 600",
    }),
  ],
  layovers: [{ duration: 135, name: "Athens International Airport", id: "ATH" }],
  total_duration: 445,
  price: 356,
  type: "Round trip",
  extensions: ["Bag and fare conditions depend on the return flight"],
  departure_token: "WyJDalJJY0ZZMU5EUXRUa1p0TkVWQlFuQmtVbEZDUnkwdExTMHRMUzB0",
};

const answer = (best: unknown[], over: Rec = {}): Rec => ({ best_flights: best, ...over });
const DOCS_ANSWER: Rec = {
  best_flights: [DIRECT],
  other_flights: [ONE_STOP],
  price_insights: { lowest_price: 356, price_level: "typical", typical_price_range: [300, 450], price_history: [[1790000000, 340], [1790086400, 356]] },
  airports: [{ departure: [{ airport: { name: "Ben Gurion International Airport", id: "TLV" } }], arrival: [{ airport: { name: "London Heathrow Airport", id: "LHR" } }] }],
};

/** The same answer for another outbound date (the fixture's date rewritten). */
const answerFor = (dep: string): Rec => JSON.parse(JSON.stringify(DOCS_ANSWER).replaceAll("2026-11-10", dep));

/** A copy of DIRECT with a change applied; `undefined` deletes the key. */
function fare(mutate: (f: Rec) => void): Rec {
  const f = clone(DIRECT);
  mutate(f);
  return f;
}
const firstSegment = (f: Rec): Rec => (f.flights as Rec[])[0] as Rec;

// --- harness ----------------------------------------------------------------------------------------------

function setup(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => json(DOCS_ANSWER), opts: { apiKey?: string | undefined } = { apiKey: KEY }) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init));
  const source = createSerpApiSource({ apiKey: opts.apiKey, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW, marker: "mk" });
  return { db, repo, fetchFn, source };
}

const used = async (db: D1Database, period = PERIOD): Promise<number> => (await db.prepare("SELECT used FROM source_quota WHERE source = 'serpapi' AND period = ?").bind(period).first<number>("used")) ?? 0;
const rowsOf = async (db: D1Database) => (await db.prepare("SELECT source, period, used FROM source_quota").all<Rec>()).results;
const seedUsed = (db: D1Database, n: number, period = PERIOD) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('serpapi', ?, ?, ?)").bind(period, n, NOW.toISOString()).run();

async function rejection(p: Promise<unknown>): Promise<QuoteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QuoteError);
    return e as QuoteError;
  }
  throw new Error("expected the promise to reject");
}

/** Everything a caller could see of an error must be free of the key. */
function expectNoKey(e: unknown) {
  const err = e as Error;
  for (const s of [err.message, String(err), err.stack ?? "", JSON.stringify(err, Object.getOwnPropertyNames(err))]) expect(s).not.toContain(KEY);
}

// ---------------------------------------------------------------------------------------------------------

describe("serpapi quota (the owner rule)", () => {
  it("the cap is below the documented free allowance: monthly, whole, and within the margin the core demands", () => {
    expect(SERPAPI_QUOTA.period).toBe("monthly"); // "250 searches per month"
    expect(SERPAPI_QUOTA.allowance).toBe(DOCUMENTED_ALLOWANCE);
    expect(Number.isInteger(SERPAPI_QUOTA.cap)).toBe(true);
    expect(SERPAPI_QUOTA.cap).toBeGreaterThanOrEqual(1);
    expect(SERPAPI_QUOTA.cap).toBeLessThanOrEqual(DOCUMENTED_ALLOWANCE);
    expect(SERPAPI_QUOTA.cap).toBe(240);
    expect(quotaSpecIsSafe(SERPAPI_QUOTA)).toBe(true); // and the core's own (stricter) monthly margin: the source is not inert
  });

  it("the cap cannot be raised at runtime, and the source and the adapter carry exactly it", () => {
    expect(Object.isFrozen(SERPAPI_QUOTA)).toBe(true);
    expect(() => {
      (SERPAPI_QUOTA as { cap: number }).cap = 5000;
    }).toThrow(TypeError);
    expect(serpApiAdapter.quota).toBe(SERPAPI_QUOTA);
    expect(setup().source.quota).toEqual({ period: "monthly", cap: 240, allowance: 250 });
    expect(serpApiAdapter.name).toBe("serpapi");
  });

  it("reserves the unit BEFORE the request goes out, in the row of the UTC month", async () => {
    const { db, repo } = setup();
    const order: string[] = [];
    let usedAtRequest = -1;
    const spyRepo: Repo = { ...repo, reserveQuota: async (...a) => (order.push("reserve"), repo.reserveQuota(...a)) };
    const fetchFn = vi.fn(async () => {
      order.push("fetch");
      usedAtRequest = await used(db);
      return json(DOCS_ANSWER);
    });
    const s = createSerpApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: spyRepo, now: NOW });
    await s.quote(Q);
    expect(order).toEqual(["reserve", "fetch"]);
    expect(usedAtRequest).toBe(1); // already counted while the request was in flight
    expect(await rowsOf(db)).toEqual([{ source: "serpapi", period: PERIOD, used: 1 }]);
    expect(s.callCount()).toBe(1);
  });

  it("refuses the request once the month's counter is at the cap, and lets exactly the last unit through", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, SERPAPI_QUOTA.cap - 1);
    await expect(source.quote(Q)).resolves.toHaveLength(2); // the 100th request of the month
    expect(await used(db)).toBe(SERPAPI_QUOTA.cap);
    const err = await rejection(source.quote(Q));
    expect(err.code).toBe("quota_exhausted");
    expect(describeQuoteError(source, err)).toBe("SerpApi: free quota used up (monthly)");
    expect(fetchFn).toHaveBeenCalledTimes(1); // the 101st never left
    expect(await used(db)).toBe(SERPAPI_QUOTA.cap); // and did not raise the counter past the cap
  });

  it("counts per UTC month: a new month starts a new row, the last second of the old one still uses the old row", async () => {
    const { db, repo, fetchFn } = setup();
    await seedUsed(db, SERPAPI_QUOTA.cap);
    const at = (iso: string) => createSerpApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo, now: new Date(iso) });
    expect((await rejection(at("2026-09-30T23:59:59.000Z").quote(Q))).code).toBe("quota_exhausted");
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(at("2026-10-01T00:00:00.000Z").quote(Q)).resolves.toHaveLength(2);
    expect(await used(db, "2026-10")).toBe(1);
    expect(await used(db, PERIOD)).toBe(SERPAPI_QUOTA.cap); // the old month is untouched
  });

  it("fails closed: an unreadable or unwritable counter means no request", async () => {
    // missing table
    const a = setup();
    await a.db.exec("DROP TABLE source_quota");
    expect((await rejection(a.source.quote(Q))).code).toBe("quota_exhausted");
    expect(a.fetchFn).not.toHaveBeenCalled();
    // the repository throws, or answers "no"
    for (const reserve of [async () => { throw new Error("D1 down"); }, async () => false]) {
      const { repo, fetchFn } = setup();
      const source = createSerpApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: { ...repo, reserveQuota: reserve }, now: NOW });
      expect((await rejection(source.quote(Q))).code).toBe("quota_exhausted");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(source.callCount()).toBe(0);
    }
  });

  it("a failed request still used its unit, and nothing is ever retried", async () => {
    for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) {
      const { db, fetchFn, source } = setup(() => json({ error: "nope" }, status));
      const err = await rejection(source.quote(Q));
      expect(err, String(status)).toMatchObject({ code: "http", status });
      expect(fetchFn, String(status)).toHaveBeenCalledTimes(1);
      expect(await used(db), String(status)).toBe(1);
    }
    // an empty answer is a successful (counted) search too: it is counted, and not repeated
    const empty = setup(() => json(answer([])));
    await expect(empty.source.quote(Q)).resolves.toEqual([]);
    expect(empty.fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(empty.db)).toBe(1);
  });
});

describe("serpapi configuration", () => {
  it("without a key the source is not configured: never called, never counted", async () => {
    for (const apiKey of [undefined, "", "   ", "\n"]) {
      const { db, fetchFn, source } = setup(undefined, { apiKey });
      expect(source.configured, JSON.stringify(apiKey)).toBe(false);
      expect((await rejection(source.quote(Q))).code).toBe("not_configured");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await rowsOf(db)).toEqual([]);
    }
    expect(setup().source.configured).toBe(true);
  });

  it("a stray newline in a pasted secret is trimmed before it becomes part of the URL", async () => {
    const { fetchFn, source } = setup(undefined, { apiKey: `${KEY}\n` });
    await source.quote(Q);
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.get("api_key")).toBe(KEY);
  });
});

describe("serpapi request", () => {
  it("is one GET to the search endpoint with exactly the documented parameters: ONE adult, economy, round trip, USD", async () => {
    const { fetchFn, source } = setup();
    await source.quote({ ...Q, party: { adults: 3, children: 2 } }); // the party only shapes the booking link
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(`${u.origin}${u.pathname}`).toBe("https://serpapi.com/search");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      engine: "google_flights",
      departure_id: "TLV",
      arrival_id: "LHR",
      outbound_date: "2026-11-10",
      return_date: "2026-11-17",
      type: "1",
      currency: "USD",
      hl: "en",
      adults: "1",
      travel_class: "1",
      sort_by: "2",
      api_key: KEY, // the only authentication the docs describe: a query-string parameter
    });
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect(JSON.stringify(init?.headers)).not.toContain(KEY); // no second copy of the key
    expect(init?.redirect).toBe("manual"); // a followed redirect would be a second request with the key attached
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never asks for what costs a further search or a slower one: no departure_token, booking_token, deep_search, no_cache, async", async () => {
    const { fetchFn, source } = setup();
    await source.quote(Q);
    const names = [...new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.keys()];
    for (const banned of ["departure_token", "booking_token", "selected_flights_json", "multi_city_json", "deep_search", "no_cache", "async", "output", "json_restrictor"]) {
      expect(names, banned).not.toContain(banned);
    }
  });

  it("makes exactly one request per quote: no follow-up, no matter what tokens the answer holds", async () => {
    const { fetchFn, source } = setup();
    await source.quote(Q); // every fare of the answer carries a departure_token, one also a booking_token
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("carries a timeout (AbortSignal.timeout) and reports a request that never answers as one, without a retry", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(25));
    try {
      const { db, fetchFn, source } = setup((_url, init) => new Promise<Response>((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal?.reason))));
      const err = await rejection(source.quote(Q));
      expect(err.code).toBe("timeout");
      expect(describeQuoteError(source, err)).toBe("SerpApi: timeout");
      expect(spy).toHaveBeenCalledWith(QUOTE_TIMEOUT_MS);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await used(db)).toBe(1);
      expectNoKey(err);
    } finally {
      spy.mockRestore();
    }
  });

  it("a query that cannot be sent fails before a unit is spent, and without the key in the message", async () => {
    const bad: QuoteQuery[] = [
      { ...Q, origin: "tlv" },
      { ...Q, destination: "LONDON" },
      { ...Q, destination: "TLV" },
      { ...Q, departDate: "2026-13-01" },
      { ...Q, departDate: "10/11/2026" },
      { ...Q, returnDate: "2026-11-09" }, // before the departure
    ];
    for (const q of bad) {
      const { db, fetchFn, source } = setup();
      const err = await source.quote(q).catch((e: unknown) => e);
      expect(err, JSON.stringify(q)).toBeInstanceOf(RangeError);
      expectNoKey(err);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await rowsOf(db)).toEqual([]);
      expect(source.callCount()).toBe(0);
    }
    // same-day trips are allowed ("on or after")
    await expect(setup().source.quote({ ...Q, returnDate: Q.departDate })).resolves.toBeDefined();
  });
});

describe("serpapi mapping", () => {
  it("maps a normal answer (best_flights + other_flights) to round-trip offers, cheapest first, per adult in USD", async () => {
    const { source } = setup();
    const offers = await source.quote(Q);
    expect(offers.map((o) => o.priceAmount)).toEqual([356, 431]);
    expect(offers[1]).toMatchObject({
      origin: "TLV",
      destination: "LHR",
      departDate: "2026-11-10",
      returnDate: "2026-11-17",
      priceAmount: 431,
      priceCurrency: "USD",
      source: "serpapi",
      ticketStructure: "roundtrip",
      outbound: { departTime: "07:05", arriveTime: "10:55", stops: 0, durationMin: 290, airlines: ["LY"] },
      includes: {}, // the docs give no baggage data: unknown, not "no bag"
      verifyLink: null,
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
      checkedAt: NOW.toISOString(),
    });
    expect(offers[0]).toMatchObject({
      priceAmount: 356,
      outbound: { departTime: "06:30", arriveTime: "12:55", stops: 1, durationMin: 445, airlines: ["A3"] }, // two Aegean flights, one code
    });
  });

  it("reads either list alone: best_flights without other_flights, and other_flights without best_flights", async () => {
    const onlyBest = setup(() => json({ best_flights: [DIRECT] }));
    expect((await onlyBest.source.quote(Q)).map((o) => o.priceAmount)).toEqual([431]);
    const onlyOther = setup(() => json({ other_flights: [ONE_STOP, DIRECT] })); // results that are not split into best and other
    expect((await onlyOther.source.quote(Q)).map((o) => o.priceAmount)).toEqual([356, 431]);
  });

  it("the return itinerary is not in a round-trip answer: it stays unknown (null), never guessed", async () => {
    const offers = await setup().source.quote(Q);
    for (const o of offers) expect(o.inbound).toEqual({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] });
  });

  it("the booking link is the core's Aviasales search for the same dates (the docs give none), and it carries no key", async () => {
    const offers = await setup().source.quote(Q);
    for (const o of offers) {
      expect(o.deeplink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/TLV1011LHR1711/);
      expect(String(o.deeplink)).not.toContain(KEY);
      expect(String(o.deeplink)).not.toContain("serpapi");
    }
  });

  it("the adapter reads only what the docs give: no booking link, no bag flag, no field it cannot source, and it never edits the answer", () => {
    const body = clone(DOCS_ANSWER);
    const fares = serpApiAdapter.parse(body, Q);
    expect(fares).toHaveLength(2);
    for (const f of fares) expect(Object.keys(f).sort()).toEqual(["currency", "inbound", "outbound", "price"]);
    expect(body).toEqual(DOCS_ANSWER);
  });

  it("empty answers are valid: no offers, no error", async () => {
    const empties: unknown[] = [
      { best_flights: [], other_flights: [] },
      { other_flights: [] },
      answer([], { search_metadata: { status: "Success" }, price_insights: {} }),
      { error: "Google Flights hasn't returned any results for this query." }, // a 200 that says so
    ];
    for (const body of empties) {
      const { db, fetchFn, source } = setup(() => json(body));
      await expect(source.quote(Q), JSON.stringify(body)).resolves.toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await used(db)).toBe(1); // a search with no results still counts at the vendor, and here
    }
  });

  it("a shape it cannot read gives an empty array, not an error", async () => {
    const shapes: unknown[] = [
      null,
      [],
      "text",
      42,
      {},
      { best_flights: null },
      { best_flights: {} },
      { other_flights: "x" },
      { price_insights: { lowest_price: 356 }, airports: [] }, // documented keys, but no flight list at all
      { error: { code: "invalid_request" } },
      { search_metadata: { status: "Error" }, best_flights: [DIRECT] },
      { search_metadata: { status: "Processing" }, best_flights: [DIRECT] },
      answer([1, null, "x", [], {}, { price: 5 }, { price: {} }, { price: 5, flights: [] }], { other_flights: [true, "y"] }),
    ];
    for (const shape of shapes) {
      const { source } = setup(() => json(shape));
      await expect(source.quote(Q), JSON.stringify(shape)).resolves.toEqual([]);
    }
  });

  it("an answer that is not JSON is a response error, never a crash", async () => {
    const { source } = setup(() => new Response("<html>gateway</html>", { status: 200 }));
    expect((await rejection(source.quote(Q))).code).toBe("response");
  });

  it("drops what it cannot vouch for, and keeps the good fares next to it", () => {
    const dropped: Array<[string, Rec]> = [
      ["zero price", fare((f) => (f.price = 0))],
      ["negative price", fare((f) => (f.price = -5))],
      ["price as text", fare((f) => (f.price = "431"))],
      ["null price", fare((f) => (f.price = null))],
      ["no price", fare((f) => delete f.price)],
      ["one way", fare((f) => (f.type = "One way"))],
      ["multi-city", fare((f) => (f.type = "Multi-city"))],
      ["type 2", fare((f) => (f.type = 2))],
      ["no flights", fare((f) => delete f.flights)],
      ["empty flights", fare((f) => (f.flights = []))],
      ["unreadable segment", fare((f) => (f.flights = [1]))],
      ["premium economy", fare((f) => (firstSegment(f).travel_class = "Premium economy"))],
      ["business", fare((f) => (firstSegment(f).travel_class = "Business"))],
      ["first", fare((f) => (firstSegment(f).travel_class = "First"))],
      ["departs another day", fare((f) => ((firstSegment(f).departure_airport as Rec).time = "2026-11-11 07:05"))],
      ["departs another airport", fare((f) => ((firstSegment(f).departure_airport as Rec).id = "ETH"))],
      ["arrives at another airport", fare((f) => ((firstSegment(f).arrival_airport as Rec).id = "LGW"))],
    ];
    for (const [label, bad] of dropped) {
      expect(serpApiAdapter.parse(answer([bad]), Q), label).toEqual([]);
      expect(serpApiAdapter.parse(answer([bad], { other_flights: [ONE_STOP] }), Q).map((f) => f.price), label).toEqual([356]);
    }
  });

  it("a price in a currency other than the one asked for is no fare (when the answer states one)", () => {
    expect(serpApiAdapter.parse(answer([DIRECT], { search_parameters: { currency: "ILS" } }), Q)).toEqual([]);
    expect(serpApiAdapter.parse(answer([DIRECT], { search_parameters: { currency: "usd" } }), Q)).toHaveLength(1);
    expect(serpApiAdapter.parse(answer([DIRECT], { search_parameters: { engine: "google_flights" } }), Q)).toHaveLength(1); // not stated: taken as asked
    expect(serpApiAdapter.parse(answer([DIRECT], { search_metadata: { status: "Success" } }), Q)).toHaveLength(1);
  });

  it("reads what is tolerable: a lower-case airport echo, no type, no cabin, no layovers, no total duration, a bare HH:MM", () => {
    const [f] = serpApiAdapter.parse(
      answer([fare((x) => {
        delete x.type;
        delete x.total_duration;
        delete x.layovers;
        delete firstSegment(x).travel_class;
        (firstSegment(x).departure_airport as Rec).id = " tlv ";
        (firstSegment(x).departure_airport as Rec).time = "07:05";
      })]),
      Q,
    );
    expect(f).toMatchObject({ price: 431, currency: "USD", outbound: { departTime: "07:05", arriveTime: "10:55", durationMin: null, stops: 0, airlines: ["LY"] } });
    // the type as the request echoes it, in the spellings that mean a round trip
    for (const type of ["Round trip", "round trip", "Round_trip", "1", 1, null]) {
      expect(serpApiAdapter.parse(answer([fare((x) => (x.type = type))]), Q), String(type)).toHaveLength(1);
    }
  });

  it("reads the time of an airport as HH:MM whatever its date part, and leaves what it cannot read null", () => {
    const times = (values: unknown[]) =>
      values.map((v) => serpApiAdapter.parse(answer([fare((x) => ((firstSegment(x).arrival_airport as Rec).time = v))]), Q)[0]?.outbound.arriveTime);
    expect(times(["2026-11-10 10:55", "2026-11-10T10:55:00", "10:55", " 10:55 ", "2026-11-10 7:05", "soon", "25:00", "10:75", 1055, null, {}])).toEqual([
      "10:55",
      "10:55",
      "10:55",
      "10:55",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("leaves every unknown value null (or empty), never guessed", async () => {
    const sparse = fare((f) => {
      f.flights = [{}, { flight_number: "??", departure_airport: { time: "soon" }, arrival_airport: { time: 12 } }];
      f.total_duration = "290";
    });
    const { source } = setup(() => json(answer([sparse])));
    const [o] = await source.quote(Q);
    expect(o?.outbound).toEqual({ departTime: null, arriveTime: null, stops: 1, durationMin: null, airlines: [] });
    expect(o?.inbound).toEqual({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] });
    expect(o?.includes).toEqual({});
    expect(o?.verifyLink).toBeNull();
  });

  it("takes the IATA carrier from the flight number (the airline field is only a name), and ignores what it cannot read", () => {
    const codes = (numbers: unknown[]) => {
      const f = fare((x) => (x.flights = numbers.map((n) => segment({ flight_number: n }))));
      return serpApiAdapter.parse(answer([f]), Q)[0]?.outbound.airlines;
    };
    expect(codes(["LY 315"])).toEqual(["LY"]);
    expect(codes(["9W 1234", "U2 5", "UA 901"])).toEqual(["9W", "U2", "UA"]);
    expect(codes(["A3 902", "A3 600"])).toEqual(["A3"]);
    expect(codes(["El Al", "", 315, null, "LYX 315", "L 315"])).toEqual([]); // a name is never turned into a code
  });

  it("collapses the same flight twice and keeps only the cheapest MAX offers (core rules apply to serpapi offers too)", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      fare((f) => {
        f.price = 500 + i;
        (firstSegment(f).departure_airport as Rec).time = `2026-11-10 0${i % 10}:${10 + i}`;
      }),
    );
    const { source } = setup(() => json({ best_flights: many.slice(0, 15), other_flights: [...many.slice(15), many[0]] }));
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(20);
    expect(offers[0]?.priceAmount).toBe(500);
    expect(new Set(offers.map((o) => `${o.outbound.departTime}|${o.priceAmount}`)).size).toBe(20);
  });
});

describe("serpapi failures", () => {
  it("HTTP 401, 429 and 500 are reported as errors with fixed texts, and the key never appears in them", async () => {
    const expected: Array<[number, string]> = [
      [401, "SerpApi: HTTP 401"],
      [429, "SerpApi: HTTP 429"],
      [500, "SerpApi: HTTP 500"],
    ];
    for (const [status, text] of expected) {
      // the vendor echoes the key in its error body: it must not get anywhere
      const { source } = setup(() => json({ error: `Invalid API key ${KEY}. Your API key should be here: https://serpapi.com/manage-api-key` }, status));
      const err = await rejection(source.quote(Q));
      expect(err).toMatchObject({ name: "QuoteError", code: "http", status });
      expect(describeQuoteError(source, err)).toBe(text);
      expectNoKey(err);
      expect(describeQuoteError(source, err)).not.toContain(KEY);
    }
  });

  it("the documented 'out of searches' 429 is an HTTP error, not a fare and not a retry", async () => {
    const { db, fetchFn, source } = setup(() => json({ error: "Your account has run out of searches." }, 429));
    const err = await rejection(source.quote(Q));
    expect(err).toMatchObject({ code: "http", status: 429 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(db)).toBe(1);
  });

  it("a timeout, a dropped connection and a fetch error that quotes the URL are reported as such, and the key stays out of them", async () => {
    const cases: Array<[(url: string) => never, string]> = [
      [() => { throw new DOMException(`The operation timed out (${KEY})`, "TimeoutError"); }, "timeout"],
      [() => { throw new TypeError(`fetch failed for header Authorization: Bearer ${KEY}`); }, "network"],
      [(url) => { throw new TypeError(`Failed to fetch ${url}`); }, "network"], // the URL of this adapter holds the key
    ];
    for (const [fail, code] of cases) {
      const { db, fetchFn, source } = setup(fail);
      const err = await rejection(source.quote(Q));
      expect(err.code).toBe(code);
      expect(err.status).toBeNull();
      expectNoKey(err);
      expect(describeQuoteError(source, err)).not.toContain(KEY);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await used(db)).toBe(1);
    }
  });

  it("a redirect is not followed (a followed one would be a second request with the key attached)", async () => {
    const { fetchFn, source } = setup(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }));
    expect(await rejection(source.quote(Q))).toMatchObject({ code: "http", status: 302 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a 200 answer that carries an error message instead of fares is no fare and no crash, and does not echo the key", async () => {
    const { source } = setup(() => json({ error: `bad key ${KEY}` }));
    await expect(source.quote(Q)).resolves.toEqual([]);
  });

  it("the adapter's source code logs nothing and cannot reach fetch or the counter itself", () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sources", "serpapi.ts"), "utf8");
    expect(text).not.toMatch(/\bconsole\./);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/reserveQuota|setTimeout|while\s*\(|for\s*\(\s*let\s+\w+\s*=\s*0/); // no counter access, no retry loop, no wait
    expect(text).not.toMatch(/from\s+["']node:/);
  });
});

describe("serpapi in the quote phase", () => {
  it("asks once per date pair, never more than the per-search limit, and counts every request", async () => {
    const { db, fetchFn, repo } = setup((url) => json(answerFor(String(new URL(url).searchParams.get("outbound_date")))));
    const source = createSerpApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW });
    const dates: Array<[string, string]> = [["2026-11-10", "2026-11-17"], ["2026-11-11", "2026-11-18"], ["2026-11-12", "2026-11-19"], ["2026-11-13", "2026-11-20"], ["2026-11-14", "2026-11-21"]];
    const { offers, stats } = await runQuotes([source], { origin: "TLV", dest: "LHR" }, dates, { adults: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(4); // MAX_QUOTE_PAIRS: the cheapest four
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    const asked = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("outbound_date")).sort();
    expect(asked).toEqual(["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(stats.get("serpapi")).toMatchObject({ calls: 4, succeeded: 4, offers: 8, failures: [], notes: [] });
    expect(offers).toHaveLength(8);
    expect(offers.every((o) => o.source === "serpapi" && o.ticketStructure === "roundtrip")).toBe(true);
    expect(new Set(offers.map((o) => `${o.departDate}|${o.returnDate}`)).size).toBe(4); // exactly the pairs asked
    expect(await used(db)).toBe(4);
  });

  it("a source at its cap is skipped with a note, and nothing is requested", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, SERPAPI_QUOTA.cap);
    const { offers, stats } = await runQuotes([source], { origin: "TLV", dest: "LHR" }, [["2026-11-10", "2026-11-17"], ["2026-11-11", "2026-11-18"]], { adults: 1 });
    expect(offers).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stats.get("serpapi")).toMatchObject({ calls: 0, succeeded: 0, offers: 0, failures: [], notes: ["SerpApi: free quota used up (monthly)"] });
    expect(await used(db)).toBe(SERPAPI_QUOTA.cap);
  });

  it("a vendor 429 is a failure of that source only: HTTP 429 in its status text, no key in it", async () => {
    const { source } = setup(() => json({ error: `Your account has run out of searches. (${KEY})` }, 429));
    const { offers, stats } = await runQuotes([source], { origin: "TLV", dest: "LHR" }, [["2026-11-10", "2026-11-17"]], { adults: 1 });
    expect(offers).toEqual([]);
    expect(stats.get("serpapi")).toMatchObject({ calls: 1, succeeded: 0, offers: 0, failures: ["SerpApi: HTTP 429"] });
    expect(JSON.stringify([...stats])).not.toContain(KEY);
  });

  it("never spends more than the cap in a month: the 101st request is refused, one by one and all at once", async () => {
    const seq = setup();
    let refused = 0;
    for (let i = 0; i < SERPAPI_QUOTA.cap + 5; i++) {
      await seq.source.quote(Q).catch((e: unknown) => {
        if (e instanceof QuoteError && e.code === "quota_exhausted") refused += 1;
      });
    }
    expect(seq.fetchFn).toHaveBeenCalledTimes(SERPAPI_QUOTA.cap);
    expect(refused).toBe(5);
    expect(await used(seq.db)).toBe(SERPAPI_QUOTA.cap);

    const par = setup();
    const results = await Promise.allSettled(Array.from({ length: SERPAPI_QUOTA.cap + 10 }, () => par.source.quote(Q)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(SERPAPI_QUOTA.cap);
    expect(par.fetchFn).toHaveBeenCalledTimes(SERPAPI_QUOTA.cap);
    expect(await used(par.db)).toBe(SERPAPI_QUOTA.cap);
    expect(SERPAPI_QUOTA.cap).toBeLessThanOrEqual(DOCUMENTED_ALLOWANCE);
  });
});
