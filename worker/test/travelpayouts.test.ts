import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import {
  affiliateLink,
  aviasalesSearchLink,
  createTravelpayoutsClient,
  marketForCountry,
  monthsBetween,
  partyCode,
  TravelpayoutsError,
  withPartySize,
} from "../src/travelpayouts";

const TOKEN = "tp-SECRET-token-0123456789abcdef";
const MARKER = "12345";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clone = <T>(v: T): T => structuredClone(v);

interface Call {
  url: URL;
  params: URLSearchParams;
  init: RequestInit;
}
type Handler = (call: Call) => Response | Promise<Response>;

/** Same behaviour as the Python test double: one-way calls get the one-way fixture filtered by origin. */
const tpHandler: Handler = ({ params }) => {
  if (params.get("one_way") === "true") {
    const body = clone(onewayFixture) as { data: { origin: string }[] };
    body.data = body.data.filter((d) => d.origin === params.get("origin"));
    return json(body);
  }
  return json(roundtripFixture);
};

function makeFetch(handler: Handler = tpHandler) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { url, params: url.searchParams, init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return { fn: fn as unknown as typeof fetch, mock: fn, calls };
}

function setup(
  handler: Handler = tpHandler,
  opts: {
    token?: string;
    marker?: string;
    marketFor?: (o: string) => string | null;
    sleepFn?: (ms: number) => Promise<void>;
    randomFn?: () => number;
  } = {},
) {
  const f = makeFetch(handler);
  const client = createTravelpayoutsClient({ token: TOKEN, marker: MARKER, marketFor: () => "il", ...opts, fetchFn: f.fn });
  return { client, ...f };
}

/** A round-trip fixture row with overrides; `undefined` values delete the key. */
function row(over: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { ...clone(roundtripFixture.data[0]), ...over };
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return r;
}
const body = (data: unknown[], extra: Record<string, unknown> = {}) => ({ success: true, currency: "usd", data, ...extra });

async function rejection(p: Promise<unknown>): Promise<TravelpayoutsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TravelpayoutsError);
    return e as TravelpayoutsError;
  }
  throw new Error("expected the promise to reject");
}

/** Everything a caller could see of an error must be free of the token. */
function expectNoToken(e: Error) {
  for (const s of [e.message, String(e), e.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e))]) expect(s).not.toContain(TOKEN);
}

const NOV = ["2026-11-10", "2026-11-25"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("round trips: parsing", () => {
  it("maps fixture rows to Offers (local times, stops, durations, currency, affiliate link)", async () => {
    const { client } = setup();
    const before = Date.now();
    const offers = await client.roundTrips("TLV", "BCN", ...NOV);
    const after = Date.now();

    // The client does not filter by window/stay: the out-of-window third row is the pipeline's job (as in Python).
    expect(offers).toHaveLength(3);
    const o = offers[0]!;
    expect(o).toMatchObject({
      origin: "TLV",
      destination: "BCN",
      departDate: "2026-11-12",
      returnDate: "2026-11-18",
      priceAmount: 189,
      priceCurrency: "USD",
      source: "travelpayouts",
      ticketStructure: "roundtrip",
      includes: {},
      verifyLink: null,
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
    });
    // Local wall-clock times, NOT converted to a common zone (06:15+02:00 -> 06:15, 21:40+01:00 -> 21:40).
    expect(o.outbound).toEqual({ departTime: "06:15", arriveTime: null, stops: 1, durationMin: 420, airlines: ["W6"] });
    expect(o.inbound).toEqual({ departTime: "21:40", arriveTime: null, stops: 1, durationMin: 480, airlines: ["W6"] });
    expect(o.deeplink).toBe(`https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=${MARKER}`);
    expect(o.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(o.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(o.checkedAt)).toBeLessThanOrEqual(after);

    expect(offers[1]).toMatchObject({ priceAmount: 264, outbound: { departTime: "08:05", stops: 0, durationMin: 290, airlines: ["LY"] }, inbound: { departTime: "15:30", stops: 0, durationMin: 270 } });
    expect(offers[2]).toMatchObject({ departDate: "2026-11-21", returnDate: "2026-11-28" });
  });

  it("does not shift the calendar date or time by converting to UTC", async () => {
    const { client } = setup(() => json(body([row({ departure_at: "2026-11-12T23:50:00-08:00", return_at: "2026-11-19T00:10:00+09:00" })])));
    const [o] = await client.roundTrips("TLV", "BCN", ...NOV);
    expect(o).toMatchObject({ departDate: "2026-11-12", returnDate: "2026-11-19", outbound: { departTime: "23:50" }, inbound: { departTime: "00:10" } });
  });

  it("takes the currency from the response body, upper-cased; falls back to the requested one", async () => {
    const eur = await setup(() => json(body([row()], { currency: "eur" }))).client.roundTrips("TLV", "BCN", ...NOV);
    expect(eur[0]!.priceCurrency).toBe("EUR");
    const missing = await setup(() => json({ success: true, data: [row()] })).client.roundTrips("TLV", "BCN", ...NOV);
    expect(missing[0]!.priceCurrency).toBe("USD");
    const junk = await setup(() => json(body([row()], { currency: 42 }))).client.roundTrips("TLV", "BCN", ...NOV);
    expect(junk[0]!.priceCurrency).toBe("USD");
  });

  it("tolerates missing optional fields without guessing values", async () => {
    const { client } = setup(() =>
      json(body([row({ airline: undefined, transfers: undefined, return_transfers: "many", duration_to: undefined, duration_back: 0, link: undefined, origin_airport: undefined, destination_airport: undefined })])),
    );
    const [o] = await client.roundTrips("TLV", "BCN", ...NOV);
    expect(o!.origin).toBe("TLV");
    expect(o!.destination).toBe("BCN");
    expect(o!.outbound).toMatchObject({ stops: null, durationMin: null, airlines: [] });
    expect(o!.inbound).toMatchObject({ stops: null, durationMin: null, airlines: [] });
    // No `link` in the row: the card still gets a working affiliate search link (one adult, like the API's own).
    expect(o!.deeplink).toBe(`https://www.aviasales.com/search/TLV1211BCN18111?marker=${MARKER}`);
  });

  it("falls back to a search link only when the row has no usable link, and never invents one from odd airport codes", async () => {
    const withLink = await setup(() => json(body([row()]))).client.roundTrips("TLV", "BCN", ...NOV);
    expect(withLink[0]!.deeplink).toContain("t=W6_example"); // the API's own ticket link wins
    const blank = await setup(() => json(body([row({ link: "" })]))).client.roundTrips("TLV", "BCN", ...NOV);
    expect(blank[0]!.deeplink).toBe(`https://www.aviasales.com/search/TLV1211BCN18111?marker=${MARKER}`);
    const odd = await setup(() => json(body([row({ link: undefined, origin_airport: "TL/V" })]))).client.roundTrips("TLV", "BCN", ...NOV);
    expect(odd[0]!.deeplink).toBeNull();
  });

  it("uses the real airports from the row when the request was a city code", async () => {
    const { client } = setup(() => json(body([row({ origin_airport: "LGW", destination_airport: "BCN" })])));
    const [o] = await client.roundTrips("LON", "BCN", ...NOV);
    expect(o!.origin).toBe("LGW");
  });

  it("skips rows without a usable price, dates or a coherent trip", async () => {
    const good = row();
    const rows: unknown[] = [
      good,
      row({ price: undefined }),
      row({ price: 0 }),
      row({ price: -50 }),
      row({ price: null }),
      row({ price: "abc" }),
      row({ price: true }),
      row({ return_at: undefined }), // one-way row in a round-trip scan
      row({ return_at: null }),
      row({ departure_at: undefined }),
      row({ departure_at: "not-a-date" }),
      row({ departure_at: "2026-13-45T10:00:00+02:00" }),
      row({ departure_at: "2026-11-20T10:00:00+02:00", return_at: "2026-11-18T10:00:00+01:00" }), // returns before it leaves
      null,
      7,
      "row",
      [],
    ];
    // JSON text can carry 1e999 (parses to Infinity) even though JSON.stringify cannot emit it.
    const text = JSON.stringify(body(rows)).slice(0, -2) + `,${JSON.stringify(row({ price: 0 })).replace('"price":0', '"price":1e999')}]}`;
    const { client } = setup(() => new Response(text, { status: 200 }));
    const offers = await client.roundTrips("TLV", "BCN", ...NOV);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.priceAmount).toBe(189);
  });

  it("accepts a numeric-string price like Python's float()", async () => {
    const { client } = setup(() => json(body([row({ price: "199.5" })])));
    expect((await client.roundTrips("TLV", "BCN", ...NOV))[0]!.priceAmount).toBe(199.5);
  });

  it("treats a missing or empty data array as no offers", async () => {
    expect(await setup(() => json({ success: true, currency: "usd" })).client.roundTrips("TLV", "BCN", ...NOV)).toEqual([]);
    expect(await setup(() => json(body([]))).client.roundTrips("TLV", "BCN", ...NOV)).toEqual([]);
    expect(await setup(() => json({ success: true, data: null })).client.roundTrips("TLV", "BCN", ...NOV)).toEqual([]);
  });
});

describe("requests: token, market, parameters", () => {
  it("sends the token only in the X-Access-Token header, never in the URL", async () => {
    const { client, calls } = setup();
    await client.roundTrips("TLV", "BCN", "2026-10-20", "2026-12-05");
    await client.oneWays("TLV", "BCN", ...NOV);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.href).not.toContain(TOKEN);
      expect([...c.params.values()].join(" ")).not.toContain(TOKEN);
      expect(c.params.has("token")).toBe(false);
      expect(new Headers(c.init.headers).get("X-Access-Token")).toBe(TOKEN);
      expect(c.url.origin + c.url.pathname).toBe("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
      expect(c.init.method).toBe("GET");
    }
  });

  it("never follows redirects (custom headers survive cross-origin redirects)", async () => {
    const { client, calls } = setup(() => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } }));
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(e.status).toBe(301);
  });

  it("sends the Python engine's round-trip parameters, with month granularity", async () => {
    const { client, calls } = setup();
    await client.roundTrips("tlv", "bcn", ...NOV);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.params)).toEqual({
      origin: "TLV",
      destination: "BCN",
      currency: "usd",
      sorting: "price",
      direct: "false",
      unique: "false",
      limit: "1000",
      page: "1",
      market: "il",
      departure_at: "2026-11",
      return_at: "2026-11",
      one_way: "false",
    });
  });

  it("sends one-way parameters: one_way=true, a departure month, no return_at", async () => {
    const { client, calls } = setup();
    await client.oneWays("TLV", "BCN", ...NOV);
    expect(Object.fromEntries(calls[0]!.params)).toMatchObject({ one_way: "true", departure_at: "2026-11", market: "il", limit: "1000" });
    expect(calls[0]!.params.has("return_at")).toBe(false);
  });

  it("asks marketFor with the origin and omits the param when it has no answer", async () => {
    const seen: string[] = [];
    const a = setup(tpHandler, { marketFor: (o) => (seen.push(o), null) });
    await a.client.roundTrips("tlv", "BCN", ...NOV);
    expect(seen).toEqual(["TLV"]);
    expect(a.calls[0]!.params.has("market")).toBe(false);

    const b = setup(tpHandler, { marketFor: undefined });
    // `marketFor: undefined` overrides the setup default, like an omitted option.
    await b.client.roundTrips("TLV", "BCN", ...NOV);
    expect(b.calls[0]!.params.has("market")).toBe(false);
  });

  it("lower-cases the market and drops values that are not a country-style code", async () => {
    const a = setup(tpHandler, { marketFor: () => "IL" });
    await a.client.roundTrips("TLV", "BCN", ...NOV);
    expect(a.calls[0]!.params.get("market")).toBe("il");
    const b = setup(tpHandler, { marketFor: () => "not a market&x=1" });
    await b.client.roundTrips("TLV", "BCN", ...NOV);
    expect(b.calls[0]!.params.has("market")).toBe(false);
    expect(b.calls[0]!.params.has("x")).toBe(false);
  });

  it("a throwing marketFor does not fail the search", async () => {
    const { client, calls } = setup(tpHandler, {
      marketFor: () => {
        throw new Error("airports table unavailable");
      },
    });
    expect(await client.roundTrips("TLV", "BCN", ...NOV)).toHaveLength(3);
    expect(calls[0]!.params.has("market")).toBe(false);
  });

  it("gives every request a 12s abort signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { client, calls } = setup();
    await client.roundTrips("TLV", "BCN", ...NOV);
    expect(timeout).toHaveBeenCalledWith(12000);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.signal!.aborted).toBe(false);
  });

  it("falls back to the global fetch when no fetchFn is given", async () => {
    const stub = vi.fn(async () => json(body([row()])));
    vi.stubGlobal("fetch", stub);
    const client = createTravelpayoutsClient({ token: TOKEN, marker: MARKER });
    expect(await client.roundTrips("TLV", "BCN", ...NOV)).toHaveLength(1);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed IATA codes before any network call", async () => {
    const { client, calls } = setup();
    for (const bad of ["", "TL", "TLVX", "TLV,BCN", "T V"]) {
      await rejection(client.roundTrips(bad, "BCN", ...NOV));
      await rejection(client.oneWays("TLV", bad, ...NOV));
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid window before any network call", async () => {
    const { client, calls } = setup();
    await rejection(client.roundTrips("TLV", "BCN", "soon", "2026-11-25"));
    await rejection(client.oneWays("TLV", "BCN", "2026-11-10", "2026-02-30"));
    expect(calls).toHaveLength(0);
  });
});

describe("month scanning", () => {
  it("scans (departure month, return month >= departure month) pairs in Python order", async () => {
    const { client, calls, mock } = setup();
    await client.roundTrips("TLV", "BCN", "2026-10-20", "2026-12-05");
    expect(calls.map((c) => `${c.params.get("departure_at")}>${c.params.get("return_at")}`)).toEqual([
      "2026-10>2026-10",
      "2026-10>2026-11",
      "2026-10>2026-12",
      "2026-11>2026-11",
      "2026-11>2026-12",
      "2026-12>2026-12",
    ]);
    expect(mock).toHaveBeenCalledTimes(6);
    expect(client.callCount()).toBe(6);
  });

  it("handles a window that crosses a year boundary", async () => {
    const { client, calls } = setup();
    await client.roundTrips("TLV", "BCN", "2026-12-20", "2027-01-08");
    expect(calls.map((c) => `${c.params.get("departure_at")}>${c.params.get("return_at")}`)).toEqual(["2026-12>2026-12", "2026-12>2027-01", "2027-01>2027-01"]);
  });

  it("makes one call for a one-month window", async () => {
    const { client } = setup();
    await client.roundTrips("TLV", "BCN", ...NOV);
    expect(client.callCount()).toBe(1);
  });

  it("makes no call for an inverted window", async () => {
    const { client, calls } = setup();
    expect(await client.roundTrips("TLV", "BCN", "2026-12-01", "2026-11-01")).toEqual([]);
    expect(await client.oneWays("TLV", "BCN", "2026-12-01", "2026-11-01")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("one-way scans make one call per departure month", async () => {
    const { client, calls } = setup();
    await client.oneWays("TLV", "BCN", "2026-10-20", "2026-12-05");
    expect(calls.map((c) => c.params.get("departure_at"))).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(client.callCount()).toBe(3);
  });

  it("retries a transient 5xx and counts every HTTP attempt", async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 2 ? json({ error: "boom" }, 500) : json(roundtripFixture)), { sleepFn: async () => undefined, randomFn: () => 0 });
    expect(await client.roundTrips("TLV", "BCN", "2026-10-20", "2026-12-05")).toHaveLength(3);
    expect(calls).toHaveLength(7); // six planned month pairs plus one retry
    expect(client.callCount()).toBe(7);
  });

  it("uses exponential backoff with bounded jitter", async () => {
    const waits: number[] = [];
    const { client } = setup(() => json({ error: "temporarily unavailable" }, 503), {
      sleepFn: async (ms) => { waits.push(ms); },
      randomFn: () => 0.5,
    });
    await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(waits).toEqual([75, 150]);
  });
});

describe("dedupe", () => {
  it("collapses rows repeated across month-pair calls", async () => {
    const { client, calls } = setup();
    const offers = await client.roundTrips("TLV", "BCN", "2026-10-20", "2026-12-05");
    expect(calls).toHaveLength(6);
    expect(offers).toHaveLength(3); // the same 3 fixture rows came back 6 times
  });

  it("keeps different flights that merely share dates, price and airline", async () => {
    const { client } = setup(() =>
      json(body([row(), row({ departure_at: "2026-11-12T18:30:00+02:00" }), row({ return_at: "2026-11-18T07:00:00+01:00" }), row({ price: 190 }), row({ airline: "LY" })])),
    );
    expect(await client.roundTrips("TLV", "BCN", ...NOV)).toHaveLength(5);
  });

  it("collapses identical rows inside one response", async () => {
    const { client } = setup(() => json(body([row(), row()])));
    expect(await client.roundTrips("TLV", "BCN", ...NOV)).toHaveLength(1);
  });

  it("dedupes one-way fares across months", async () => {
    const { client } = setup();
    const fares = await client.oneWays("TLV", "BCN", "2026-10-20", "2026-12-05");
    expect(client.callCount()).toBe(3);
    expect(fares).toHaveLength(1);
  });
});

describe("one-way fares", () => {
  it("maps fixture rows to OneWayFare", async () => {
    const { client } = setup();
    expect(await client.oneWays("TLV", "BCN", ...NOV)).toEqual([
      {
        date: "2026-11-12",
        priceAmount: 79,
        priceCurrency: "USD",
        leg: { departTime: "06:15", arriveTime: null, stops: 0, durationMin: 290, airlines: ["W6"] },
        deeplink: `https://www.aviasales.com/search/TLV1211BCN1?t=ow1&marker=${MARKER}`,
      },
    ]);
    const back = await client.oneWays("BCN", "TLV", ...NOV);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ date: "2026-11-18", priceAmount: 85, leg: { departTime: "12:10", airlines: ["VY"] } });
  });

  it("falls back to `duration` when duration_to is missing; skips rows without price or date", async () => {
    const ow = (over: Record<string, unknown>) => ({ ...clone(onewayFixture.data[0]), ...over });
    const { client } = setup(() => json(body([ow({ duration_to: undefined, duration: 301 }), ow({ price: undefined }), ow({ price: 0, departure_at: "2026-11-13T10:00:00+02:00" }), ow({ departure_at: undefined }), ow({ price: Number.NaN as unknown as number, departure_at: "2026-11-14T10:00:00+02:00" })])));
    const fares = await client.oneWays("TLV", "BCN", ...NOV);
    expect(fares).toHaveLength(1);
    expect(fares[0]!.leg.durationMin).toBe(301);
  });

  it("keeps one-way rows that have no return date (unlike round trips)", async () => {
    const { client } = setup(() => json(body([row({ return_at: undefined })])));
    expect(await client.oneWays("TLV", "BCN", ...NOV)).toHaveLength(1);
    expect(await client.roundTrips("TLV", "BCN", ...NOV)).toEqual([]);
  });

  it("gives a one-way row without a link a one-way search link in its own direction", async () => {
    const ow = { ...clone(onewayFixture.data[0]), link: undefined };
    const { client } = setup(() => json(body([ow])));
    const [f] = await client.oneWays("TLV", "BCN", ...NOV);
    expect(f!.deeplink).toBe(`https://www.aviasales.com/search/TLV1211BCN1?marker=${MARKER}`);
  });

  it("takes the currency from the body", async () => {
    const { client } = setup(() => json(body([row({ return_at: undefined })], { currency: "ils" })));
    expect((await client.oneWays("TLV", "BCN", ...NOV))[0]!.priceCurrency).toBe("ILS");
  });
});

describe("errors never leak the token", () => {
  it("HTTP 401 -> TravelpayoutsError with the status", async () => {
    const { client, calls } = setup(() => json({ error: "Unauthorized" }, 401));
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(e.status).toBe(401);
    expect(e.message).toContain("HTTP 401");
    expect(e.name).toBe("TravelpayoutsError");
    expect(calls).toHaveLength(1); // permanent 4xx failures are never retried
    expectNoToken(e);
  });

  it("does not retry 429 rate-limit failures", async () => {
    const { client, calls } = setup(() => json({ error: "rate limited" }, 429), { sleepFn: async () => undefined, randomFn: () => 0 });
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(e.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("HTTP 500 -> TravelpayoutsError, even when the server body echoes the token back", async () => {
    const { client } = setup(() => new Response(`upstream failure for X-Access-Token: ${TOKEN}\n${"x".repeat(500)}`, { status: 500 }));
    const e = await rejection(client.oneWays("TLV", "BCN", ...NOV));
    expect(e.status).toBe(500);
    expect(e.message).toContain("HTTP 500");
    expect(e.message).toContain("[redacted]");
    expect(e.message.length).toBeLessThan(260);
    expectNoToken(e);
  });

  it("scrubs a token that straddles the 200-char snippet limit", async () => {
    const { client } = setup(() => new Response("y".repeat(190) + TOKEN, { status: 502 }));
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expectNoToken(e);
    expect(e.message).not.toContain(TOKEN.slice(0, 12));
  });

  it("success:false -> TravelpayoutsError", async () => {
    const { client } = setup(() => json({ success: false, error: `bad request (${TOKEN})`, data: [] }));
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(e.message).toContain("API error");
    expectNoToken(e);
    await rejection(setup(() => json({ data: [row()] })).client.roundTrips("TLV", "BCN", ...NOV)); // success missing
  });

  it("malformed JSON on a 200 -> TravelpayoutsError", async () => {
    for (const text of ["<html>gateway</html>", "{not json", "", "null", "[]", "42", `"str"`]) {
      const e = await rejection(setup(() => new Response(text, { status: 200 })).client.roundTrips("TLV", "BCN", ...NOV));
      expectNoToken(e);
    }
  });

  it("a data field of the wrong type -> TravelpayoutsError", async () => {
    await rejection(setup(() => json({ success: true, data: { TLV: [] } })).client.roundTrips("TLV", "BCN", ...NOV));
    await rejection(setup(() => json({ success: true, data: "rows" })).client.oneWays("TLV", "BCN", ...NOV));
  });

  it("a network failure whose message contains the token is scrubbed", async () => {
    const { client } = setup(() => {
      throw new TypeError(`Headers.append: "${TOKEN}" is an invalid header value`);
    }, { sleepFn: async () => undefined, randomFn: () => 0 });
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(e.message).toContain("network error");
    expect(e.cause).toBeUndefined();
    expectNoToken(e);
    expect(client.callCount()).toBe(3);
  });

  it("a timed-out request is retried at most three times", async () => {
    const { client } = setup(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }, { sleepFn: async () => undefined, randomFn: () => 0 });
    const e = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(e.message).toContain("timed out");
    expect(e.message).toContain("12000");
    expect(client.callCount()).toBe(3);
  });

  it("a manual abort really cancels a hanging request without retrying", async () => {
    const ctl = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctl.signal);
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
        }),
    );
    const pending = client.roundTrips("TLV", "BCN", ...NOV);
    ctl.abort(new DOMException("cancelled", "AbortError"));
    const e = await rejection(pending);
    expect(e.message).toContain("aborted");
  });

  it("a manual abort -> TravelpayoutsError('aborted')", async () => {
    const { client } = setup(() => {
      throw new DOMException("aborted", "AbortError");
    });
    expect((await rejection(client.roundTrips("TLV", "BCN", ...NOV))).message).toContain("aborted");
  });

  it("a failure while reading the body is also a TravelpayoutsError", async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.error(new TypeError(`connection reset ${TOKEN}`));
        },
      }),
      { status: 200 },
    );
    const e = await rejection(setup(() => broken).client.roundTrips("TLV", "BCN", ...NOV));
    expectNoToken(e);
  });
});

describe("configured / not configured", () => {
  it("configured = non-empty token", () => {
    expect(createTravelpayoutsClient({ token: TOKEN }).configured).toBe(true);
    expect(createTravelpayoutsClient({ token: " \n" }).configured).toBe(false);
    expect(createTravelpayoutsClient({ token: "" }).configured).toBe(false);
    expect(createTravelpayoutsClient({}).configured).toBe(false);
  });

  it("throws TravelpayoutsError before any network call when there is no token", async () => {
    for (const token of [undefined, "", "  "]) {
      const f = makeFetch();
      const g = vi.fn(async () => json(body([])));
      vi.stubGlobal("fetch", g);
      const client = createTravelpayoutsClient({ token, marker: MARKER, fetchFn: f.fn });
      const a = await rejection(client.roundTrips("TLV", "BCN", ...NOV));
      const b = await rejection(client.oneWays("TLV", "BCN", ...NOV));
      expect(a.message).toContain("TRAVELPAYOUTS_TOKEN");
      expect(b.message).toContain("TRAVELPAYOUTS_TOKEN");
      expect(f.mock).not.toHaveBeenCalled();
      expect(g).not.toHaveBeenCalled();
      expect(client.callCount()).toBe(0);
    }
  });

  it("checks the token before validating anything else", async () => {
    const f = makeFetch();
    const client = createTravelpayoutsClient({ fetchFn: f.fn });
    expect((await rejection(client.roundTrips("??", "BCN", "bad", "worse"))).message).toContain("TRAVELPAYOUTS_TOKEN");
  });

  it("trims a pasted token so a trailing newline cannot invalidate the header", async () => {
    const { client, calls } = setup(tpHandler, { token: `${TOKEN}\n` });
    await client.roundTrips("TLV", "BCN", ...NOV);
    expect(new Headers(calls[0]!.init.headers).get("X-Access-Token")).toBe(TOKEN);
  });
});

describe("callCount", () => {
  it("counts HTTP requests actually issued, cumulatively, including failed ones", async () => {
    let fail = false;
    const { client } = setup(() => (fail ? json({ error: "x" }, 503) : json(roundtripFixture)));
    expect(client.callCount()).toBe(0);
    await client.roundTrips("TLV", "BCN", ...NOV); // 1
    await client.oneWays("TLV", "BCN", "2026-10-01", "2026-11-30"); // 2 more
    expect(client.callCount()).toBe(3);
    fail = true;
    await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(client.callCount()).toBe(6);
  });

  it("caps transient retries at five for one client, even across separate calls", async () => {
    const { client, calls } = setup(() => json({ error: "temporarily unavailable" }, 503), { sleepFn: async () => undefined, randomFn: () => 0 });
    for (let i = 0; i < 6; i += 1) await rejection(client.roundTrips("TLV", "BCN", ...NOV));
    expect(client.callCount()).toBe(11); // six original calls plus at most five retries
    expect(calls).toHaveLength(11);
  });

  it("does not count validation failures or empty windows", async () => {
    const { client } = setup();
    await rejection(client.roundTrips("XX", "BCN", ...NOV));
    await client.roundTrips("TLV", "BCN", "2026-12-01", "2026-11-01");
    expect(client.callCount()).toBe(0);
  });

  it("is per client instance", async () => {
    const a = setup().client;
    const b = setup().client;
    await a.roundTrips("TLV", "BCN", ...NOV);
    expect([a.callCount(), b.callCount()]).toEqual([1, 0]);
  });
});

describe("affiliateLink", () => {
  it("returns null for a missing path", () => {
    expect(affiliateLink(null, "1")).toBeNull();
    expect(affiliateLink("", "1")).toBeNull();
  });

  it("prefixes relative paths with aviasales.com and appends the marker", () => {
    expect(affiliateLink("/search/TLV1211BCN18111", "999")).toBe("https://www.aviasales.com/search/TLV1211BCN18111?marker=999");
    expect(affiliateLink("/search/X?t=1&a=b", "999")).toBe("https://www.aviasales.com/search/X?t=1&a=b&marker=999");
    expect(affiliateLink("search/X", "999")).toBe("https://www.aviasales.com/search/X?marker=999");
  });

  it("leaves absolute http(s) URLs alone apart from the marker", () => {
    expect(affiliateLink("https://www.aviasales.com/search/X", "5")).toBe("https://www.aviasales.com/search/X?marker=5");
    expect(affiliateLink("HTTP://example.com/a?b=1", "5")).toBe("HTTP://example.com/a?b=1&marker=5");
  });

  it("omits the marker when it is empty, whitespace or undefined", () => {
    expect(affiliateLink("/search/X")).toBe("https://www.aviasales.com/search/X");
    expect(affiliateLink("/search/X", "")).toBe("https://www.aviasales.com/search/X");
    expect(affiliateLink("/search/X", "  ")).toBe("https://www.aviasales.com/search/X");
  });

  it("URL-encodes the marker like Python's urlencode", () => {
    expect(affiliateLink("/s", "a b&c=d*e~f")).toBe("https://www.aviasales.com/s?marker=a+b%26c%3Dd%2Ae~f");
  });

  it("never produces a non-web scheme from a hostile link", () => {
    for (const evil of ["javascript:alert(1)", "data:text/html,x", "//evil.example/x", "ftp://x/y"]) {
      const link = affiliateLink(evil, "1")!;
      expect(link.startsWith("https://www.aviasales.com/")).toBe(true);
    }
  });
});

describe("aviasalesSearchLink", () => {
  it("matches the Python format (origin DDMM dest DDMM pax)", () => {
    expect(aviasalesSearchLink("TLV", "BCN", "2026-11-12", "2026-11-18", 1, "999")).toBe("https://www.aviasales.com/search/TLV1211BCN18111?marker=999");
  });

  it("builds a one-way link, pads day/month, and works without a marker", () => {
    expect(aviasalesSearchLink("TLV", "BCN", "2026-03-05", null, 2)).toBe("https://www.aviasales.com/search/TLV0503BCN2");
  });

  it("upper-cases IATA codes", () => {
    expect(aviasalesSearchLink("tlv", "bcn", "2026-11-12", "2026-11-18", 1)).toContain("/search/TLV1211BCN1811");
  });

  it("rejects impossible input instead of emitting a broken link", () => {
    expect(() => aviasalesSearchLink("TLV", "BCN", "2026-02-30", null, 1)).toThrow(RangeError);
    expect(() => aviasalesSearchLink("TLV", "BCN", "2026-11-12", "nope", 1)).toThrow(RangeError);
    expect(() => aviasalesSearchLink("TL/V", "BCN", "2026-11-12", null, 1)).toThrow(RangeError);
    expect(() => aviasalesSearchLink("TLV", "BCN", "2026-11-12", null, 0)).toThrow(RangeError);
    expect(() => aviasalesSearchLink("TLV", "BCN", "2026-11-12", null, 1.5)).toThrow(RangeError);
  });
});

describe("party size in links", () => {
  it("encodes adults, then children, then infants, dropping trailing zeros", () => {
    expect(partyCode({ adults: 1 })).toBe("1");
    expect(partyCode({ adults: 2, children: 1 })).toBe("21");
    expect(partyCode({ adults: 2, children: 1, infants: 1 })).toBe("211");
    expect(partyCode({ adults: 2, children: 0, infants: 1 })).toBe("201");
    expect(partyCode({ adults: 3, children: 0, infants: 0 })).toBe("3");
    expect(() => partyCode({ adults: 0 })).toThrow(RangeError);
    expect(() => partyCode({ adults: 10 })).toThrow(RangeError);
    expect(() => partyCode({ adults: 1, children: -1 })).toThrow(RangeError);
  });

  it("aviasalesSearchLink accepts a full party as well as a plain adult count", () => {
    expect(aviasalesSearchLink("TLV", "BCN", "2026-11-12", "2026-11-18", { adults: 2, children: 1 }, "9")).toBe("https://www.aviasales.com/search/TLV1211BCN181121?marker=9");
    expect(aviasalesSearchLink("TLV", "BCN", "2026-11-12", null, { adults: 1 })).toBe("https://www.aviasales.com/search/TLV1211BCN1");
  });

  it("rewrites a round-trip link's passenger code and keeps the ticket id and marker", () => {
    const link = `https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=${MARKER}`;
    expect(withPartySize(link, { adults: 2, children: 1 })).toBe(`https://www.aviasales.com/search/TLV1211BCN181121?t=W6_example&marker=${MARKER}`);
    expect(withPartySize(link, { adults: 1 })).toBe(link);
  });

  it("rewrites a one-way link's passenger code (even one that already has several digits)", () => {
    expect(withPartySize("https://www.aviasales.com/search/TLV1211BCN1?t=ow1", { adults: 2, children: 1, infants: 1 })).toBe("https://www.aviasales.com/search/TLV1211BCN211?t=ow1");
    expect(withPartySize("https://www.aviasales.com/search/TLV1211BCN211?t=ow1", { adults: 3 })).toBe("https://www.aviasales.com/search/TLV1211BCN3?t=ow1");
    expect(withPartySize("https://www.aviasales.com/search/BCN1811TLV1", { adults: 4 })).toBe("https://www.aviasales.com/search/BCN1811TLV4");
  });

  it("leaves anything that is not a recognisable Aviasales search link untouched", () => {
    const party = { adults: 2 };
    expect(withPartySize(null, party)).toBeNull();
    expect(withPartySize("", party)).toBe("");
    expect(withPartySize("https://example.com/search/TLV1211BCN1", party)).toBe("https://example.com/search/TLV1211BCN1");
    expect(withPartySize("https://www.aviasales.com/search/TLV1211BCN1811", party)).toBe("https://www.aviasales.com/search/TLV1211BCN1811"); // 4 digits: ambiguous, not touched
    expect(withPartySize("https://www.aviasales.com/other/TLV1211BCN1", party)).toBe("https://www.aviasales.com/other/TLV1211BCN1");
  });

  it("returned by the client with a marker: the rewrite keeps the marker (the affiliate id must survive)", async () => {
    const { client } = setup();
    const [o] = await client.roundTrips("TLV", "BCN", ...NOV);
    expect(withPartySize(o!.deeplink, { adults: 2, children: 1 })).toBe(`https://www.aviasales.com/search/TLV1211BCN181121?t=W6_example&marker=${MARKER}`);
  });
});

describe("monthsBetween", () => {
  it("lists every month inclusively", () => {
    expect(monthsBetween("2026-11-10", "2026-11-25")).toEqual(["2026-11"]);
    expect(monthsBetween("2026-10-31", "2027-02-01")).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("is empty when start is after end", () => {
    expect(monthsBetween("2026-12-01", "2026-11-30")).toEqual([]);
    expect(monthsBetween("2027-01-01", "2026-12-31")).toEqual([]);
  });

  it("zero-pads the month and accepts full ISO timestamps", () => {
    expect(monthsBetween("2026-01-15T10:00:00Z", "2026-03-01")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("rejects invalid dates", () => {
    expect(() => monthsBetween("2026-13-01", "2026-12-01")).toThrow(RangeError);
    expect(() => monthsBetween("2026-11-01", "")).toThrow(RangeError);
  });
});

describe("marketForCountry", () => {
  it("mirrors MARKET_BY_COUNTRY in engine/tpe/config.py", () => {
    expect(marketForCountry("IL")).toBe("il");
    expect(marketForCountry("gb")).toBe("uk");
    expect(marketForCountry("US")).toBe("us");
    expect(marketForCountry("GR")).toBeNull();
    expect(marketForCountry(null)).toBeNull();
    expect(marketForCountry(undefined)).toBeNull();
    expect(marketForCountry("constructor")).toBeNull(); // not an own key of the table
  });
});

describe("Workers runtime rules", () => {
  const src = readFileSync(join(__dirname, "../src/travelpayouts.ts"), "utf8");

  it("uses no node: imports, fs, Buffer or process", () => {
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/\b(Buffer|process\.|__dirname)\b/);
  });

  it("never logs", () => {
    expect(src).not.toMatch(/console\./);
  });

  it("does not hardcode a token", () => {
    expect(src).not.toMatch(/X-Access-Token["']?\s*:\s*["'][A-Za-z0-9]{8,}["']/);
  });
});
