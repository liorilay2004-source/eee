/**
 * SearchApi.io live fare source (src/sources/searchapi.ts).
 * FIXTURES: built from the vendor docs (https://www.searchapi.io/docs/google-flights-api: the request example and the
 * round-trip response example, whose dates were moved to the request example's dates), NOT from a live call. The live
 * service was never contacted, and nothing here leaves the machine: every request goes to a stub. Values the docs do not
 * show (the second fare, its price, the carriers of the one-stop itinerary) are invented in the documented shape.
 * Owner rule under test: nothing may cost money. SearchApi.io's free allowance is 100 requests once, so the cap sits below
 * it, one unit is reserved BEFORE every request, a counter that cannot be read means no request, and nothing is retried.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { describeQuoteError, MAX_QUOTE_CALLS, QUOTE_TIMEOUT_MS, quotaSpecIsSafe, QuoteError, runQuotes, type QuoteQuery } from "../src/quotes";
import { createSearchApiSource, SEARCHAPI_QUOTA, searchApiAdapter } from "../src/sources/searchapi";
import type { Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const KEY = "searchapi-SECRET-key-0123456789abcdef";
const NOW = new Date("2026-09-29T12:00:00.000Z");
const Q: QuoteQuery = { origin: "JFK", destination: "MAD", departDate: "2026-10-06", returnDate: "2026-10-13", party: { adults: 1 } };
/** The free allowance as the pricing page states it: "Sign up for 100 free requests". */
const DOCUMENTED_ALLOWANCE = 100;

type Rec = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// --- fixtures (from the docs' Google Flights page) -----------------------------------------------------------

const flight = (over: Rec = {}): Rec => ({
  departure_airport: { name: "John F. Kennedy International Airport", id: "JFK", date: "2026-10-06", time: "17:00" },
  arrival_airport: { name: "Adolfo Suárez Madrid–Barajas Airport", id: "MAD", date: "2026-10-07", time: "06:05" },
  duration: 425,
  airplane: "Airbus A330",
  airline: "Iberia",
  airline_logo: "https://www.gstatic.com/flights/airline_logos/70px/IB.png",
  travel_class: "Economy",
  flight_number: "IB 212",
  ticket_also_sold_by: ["American", "Finnair", "British Airways"],
  is_overnight: true,
  extensions: ["Power and USB outlets", "On-demand video", "Carbon emission: 440 kg"],
  ...over,
});

/** The docs' own example: JFK-MAD, 490, one Iberia flight out. The return itinerary is NOT in a round-trip answer. */
const DIRECT: Rec = {
  flights: [flight()],
  total_duration: 425,
  carbon_emissions: { this_flight: 440000, typical_for_this_route: 487000, difference_percent: -10, lowest_route: 509000 },
  price: 490,
  type: "Round trip",
  extensions: ["Bag and fare conditions depend on the return flight"],
  airline_logo: "https://www.gstatic.com/flights/airline_logos/70px/IB.png",
  departure_token: "WyJDalJJWVRGYVNVSkVSemsyWldOQlRVMVNVR2RDUnkwdExTMHRMUzB0TFc5NVpHMHhOMEZCUVVGQlIyTTNVa2h2VEhORFVrbEJFZ1ZKUWpJeE1ob0xDSzMrQWhBQ0dnTlZVMFE0SEhDdC9nST0i",
};

/** Same route, one stop out (the docs' one-way example shape: two segments and a layover), cheaper. */
const ONE_STOP: Rec = {
  flights: [
    flight({
      departure_airport: { name: "John F. Kennedy International Airport", id: "JFK", date: "2026-10-06", time: "22:00" },
      arrival_airport: { name: "Humberto Delgado Airport", id: "LIS", date: "2026-10-07", time: "09:55" },
      duration: 415,
      airline: "Tap Air Portugal",
      flight_number: "TP 210",
    }),
    flight({
      departure_airport: { name: "Humberto Delgado Airport", id: "LIS", date: "2026-10-07", time: "11:50" },
      arrival_airport: { name: "Adolfo Suárez Madrid–Barajas Airport", id: "MAD", date: "2026-10-07", time: "14:05" },
      duration: 75,
      airline: "Tap Air Portugal",
      flight_number: "TP 1014",
    }),
  ],
  layovers: [{ duration: 115, name: "Humberto Delgado Airport", id: "LIS" }],
  total_duration: 605,
  price: 412,
  type: "Round trip",
  extensions: ["Bag and fare conditions depend on the return flight"],
  departure_token: "WyJDalJJY0ZZMU5EUXRUa1p0TkVWQlFuQmtVbEZDUnkwdExTMHRMUzB0TFhCbWIyY3lNRUZCUVVGQlIyUlRMV0p2U1dsNk1s",
};

const answer = (best: unknown[], over: Rec = {}): Rec => ({ best_flights: best, ...over });
const DOCS_ANSWER = answer([DIRECT, ONE_STOP], { price_insights: { lowest_price: 412, typical_price_range: { low_price: 450, high_price: 700 } } });

/** The same answer for other dates (the fixture's two dates rewritten). */
const answerFor = (dep: string, ret: string): Rec => JSON.parse(JSON.stringify(DOCS_ANSWER).replaceAll("2026-10-06", dep).replaceAll("2026-10-07", dep).replaceAll("2026-10-13", ret));

/** A copy of DIRECT with a change applied; `undefined` deletes the key. */
function fare(mutate: (f: Rec) => void): Rec {
  const f = clone(DIRECT);
  mutate(f);
  return f;
}
const firstFlight = (f: Rec): Rec => (f.flights as Rec[])[0] as Rec;

// --- harness ----------------------------------------------------------------------------------------------

function setup(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => json(DOCS_ANSWER), opts: { apiKey?: string | undefined } = { apiKey: KEY }) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init));
  const source = createSearchApiSource({ apiKey: opts.apiKey, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW, marker: "mk" });
  return { db, repo, fetchFn, source };
}

const used = async (db: D1Database): Promise<number> => (await db.prepare("SELECT used FROM source_quota WHERE source = 'searchapi' AND period = 'lifetime'").first<number>("used")) ?? 0;
const rowsOf = async (db: D1Database) => (await db.prepare("SELECT source, period, used FROM source_quota").all<Rec>()).results;
const seedUsed = (db: D1Database, n: number) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('searchapi', 'lifetime', ?, ?)").bind(n, NOW.toISOString()).run();

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

describe("searchapi quota (the owner rule)", () => {
  it("the cap is below the documented free allowance: lifetime, whole, and within the margin the core demands", () => {
    expect(SEARCHAPI_QUOTA.period).toBe("lifetime"); // "100 free requests", no monthly reset stated
    expect(SEARCHAPI_QUOTA.allowance).toBe(DOCUMENTED_ALLOWANCE);
    expect(Number.isInteger(SEARCHAPI_QUOTA.cap)).toBe(true);
    expect(SEARCHAPI_QUOTA.cap).toBeGreaterThanOrEqual(1);
    expect(SEARCHAPI_QUOTA.cap).toBeLessThan(DOCUMENTED_ALLOWANCE);
    expect(SEARCHAPI_QUOTA.cap * 100).toBeLessThanOrEqual(DOCUMENTED_ALLOWANCE * 80); // at most 80% of a one-off allowance
    expect(quotaSpecIsSafe(SEARCHAPI_QUOTA)).toBe(true);
  });

  it("the cap cannot be raised at runtime, and the source and the adapter carry exactly it", () => {
    expect(Object.isFrozen(SEARCHAPI_QUOTA)).toBe(true);
    expect(() => {
      (SEARCHAPI_QUOTA as { cap: number }).cap = 5000;
    }).toThrow(TypeError);
    expect(searchApiAdapter.quota).toBe(SEARCHAPI_QUOTA);
    expect(setup().source.quota).toEqual({ period: "lifetime", cap: 50, allowance: 100 });
    expect(searchApiAdapter.name).toBe("searchapi");
  });

  it("reserves the unit BEFORE the request goes out, in the lifetime row", async () => {
    const { db, repo } = setup();
    const order: string[] = [];
    let usedAtRequest = -1;
    const spyRepo: Repo = { ...repo, reserveQuota: async (...a) => (order.push("reserve"), repo.reserveQuota(...a)) };
    const fetchFn = vi.fn(async () => {
      order.push("fetch");
      usedAtRequest = await used(db);
      return json(DOCS_ANSWER);
    });
    const s = createSearchApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: spyRepo, now: NOW });
    await s.quote(Q);
    expect(order).toEqual(["reserve", "fetch"]);
    expect(usedAtRequest).toBe(1); // already counted while the request was in flight
    expect(await rowsOf(db)).toEqual([{ source: "searchapi", period: "lifetime", used: 1 }]);
    expect(s.callCount()).toBe(1);
  });

  it("refuses the request once the counter is at the cap, and lets exactly the last unit through", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, SEARCHAPI_QUOTA.cap - 1);
    await expect(source.quote(Q)).resolves.toHaveLength(2); // the 50th request
    expect(await used(db)).toBe(SEARCHAPI_QUOTA.cap);
    const err = await rejection(source.quote(Q));
    expect(err.code).toBe("quota_exhausted");
    expect(describeQuoteError(source, err)).toBe("SearchApi: free quota used up (lifetime)");
    expect(fetchFn).toHaveBeenCalledTimes(1); // the 51st never left
    expect(await used(db)).toBe(SEARCHAPI_QUOTA.cap); // and did not raise the counter past the cap
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
      const source = createSearchApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: { ...repo, reserveQuota: reserve }, now: NOW });
      expect((await rejection(source.quote(Q))).code).toBe("quota_exhausted");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(source.callCount()).toBe(0);
    }
  });

  it("a failed request still used its unit, and nothing is ever retried", async () => {
    for (const status of [400, 401, 402, 403, 429, 500, 503]) {
      const { db, fetchFn, source } = setup(() => json({ error: "nope" }, status));
      const err = await rejection(source.quote(Q));
      expect(err, String(status)).toMatchObject({ code: "http", status });
      expect(fetchFn, String(status)).toHaveBeenCalledTimes(1);
      expect(await used(db), String(status)).toBe(1);
    }
    // an empty answer is a successful (billed) request too: it is counted, and not repeated
    const empty = setup(() => json(answer([])));
    await expect(empty.source.quote(Q)).resolves.toEqual([]);
    expect(empty.fetchFn).toHaveBeenCalledTimes(1);
    expect(await used(empty.db)).toBe(1);
  });
});

describe("searchapi configuration", () => {
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

  it("a stray newline in a pasted secret is trimmed before it becomes a header", async () => {
    const { fetchFn, source } = setup(undefined, { apiKey: `${KEY}\n` });
    await source.quote(Q);
    expect((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("searchapi request", () => {
  it("is one GET to the search endpoint: the key in the Authorization header only, ONE adult, economy, round trip in USD", async () => {
    const { fetchFn, source } = setup();
    await source.quote({ ...Q, party: { adults: 3, children: 2 } }); // the party only shapes the booking link
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(`${u.origin}${u.pathname}`).toBe("https://www.searchapi.io/api/v1/search");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      engine: "google_flights",
      flight_type: "round_trip",
      departure_id: "JFK",
      arrival_id: "MAD",
      outbound_date: "2026-10-06",
      return_date: "2026-10-13",
      adults: "1",
      travel_class: "economy",
      currency: "USD",
      sort_by: "price",
      separate_tickets: "1",
    });
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, Accept: "application/json" });
    expect(init?.body).toBeUndefined();
    expect(String(url)).not.toContain(KEY); // nothing that could be echoed back in a URL
    expect(String(url)).not.toContain("api_key");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes exactly one request per quote: no departure_token / booking_token follow-up, no matter what the answer holds", async () => {
    const { fetchFn, source } = setup();
    await source.quote(Q); // the answer carries a departure_token for each fare
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("carries a timeout (AbortSignal.timeout) and reports a request that never answers as one, without a retry", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(25));
    try {
      const { db, fetchFn, source } = setup((_url, init) => new Promise<Response>((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal?.reason))));
      const err = await rejection(source.quote(Q));
      expect(err.code).toBe("timeout");
      expect(describeQuoteError(source, err)).toBe("SearchApi: timeout");
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
      { ...Q, origin: "jfk" },
      { ...Q, destination: "MADRID" },
      { ...Q, destination: "JFK" },
      { ...Q, departDate: "2026-13-01" },
      { ...Q, departDate: "06/10/2026" },
      { ...Q, returnDate: "2026-10-05" }, // before the departure
    ];
    for (const q of bad) {
      const { db, fetchFn, source } = setup();
      const err = await source.quote(q).catch((e: unknown) => e);
      expect(err, JSON.stringify(q)).toBeInstanceOf(RangeError);
      expectNoKey(err);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await rowsOf(db)).toEqual([]);
    }
    // same-day trips are allowed ("on or after")
    await expect(setup().source.quote({ ...Q, returnDate: Q.departDate })).resolves.toBeDefined();
  });
});

describe("searchapi mapping", () => {
  it("maps a normal answer (docs example) to round-trip offers, cheapest first, per adult in USD", async () => {
    const { source } = setup();
    const offers = await source.quote(Q);
    expect(offers.map((o) => o.priceAmount)).toEqual([412, 490]);
    expect(offers[1]).toMatchObject({
      origin: "JFK",
      destination: "MAD",
      departDate: "2026-10-06",
      returnDate: "2026-10-13",
      priceAmount: 490,
      priceCurrency: "USD",
      source: "searchapi",
      ticketStructure: "roundtrip",
      outbound: { departTime: "17:00", arriveTime: "06:05", stops: 0, durationMin: 425, airlines: ["IB"] },
      includes: {}, // the docs give no baggage data: unknown, not "no bag"
      verifyLink: null,
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
      checkedAt: NOW.toISOString(),
    });
    expect(offers[0]).toMatchObject({
      priceAmount: 412,
      outbound: { departTime: "22:00", arriveTime: "14:05", stops: 1, durationMin: 605, airlines: ["TP"] }, // two TP flights, one code
    });
  });

  it("the return itinerary is not in a round-trip answer: it stays unknown (null), never guessed", async () => {
    const offers = await setup().source.quote(Q);
    for (const o of offers) expect(o.inbound).toEqual({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] });
  });

  it("the booking link is the core's Aviasales search for the same dates (the docs give none), and it carries no key", async () => {
    const offers = await setup().source.quote(Q);
    for (const o of offers) {
      expect(o.deeplink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/JFK0610MAD1310/);
      expect(String(o.deeplink)).not.toContain(KEY);
    }
  });

  it("the adapter reads only what the docs give: no booking link, no bag flag, no field it cannot source, and it never edits the answer", () => {
    const body = clone(DOCS_ANSWER);
    const fares = searchApiAdapter.parse(body, Q);
    expect(fares).toHaveLength(2);
    for (const f of fares) expect(Object.keys(f).sort()).toEqual(["currency", "inbound", "outbound", "price"]);
    expect(body).toEqual(DOCS_ANSWER);
  });

  it("an empty best_flights array is a valid answer: no offers, no error", async () => {
    const { source } = setup(() => json(answer([])));
    await expect(source.quote(Q)).resolves.toEqual([]);
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
      { best_flights: "x" },
      { error: "Invalid API key." },
      { error: { code: "invalid_request" } },
      answer([1, null, "x", [], {}, { price: 5 }, { price: {} }, { price: 5, flights: [] }]),
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
      ["price as text", fare((f) => (f.price = "490"))],
      ["no price", fare((f) => delete f.price)],
      ["not a round trip", fare((f) => (f.type = "One way"))],
      ["no flights", fare((f) => delete f.flights)],
      ["empty flights", fare((f) => (f.flights = []))],
      ["unreadable segment", fare((f) => (f.flights = [1]))],
      ["premium economy", fare((f) => (firstFlight(f).travel_class = "Premium Economy"))],
      ["business", fare((f) => (firstFlight(f).travel_class = "Business"))],
      ["departs another day", fare((f) => ((firstFlight(f).departure_airport as Rec).date = "2026-10-07"))],
      ["departs another airport", fare((f) => ((firstFlight(f).departure_airport as Rec).id = "LGA"))],
      ["arrives at another airport", fare((f) => ((firstFlight(f).arrival_airport as Rec).id = "BCN"))],
    ];
    for (const [label, bad] of dropped) {
      expect(searchApiAdapter.parse(answer([bad]), Q), label).toEqual([]);
      expect(searchApiAdapter.parse(answer([bad, ONE_STOP]), Q).map((f) => f.price), label).toEqual([412]);
    }
  });

  it("reads what is tolerable: a lower-case airport echo, no type, no cabin, no layovers, no total duration", () => {
    const [f] = searchApiAdapter.parse(
      answer([fare((x) => { delete x.type; delete x.total_duration; delete x.layovers; delete firstFlight(x).travel_class; (firstFlight(x).departure_airport as Rec).id = " jfk "; })]),
      Q,
    );
    expect(f).toMatchObject({ price: 490, currency: "USD", outbound: { departTime: "17:00", durationMin: null, stops: 0, airlines: ["IB"] } });
  });

  it("leaves every unknown value null (or empty), never guessed", async () => {
    const sparse = fare((f) => {
      f.flights = [{}, { flight_number: "??", departure_airport: { time: "soon" }, arrival_airport: { time: 12 } }];
      f.total_duration = "425";
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
      const f = fare((x) => (x.flights = numbers.map((n) => flight({ flight_number: n }))));
      return searchApiAdapter.parse(answer([f]), { ...Q, destination: "MAD" })[0]?.outbound.airlines;
    };
    // every segment ends at MAD in this helper: only the LAST arrival is checked, the airlines are read per segment
    expect(codes(["IB 212"])).toEqual(["IB"]);
    expect(codes(["9W 1234", "U2 5", "UA 901"])).toEqual(["9W", "U2", "UA"]);
    expect(codes(["TP 210", "TP 1014"])).toEqual(["TP"]);
    expect(codes(["Iberia", "", 212, null, "IBE 212", "I 212"])).toEqual([]);
  });

  it("collapses the same flight twice and keeps only the cheapest MAX offers (core rules apply to searchapi offers too)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => fare((f) => {
      f.price = 500 + i;
      (firstFlight(f).departure_airport as Rec).time = `0${i % 10}:${10 + i}`;
    }));
    const { source } = setup(() => json(answer([...many, many[0]])));
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(20);
    expect(offers[0]?.priceAmount).toBe(500);
    expect(new Set(offers.map((o) => `${o.outbound.departTime}|${o.priceAmount}`)).size).toBe(20);
  });
});

describe("searchapi failures", () => {
  it("HTTP 401, 429 and 500 are reported as errors with fixed texts, and the key never appears in them", async () => {
    const expected: Array<[number, string]> = [
      [401, "SearchApi: HTTP 401"],
      [429, "SearchApi: HTTP 429"],
      [500, "SearchApi: HTTP 500"],
    ];
    for (const [status, text] of expected) {
      // the vendor echoes the key in its error body: it must not get anywhere
      const { source } = setup(() => json({ error: `Invalid API key ${KEY}` }, status));
      const err = await rejection(source.quote(Q));
      expect(err).toMatchObject({ name: "QuoteError", code: "http", status });
      expect(describeQuoteError(source, err)).toBe(text);
      expectNoKey(err);
      expect(describeQuoteError(source, err)).not.toContain(KEY);
    }
  });

  it("a timeout and a dropped connection are reported as such, and the key stays out of them", async () => {
    const cases: Array<[() => never, string]> = [
      [() => { throw new DOMException(`The operation timed out (${KEY})`, "TimeoutError"); }, "timeout"],
      [() => { throw new TypeError(`fetch failed for header Authorization: Bearer ${KEY}`); }, "network"],
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
});

describe("searchapi in the quote phase", () => {
  it("asks once per date pair, never more than the per-search limit, and counts every request", async () => {
    const { db, fetchFn, repo } = setup((url) => {
      const p = new URL(url).searchParams;
      return json(answerFor(String(p.get("outbound_date")), String(p.get("return_date"))));
    });
    const source = createSearchApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW });
    const dates: Array<[string, string]> = [["2026-10-06", "2026-10-13"], ["2026-10-07", "2026-10-14"], ["2026-10-08", "2026-10-15"], ["2026-10-09", "2026-10-16"], ["2026-10-10", "2026-10-17"]];
    const { offers, stats } = await runQuotes([source], { origin: "JFK", dest: "MAD" }, dates, { adults: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(4); // MAX_QUOTE_PAIRS: the cheapest four
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    const asked = fetchFn.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("outbound_date")).sort();
    expect(asked).toEqual(["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(stats.get("searchapi")).toMatchObject({ calls: 4, succeeded: 4, offers: 8, failures: [], notes: [] });
    expect(offers).toHaveLength(8);
    expect(offers.every((o) => o.source === "searchapi" && o.ticketStructure === "roundtrip")).toBe(true);
    expect(new Set(offers.map((o) => `${o.departDate}|${o.returnDate}`)).size).toBe(4); // exactly the pairs asked
    expect(await used(db)).toBe(4);
  });

  it("a source at its cap is skipped with a note, and nothing is requested", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, SEARCHAPI_QUOTA.cap);
    const { offers, stats } = await runQuotes([source], { origin: "JFK", dest: "MAD" }, [["2026-10-06", "2026-10-13"], ["2026-10-07", "2026-10-14"]], { adults: 1 });
    expect(offers).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stats.get("searchapi")).toMatchObject({ calls: 0, succeeded: 0, offers: 0, failures: [], notes: ["SearchApi: free quota used up (lifetime)"] });
    expect(await used(db)).toBe(SEARCHAPI_QUOTA.cap);
  });

  it("never spends more than the cap across many searches: the 51st request of the lifetime is refused", async () => {
    const { db, fetchFn, repo } = setup();
    const source = createSearchApiSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW });
    let refused = 0;
    for (let i = 0; i < SEARCHAPI_QUOTA.cap + 5; i++) {
      await source.quote(Q).catch((e: unknown) => {
        if (e instanceof QuoteError && e.code === "quota_exhausted") refused += 1;
      });
    }
    expect(fetchFn).toHaveBeenCalledTimes(SEARCHAPI_QUOTA.cap);
    expect(refused).toBe(5);
    expect(await used(db)).toBe(SEARCHAPI_QUOTA.cap);
    expect(SEARCHAPI_QUOTA.cap).toBeLessThan(DOCUMENTED_ALLOWANCE);
  });
});
