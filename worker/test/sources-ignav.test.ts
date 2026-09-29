/**
 * Ignav live fare source (src/sources/ignav.ts).
 * FIXTURES: built from the vendor docs (the round-trip and response-format pages and their example response), NOT from
 * a live call. The live service was never contacted, and nothing here leaves the machine: every request goes to a stub.
 * Owner rule under test: nothing may cost money. Ignav's free allowance is 1,000 requests in total, so the cap sits below
 * it, one unit is reserved BEFORE every request, a counter that cannot be read means no request, and nothing is retried.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { describeQuoteError, MAX_QUOTE_CALLS, QUOTE_TIMEOUT_MS, quotaSpecIsSafe, QuoteError, runQuotes, type QuoteQuery } from "../src/quotes";
import { createIgnavSource, IGNAV_QUOTA, ignavAdapter } from "../src/sources/ignav";
import type { Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const KEY = "ignav-SECRET-key-0123456789abcdef";
const NOW = new Date("2026-09-29T12:00:00.000Z");
const Q: QuoteQuery = { origin: "SFO", destination: "LHR", departDate: "2026-10-22", returnDate: "2026-10-29", party: { adults: 1 } };
/** The free allowance as the docs state it: "1,000 one-time free requests." */
const DOCUMENTED_ALLOWANCE = 1000;

type Rec = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// --- fixtures (from the docs' response-format page) ---------------------------------------------------------

const segment = (over: Rec = {}): Rec => ({
  marketing_carrier_code: "BA",
  flight_number: "286",
  operating_carrier_name: "British Airways",
  departure_airport: "SFO",
  departure_time_local: "2026-10-22T17:30:00",
  departure_timezone: "America/Los_Angeles",
  departure_time_utc: "2026-10-23T00:30:00Z",
  arrival_airport: "LHR",
  arrival_time_local: "2026-10-23T11:55:00",
  arrival_timezone: "Europe/London",
  arrival_time_utc: "2026-10-23T10:55:00Z",
  duration_minutes: 625,
  aircraft: "Airbus A380",
  ...over,
});

/** The docs' own example: SFO-LHR-SFO, 899 USD, verified, direct both ways. */
const DIRECT: Rec = {
  price: { amount: 899, currency: "USD", status: "verified" },
  outbound: { carrier: "British Airways", duration_minutes: 625, segments: [segment()] },
  inbound: {
    carrier: "British Airways",
    duration_minutes: 595,
    segments: [
      segment({
        flight_number: "287",
        departure_airport: "LHR",
        departure_time_local: "2026-10-29T13:05:00",
        departure_time_utc: "2026-10-29T13:05:00Z",
        arrival_airport: "SFO",
        arrival_time_local: "2026-10-29T16:00:00",
        arrival_time_utc: "2026-10-29T23:00:00Z",
        duration_minutes: 595,
      }),
    ],
  },
  cabin_class: "economy",
  bags: { carry_on: 1, checked: 0 },
  requires_self_transfer: false,
  ignav_id: "a1b2c3d4e5f6789012345678abcdef01",
};

/** Same route, one stop out (two carriers), a checked bag included, cheaper. */
const ONE_STOP: Rec = {
  price: { amount: 755, currency: "USD", status: "verified" },
  outbound: {
    carrier: "United",
    duration_minutes: 955,
    segments: [
      segment({ marketing_carrier_code: "UA", flight_number: "901", departure_time_local: "2026-10-22T06:00:00", arrival_airport: "EWR", arrival_time_local: "2026-10-22T14:30:00", duration_minutes: 330 }),
      segment({ marketing_carrier_code: "VS", flight_number: "4", departure_airport: "EWR", departure_time_local: "2026-10-22T17:45:00", arrival_time_local: "2026-10-23T05:55:00", duration_minutes: 430 }),
    ],
  },
  inbound: {
    carrier: "Virgin Atlantic",
    duration_minutes: 640,
    segments: [segment({ marketing_carrier_code: "VS", flight_number: "19", departure_airport: "LHR", departure_time_local: "2026-10-29T11:40:00", arrival_airport: "SFO", arrival_time_local: "2026-10-29T14:20:00", duration_minutes: 640 })],
  },
  cabin_class: "economy",
  bags: { carry_on: 1, checked: 1 },
  requires_self_transfer: false,
  ignav_id: "0123456789abcdef0123456789abcdef",
};

const answer = (itineraries: unknown[], over: Rec = {}): Rec => ({ origin: "SFO", destination: "LHR", departure_date: "2026-10-22", return_date: "2026-10-29", itineraries, ...over });
const DOCS_ANSWER = answer([DIRECT, ONE_STOP]);

/** The same answer for other dates (the fixture's two dates rewritten). */
const answerFor = (dep: string, ret: string): Rec => JSON.parse(JSON.stringify(DOCS_ANSWER).replaceAll("2026-10-22", dep).replaceAll("2026-10-29", ret));

/** A copy of DIRECT with a change applied; `undefined` deletes the key. */
function itin(mutate: (it: Rec) => void): Rec {
  const it = clone(DIRECT);
  mutate(it);
  return it;
}
const withPrice = (over: Rec) => itin((it) => Object.assign(it.price as Rec, over));

// --- harness ----------------------------------------------------------------------------------------------

function setup(respond: (init: RequestInit | undefined) => Response | Promise<Response> = () => json(DOCS_ANSWER), opts: { apiKey?: string | undefined } = { apiKey: KEY }) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => respond(init));
  const source = createIgnavSource({ apiKey: opts.apiKey, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW, marker: "mk" });
  return { db, repo, fetchFn, source };
}

const used = async (db: D1Database): Promise<number> => (await db.prepare("SELECT used FROM source_quota WHERE source = 'ignav' AND period = 'lifetime'").first<number>("used")) ?? 0;
const rowsOf = async (db: D1Database) => (await db.prepare("SELECT source, period, used FROM source_quota").all<Rec>()).results;
const seedUsed = (db: D1Database, n: number) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('ignav', 'lifetime', ?, ?)").bind(n, NOW.toISOString()).run();

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

describe("ignav quota (the owner rule)", () => {
  it("the cap is below the documented free allowance: lifetime, whole, and within the margin the core demands", () => {
    expect(IGNAV_QUOTA.period).toBe("lifetime"); // "do not reset monthly"
    expect(IGNAV_QUOTA.allowance).toBe(DOCUMENTED_ALLOWANCE);
    expect(Number.isInteger(IGNAV_QUOTA.cap)).toBe(true);
    expect(IGNAV_QUOTA.cap).toBeGreaterThanOrEqual(1);
    expect(IGNAV_QUOTA.cap).toBeLessThan(DOCUMENTED_ALLOWANCE);
    expect(IGNAV_QUOTA.cap * 100).toBeLessThanOrEqual(DOCUMENTED_ALLOWANCE * 80); // at most 80% of a one-off allowance
    expect(quotaSpecIsSafe(IGNAV_QUOTA)).toBe(true);
  });

  it("the cap cannot be raised at runtime, and the source and the adapter carry exactly it", () => {
    expect(Object.isFrozen(IGNAV_QUOTA)).toBe(true);
    expect(() => {
      (IGNAV_QUOTA as { cap: number }).cap = 5000;
    }).toThrow(TypeError);
    expect(ignavAdapter.quota).toBe(IGNAV_QUOTA);
    expect(setup().source.quota).toEqual({ period: "lifetime", cap: 800, allowance: 1000 });
    expect(ignavAdapter.name).toBe("ignav");
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
    const s = createIgnavSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: spyRepo, now: NOW });
    await s.quote(Q);
    expect(order).toEqual(["reserve", "fetch"]);
    expect(usedAtRequest).toBe(1); // already counted while the request was in flight
    expect(await rowsOf(db)).toEqual([{ source: "ignav", period: "lifetime", used: 1 }]);
    expect(s.callCount()).toBe(1);
  });

  it("refuses the request once the counter is at the cap, and lets exactly the last unit through", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, IGNAV_QUOTA.cap - 1);
    await expect(source.quote(Q)).resolves.toHaveLength(2); // the 800th request
    expect(await used(db)).toBe(IGNAV_QUOTA.cap);
    const err = await rejection(source.quote(Q));
    expect(err.code).toBe("quota_exhausted");
    expect(describeQuoteError(source, err)).toBe("Ignav: free quota used up (lifetime)");
    expect(fetchFn).toHaveBeenCalledTimes(1); // the 801st never left
    expect(await used(db)).toBe(IGNAV_QUOTA.cap); // and did not raise the counter past the cap
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
      const source = createIgnavSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo: { ...repo, reserveQuota: reserve }, now: NOW });
      expect((await rejection(source.quote(Q))).code).toBe("quota_exhausted");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(source.callCount()).toBe(0);
    }
  });

  it("a failed request still used its unit, and nothing is ever retried", async () => {
    for (const status of [401, 402, 403, 424, 429, 500, 503]) {
      const { db, fetchFn, source } = setup(() => json({ error: { type: "x", code: "y", message: "no" } }, status));
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

describe("ignav configuration", () => {
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
    expect((fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
  });
});

describe("ignav request", () => {
  it("is one POST to the round-trip endpoint: the key in a header only, ONE adult, economy, no self-transfers", async () => {
    const { fetchFn, source } = setup();
    await source.quote({ ...Q, party: { adults: 3, children: 2 } }); // the party only shapes the booking link
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://ignav.com/api/fares/round-trip");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "X-Api-Key": KEY, "Content-Type": "application/json", Accept: "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      origin: "SFO",
      destination: "LHR",
      departure_date: "2026-10-22",
      return_date: "2026-10-29",
      adults: 1,
      cabin_class: "economy",
      allow_self_transfer: false,
    });
    expect(String(url)).not.toContain(KEY);
    expect(String(init?.body)).not.toContain(KEY);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("carries a timeout (AbortSignal.timeout) and reports a request that never answers as one, without a retry", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(25));
    try {
      const { db, fetchFn, source } = setup((init) => new Promise<Response>((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal?.reason))));
      const err = await rejection(source.quote(Q));
      expect(err.code).toBe("timeout");
      expect(describeQuoteError(source, err)).toBe("Ignav: timeout");
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
      { ...Q, origin: "sfo" },
      { ...Q, destination: "LONDON" },
      { ...Q, destination: "SFO" },
      { ...Q, departDate: "2026-13-01" },
      { ...Q, departDate: "22/10/2026" },
      { ...Q, returnDate: "2026-10-21" }, // before the departure
    ];
    for (const q of bad) {
      const { db, fetchFn, source } = setup();
      const err = await source.quote(q).catch((e: unknown) => e);
      expect(err, JSON.stringify(q)).toBeInstanceOf(RangeError);
      expectNoKey(err);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await rowsOf(db)).toEqual([]);
    }
    // same-day trips are allowed by the vendor ("on or after")
    await expect(setup().source.quote({ ...Q, returnDate: Q.departDate })).resolves.toBeDefined();
  });
});

describe("ignav mapping", () => {
  it("maps a normal answer (docs example) to round-trip offers, cheapest first, per adult in the vendor's currency", async () => {
    const { source } = setup();
    const offers = await source.quote(Q);
    expect(offers.map((o) => o.priceAmount)).toEqual([755, 899]);
    expect(offers[1]).toMatchObject({
      origin: "SFO",
      destination: "LHR",
      departDate: "2026-10-22",
      returnDate: "2026-10-29",
      priceAmount: 899,
      priceCurrency: "USD",
      source: "ignav",
      ticketStructure: "roundtrip",
      outbound: { departTime: "17:30", arriveTime: "11:55", stops: 0, durationMin: 625, airlines: ["BA"] },
      inbound: { departTime: "13:05", arriveTime: "16:00", stops: 0, durationMin: 595, airlines: ["BA"] },
      includes: { checkedBag: false },
      verifyLink: null,
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
      checkedAt: NOW.toISOString(),
    });
    expect(offers[0]).toMatchObject({
      priceAmount: 755,
      outbound: { departTime: "06:00", arriveTime: "05:55", stops: 1, durationMin: 955, airlines: ["UA", "VS"] },
      inbound: { departTime: "11:40", arriveTime: "14:20", stops: 0, durationMin: 640, airlines: ["VS"] },
      includes: { checkedBag: true },
    });
  });

  it("the adapter reads only what the docs give: no booking link, no field it cannot source, and it never edits the answer", () => {
    const body = clone(DOCS_ANSWER);
    const fares = ignavAdapter.parse(body, Q);
    expect(fares).toHaveLength(2);
    for (const f of fares) expect(Object.keys(f).sort()).toEqual(["checkedBag", "currency", "inbound", "outbound", "price"]);
    expect(body).toEqual(DOCS_ANSWER);
  });

  it("an empty itineraries array is a valid answer: no offers, no error", async () => {
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
      { itineraries: null },
      { itineraries: {} },
      { itineraries: "x" },
      { error: { type: "invalid_request", code: "invalid_airport_code", message: "bad", field: "origin" } },
      answer([1, null, "x", [], {}, { price: 5 }, { price: {} }]),
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

  it("an answer for another airport pair is not used", () => {
    expect(ignavAdapter.parse(answer([DIRECT], { origin: "OAK" }), Q)).toEqual([]);
    expect(ignavAdapter.parse(answer([DIRECT], { destination: "LGW" }), Q)).toEqual([]);
    expect(ignavAdapter.parse(answer([DIRECT], { origin: " sfo ", destination: "lhr" }), Q)).toHaveLength(1); // same airports, other spelling
    expect(ignavAdapter.parse({ itineraries: [DIRECT] }, Q)).toHaveLength(1); // echoes are optional
  });

  it("drops what it cannot vouch for, and keeps the good itineraries next to it", () => {
    const dropped: Array<[string, Rec]> = [
      ["unverified price", withPrice({ status: "unverified" })],
      ["no price status", withPrice({ status: undefined })],
      ["zero price", withPrice({ amount: 0 })],
      ["negative price", withPrice({ amount: -5 })],
      ["price as text", withPrice({ amount: "899" })],
      ["no price amount", withPrice({ amount: undefined })],
      ["bad currency", withPrice({ currency: "US" })],
      ["no currency", withPrice({ currency: undefined })],
      ["self-transfer", itin((it) => (it.requires_self_transfer = true))],
      ["business cabin", itin((it) => (it.cabin_class = "business"))],
      ["no inbound", itin((it) => delete it.inbound)],
      ["null inbound", itin((it) => (it.inbound = null))],
      ["inbound without segments", itin((it) => ((it.inbound as Rec).segments = []))],
      ["unreadable segment", itin((it) => ((it.outbound as Rec).segments = [1]))],
      ["outbound on another day", itin((it) => ((((it.outbound as Rec).segments as Rec[])[0] as Rec).departure_time_local = "2026-10-23T17:30:00"))],
      ["inbound on another day", itin((it) => ((((it.inbound as Rec).segments as Rec[])[0] as Rec).departure_time_local = "2026-10-30T13:05:00"))],
    ];
    for (const [label, bad] of dropped) {
      expect(ignavAdapter.parse(answer([bad]), Q), label).toEqual([]);
      expect(ignavAdapter.parse(answer([bad, ONE_STOP]), Q).map((f) => f.price), label).toEqual([755]);
    }
  });

  it("reads what is tolerable: a lower-case currency, a missing self-transfer flag, a missing cabin, no bag data", () => {
    const [fare] = ignavAdapter.parse(
      answer([itin((it) => { it.price = { amount: 912.5, currency: "eur", status: "verified" }; delete it.requires_self_transfer; delete it.cabin_class; delete it.bags; })]),
      Q,
    );
    expect(fare).toMatchObject({ price: 912.5, currency: "EUR" });
    expect(fare && "checkedBag" in fare).toBe(false); // unknown, not guessed
  });

  it("leaves every unknown value null (or empty), never guessed", async () => {
    const sparse = itin((it) => {
      it.outbound = { segments: [{}] };
      it.inbound = { duration_minutes: "595", segments: [{ marketing_carrier_code: null, departure_time_local: "soon" }, { marketing_carrier_code: "X", arrival_time_local: 12 }] };
      delete it.bags;
    });
    const { source } = setup(() => json(answer([sparse])));
    const [o] = await source.quote(Q);
    expect(o?.outbound).toEqual({ departTime: null, arriveTime: null, stops: 0, durationMin: null, airlines: [] });
    expect(o?.inbound).toEqual({ departTime: null, arriveTime: null, stops: 1, durationMin: null, airlines: [] });
    expect(o?.includes).toEqual({});
    expect(o?.verifyLink).toBeNull();
  });

  it("reads the bag count as included bags: none is false, some is true, garbage is unknown", () => {
    const bagsOf = (bags: unknown) => ignavAdapter.parse(answer([itin((it) => (it.bags = bags))]), Q)[0]?.checkedBag;
    expect(bagsOf({ carry_on: 1, checked: 0 })).toBe(false);
    expect(bagsOf({ carry_on: 0, checked: 2 })).toBe(true);
    expect(bagsOf({ carry_on: 1 })).toBeUndefined();
    expect(bagsOf({ checked: -1 })).toBeUndefined();
    expect(bagsOf({ checked: "1" })).toBeUndefined();
    expect(bagsOf(null)).toBeUndefined();
  });

  it("collapses the same flight twice and keeps only the cheapest MAX offers (core rules apply to ignav offers too)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => itin((it) => {
      (it.price as Rec).amount = 900 + i;
      ((((it.outbound as Rec).segments as Rec[])[0]) as Rec).departure_time_local = `2026-10-22T0${i % 10}:${10 + i}:00`;
    }));
    const { source } = setup(() => json(answer([...many, many[0]])));
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(20);
    expect(offers[0]?.priceAmount).toBe(900);
    expect(new Set(offers.map((o) => `${o.outbound.departTime}|${o.priceAmount}`)).size).toBe(20);
  });
});

describe("ignav failures", () => {
  it("HTTP 401, 429 and 500 are reported as errors with fixed texts, and the key never appears in them", async () => {
    const expected: Array<[number, string]> = [
      [401, "Ignav: HTTP 401"],
      [429, "Ignav: HTTP 429"],
      [500, "Ignav: HTTP 500"],
    ];
    for (const [status, text] of expected) {
      // the vendor echoes the key in its error body: it must not get anywhere
      const { source } = setup(() => json({ error: { type: "auth", code: "invalid_api_key", message: `key ${KEY} was not accepted` } }, status));
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
      [() => { throw new TypeError(`fetch failed for header X-Api-Key: ${KEY}`); }, "network"],
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
});

describe("ignav in the quote phase", () => {
  it("asks once per date pair, never more than the per-search limit, and counts every request", async () => {
    const { db, fetchFn, repo } = setup((init) => {
      const b = JSON.parse(String(init?.body)) as { departure_date: string; return_date: string };
      return json(answerFor(b.departure_date, b.return_date));
    });
    const source = createIgnavSource({ apiKey: KEY, fetchFn: fetchFn as unknown as typeof fetch, repo, now: NOW });
    const dates: Array<[string, string]> = [["2026-10-22", "2026-10-29"], ["2026-10-23", "2026-10-30"], ["2026-10-24", "2026-10-31"], ["2026-10-25", "2026-11-01"], ["2026-10-26", "2026-11-02"]];
    const { offers, stats } = await runQuotes([source], { origin: "SFO", dest: "LHR" }, dates, { adults: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(4); // MAX_QUOTE_PAIRS: the cheapest four
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
    const asked = fetchFn.mock.calls.map((c) => (JSON.parse(String(c[1]?.body)) as { departure_date: string }).departure_date).sort();
    expect(asked).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(stats.get("ignav")).toMatchObject({ calls: 4, succeeded: 4, offers: 8, failures: [], notes: [] });
    expect(offers).toHaveLength(8);
    expect(offers.every((o) => o.source === "ignav" && o.ticketStructure === "roundtrip")).toBe(true);
    expect(new Set(offers.map((o) => `${o.departDate}|${o.returnDate}`)).size).toBe(4); // exactly the pairs asked
    expect(await used(db)).toBe(4);
  });

  it("a source at its cap is skipped with a note, and nothing is requested", async () => {
    const { db, fetchFn, source } = setup();
    await seedUsed(db, IGNAV_QUOTA.cap);
    const { offers, stats } = await runQuotes([source], { origin: "SFO", dest: "LHR" }, [["2026-10-22", "2026-10-29"], ["2026-10-23", "2026-10-30"]], { adults: 1 });
    expect(offers).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stats.get("ignav")).toMatchObject({ calls: 0, succeeded: 0, offers: 0, failures: [], notes: ["Ignav: free quota used up (lifetime)"] });
    expect(await used(db)).toBe(IGNAV_QUOTA.cap);
  });
});
