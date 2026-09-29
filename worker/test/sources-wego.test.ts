/**
 * Wego Affiliate flights source (src/sources/wego.ts). Owner rule under test: nothing may ever cost money, so a unit of a
 * hard lifetime cap is reserved BEFORE the first vendor request, a counter that cannot be read means no request, nothing
 * is retried, and neither the client id nor a vendor body ever reaches an error.
 *
 * FIXTURES: every vendor response below is written by hand from the documented shapes (developers.wego.com/docs/affiliate/
 * references/flights and flight-objects, guides/flights, guides/authentication). None comes from a live call and no test
 * here ever leaves the machine: the fetch is a stub. The real service may differ; see the unknowns listed in the adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import { runSearch } from "../src/pipeline";
import { describeQuoteError, MAX_QUOTE_CALLS, MAX_QUOTE_OFFERS_PER_CALL, quotaSpecIsSafe, QuoteError, QUOTE_TIMEOUT_MS, quoteStatus, runQuotes, type QuoteQuery } from "../src/quotes";
import {
  createWegoSource,
  resetWegoTokenCache,
  WEGO_MAX_POLLS,
  WEGO_MAX_QUOTES_PER_SEARCH,
  WEGO_MAX_REQUESTS_PER_SEARCH,
  WEGO_QUOTA,
  WEGO_QUOTE_DEADLINE_MS,
  WEGO_REQUEST_TIMEOUT_MS,
  type WegoOptions,
} from "../src/sources/wego";
import type { FxRates, Offer, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const KEY = "CLIENT-ID-9f3a1c-SECRET";
const TOKEN = "tok_Abc123.def-456_GHI";
const SEARCH_ID = "88832cc42b47f3fdmsr";
const HOST = "https://affiliate-api.wego.com";
const TOKEN_URL = `${HOST}/apps/oauth/token`;
const SEARCH_URL = `${HOST}/metasearch/flights/searches`;
const RESULTS_URL = (offset: number) => `${SEARCH_URL}/${SEARCH_ID}/results?offset=${offset}&locale=en&currencyCode=USD`;
const Q: QuoteQuery = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", party: { adults: 1 } };
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5, AED: 0.8 } };

type Rec = Record<string, unknown>;

// --- fixtures (from the docs' shapes, not from a live call) -----------------------------------------------

const TOKEN_BODY = { access_token: TOKEN, token_type: "bearer", expires_in: 43199, created_at: 1782900000, scope: "affiliates" };
const CREATED_BODY = {
  search: { id: SEARCH_ID, cabin: "economy", adultsCount: 1, childrenCount: 0, infantsCount: 0, siteCode: "XX", currencyCode: "USD", locale: "en", legs: [], nearbyRoutes: [] },
  legs: [], trips: [], fares: [], airlines: [], airports: [], cities: [], providers: [], countries: [], currencies: [], tags: [], fareConditions: [], faresCount: 0, promosCount: 0, sponsors: [], count: 0,
};

const wLeg = (id: string, over: Rec = {}): Rec => ({
  id,
  departureDateTime: "2026-11-12T08:05:00+02:00",
  arrivalDateTime: "2026-11-12T11:20:00+01:00",
  durationMinutes: 255,
  departureAirportCode: "TLV",
  arrivalAirportCode: "BCN",
  airlineCodes: ["LY"],
  operatingAirlineCodes: ["LY"],
  stopoverAirportCodes: [],
  stopoversCount: 0,
  ...over,
});
const wBack = (id: string, over: Rec = {}): Rec =>
  wLeg(id, { departureDateTime: "2026-11-18T13:30:00+01:00", arrivalDateTime: "2026-11-18T18:45:00+02:00", departureAirportCode: "BCN", arrivalAirportCode: "TLV", durationMinutes: 255, ...over });
const wTrip = (id: string, legIds: string[]): Rec => ({ id, originalFlightId: id, code: id, legIds, normalizedFlight: id });
const wFare = (id: string, tripId: string, totalAmount: number, over: Rec = {}): Rec => ({
  id,
  tripId,
  providerCode: "kiwi.com",
  handoffUrl: `https://www.wego.com/handoff/${id}?x=1`,
  price: { currencyCode: "USD", totalAmount, totalAmountUsd: totalAmount, amount: totalAmount, originalAmount: totalAmount, amountUsd: totalAmount },
  refundable: false,
  exchangeable: false,
  remainingSeatsCount: 4,
  ...over,
});
const page = (count: number, parts: { legs?: Rec[]; trips?: Rec[]; fares?: Rec[] } = {}): Rec => ({
  legs: parts.legs ?? [], trips: parts.trips ?? [], fares: parts.fares ?? [], airlines: [], airports: [], providers: [{ code: "kiwi.com", name: "Kiwi.com", type: "ota" }], count,
});

/** Trip 1: nonstop both ways, 123.456 USD. */
const TRIP1 = { legs: [wLeg("L1"), wBack("L2")], trips: [wTrip("T1", ["L1", "L2"])], fares: [wFare("F1", "T1", 123.456)] };
/** Trip 2: one stop out, priced in AED (400 AED = 108.9 USD, so cheaper than trip 1 although its number is bigger). */
const TRIP2 = {
  legs: [wLeg("L3", { departureDateTime: "2026-11-12T14:00:00+02:00", arrivalDateTime: "2026-11-12T19:10:00+01:00", airlineCodes: ["W6", "LY", "W6"], stopoversCount: 1, stopoverAirportCodes: ["VIE"], durationMinutes: 430 }), wBack("L4", { departureDateTime: "2026-11-18T09:15:00+01:00" })],
  trips: [wTrip("T2", ["L3", "L4"])],
  fares: [wFare("F2", "T2", 400, { price: { currencyCode: "AED", totalAmount: 400, totalAmountUsd: 108.9 } })],
};
const DEFAULT_POLLS = [page(1, TRIP1), page(2, TRIP2), page(2)];

// --- a stub vendor ---------------------------------------------------------------------------------------

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const text = (body: string, status = 200) => () => new Response(body, { status });
type Make = () => Response;

interface Script {
  token?: Make | (() => never);
  create?: Make | (() => never);
  /** One answer per poll; the last one repeats. */
  polls?: Array<Make | (() => never)>;
}
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  init: RequestInit;
}

function vendor(script: Script = {}) {
  const calls: Call[] = [];
  let polled = 0;
  const fetchFn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === "string" ? init.body : undefined, init });
    if (url === TOKEN_URL) return (script.token ?? json(TOKEN_BODY))();
    if (url === SEARCH_URL) return (script.create ?? json(CREATED_BODY, 201))();
    if (url.startsWith(`${SEARCH_URL}/`)) {
      const polls = script.polls ?? DEFAULT_POLLS.map((p) => json(p));
      const make = polls[Math.min(polled, polls.length - 1)];
      polled += 1;
      if (!make) throw new Error("no poll scripted");
      return make();
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const urls = () => calls.map((c) => c.url);
  return { fetchFn, calls, urls };
}

const used = async (db: D1Database) => (await db.prepare("SELECT used FROM source_quota WHERE source = 'wego' AND period = 'lifetime'").bind().first<number>("used")) ?? 0;
const seed = (db: D1Database, n: number) => db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('wego', 'lifetime', ?, ?)").bind(n, NOW.toISOString()).run();

function world(script: Script = {}) {
  resetWegoTokenCache(); // the token cache lives as long as the isolate: every world starts without one
  const db = createTestD1();
  const repo = createRepo(db);
  const v = vendor(script);
  const slept: number[] = [];
  const make = (over: Partial<WegoOptions> = {}) =>
    createWegoSource({ apiKey: KEY, fetchFn: v.fetchFn as unknown as typeof fetch, repo, now: NOW, sleep: async (ms) => void slept.push(ms), ...over });
  return { db, repo, make, slept, ...v };
}

beforeEach(() => resetWegoTokenCache());
afterEach(() => vi.restoreAllMocks());

const quoteError = async (p: Promise<unknown>): Promise<QuoteError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(QuoteError);
  return err as QuoteError;
};

// ---------------------------------------------------------------------------------------------------------

describe("the quota of a vendor with no documented free allowance", () => {
  it("is a lifetime cap far below the only number the docs give (50 search calls per hour for a test key), and safe by the core's rule", () => {
    expect(WEGO_QUOTA.period).toBe("lifetime"); // a one-off trial key: it never renews
    expect(WEGO_QUOTA.allowance).toBe(50); // "50 calls per hour for a test key" (get-started): the stand-in for an undocumented count
    expect(WEGO_QUOTA.cap).toBeLessThan(WEGO_QUOTA.allowance);
    expect(WEGO_QUOTA.cap * 100).toBeLessThanOrEqual(WEGO_QUOTA.allowance * 80); // at most 80%
    expect(WEGO_QUOTA.cap).toBeLessThanOrEqual(50); // allowance unknown: never above 50
    expect(WEGO_QUOTA.cap).toBeGreaterThanOrEqual(1);
    expect(quotaSpecIsSafe(WEGO_QUOTA)).toBe(true);
    expect(Object.isFrozen(WEGO_QUOTA)).toBe(true);
    const source = world().make();
    expect(source.quota).toEqual(WEGO_QUOTA);
    expect(source.configured).toBe(true);
    expect(source.name).toBe("wego");
  });

  it("leaves room in the Free plan's 50 subrequests (Travelpayouts 30 + FX 2) and takes one quote per search", () => {
    expect(WEGO_MAX_QUOTES_PER_SEARCH).toBe(1);
    expect(WEGO_MAX_REQUESTS_PER_SEARCH).toBe(1 + WEGO_MAX_QUOTES_PER_SEARCH * (1 + WEGO_MAX_POLLS));
    expect(WEGO_MAX_REQUESTS_PER_SEARCH).toBeLessThanOrEqual(MAX_QUOTE_CALLS / 2); // half of the calls all extra sources share
    expect(30 + 2 + WEGO_MAX_REQUESTS_PER_SEARCH).toBeLessThanOrEqual(50);
    expect(WEGO_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(WEGO_QUOTE_DEADLINE_MS);
    expect(WEGO_QUOTE_DEADLINE_MS).toBeLessThanOrEqual(QUOTE_TIMEOUT_MS);
  });
});

describe("configured", () => {
  it("is false without a key (missing, empty, blank): never called, never counted, nothing written", async () => {
    for (const apiKey of [undefined, "", "  \n"]) {
      const { db, make, fetchFn } = world();
      const source = make({ apiKey });
      expect(source.configured).toBe(false);
      const err = await quoteError(source.quote(Q));
      expect(err.code).toBe("not_configured");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(source.callCount()).toBe(0);
      expect((await db.prepare("SELECT * FROM source_quota").all()).results).toEqual([]);
    }
  });
});

describe("mapping of a normal response", () => {
  it("reads price, currency, legs and Wego's own booking link; the cheapest trip first, in the fare's own currency", async () => {
    const { make } = world();
    const offers = await make().quote(Q);
    const shared = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", source: "wego", ticketStructure: "roundtrip", includes: {}, verifyLink: null, checkedAt: NOW.toISOString(), extrasAmountIls: 0, totalIls: null, tags: [] };
    expect(offers).toEqual([
      {
        ...shared,
        priceAmount: 400, // the AED fare is 108.9 USD: cheaper than the USD fare, ranked by the USD value, priced in its own currency
        priceCurrency: "AED",
        outbound: { departTime: "14:00", arriveTime: "19:10", stops: 1, durationMin: 430, airlines: ["W6", "LY"] },
        inbound: { departTime: "09:15", arriveTime: "18:45", stops: 0, durationMin: 255, airlines: ["LY"] },
        deeplink: "https://www.wego.com/handoff/F2?x=1",
      },
      {
        ...shared,
        priceAmount: 123.46, // 123.456 rounded to cents
        priceCurrency: "USD",
        outbound: { departTime: "08:05", arriveTime: "11:20", stops: 0, durationMin: 255, airlines: ["LY"] },
        inbound: { departTime: "13:30", arriveTime: "18:45", stops: 0, durationMin: 255, airlines: ["LY"] },
        deeplink: "https://www.wego.com/handoff/F1?x=1",
      },
    ]);
  });

  it("asks for ONE adult, so the price is per adult like every other raw offer", async () => {
    const { make, calls } = world();
    await make().quote({ ...Q, party: { adults: 3, children: 1, infants: 1 } });
    const create = calls.find((c) => c.url === SEARCH_URL);
    const search = (JSON.parse(create?.body ?? "{}") as { search: Rec }).search;
    expect([search.adultsCount, search.childrenCount, search.infantsCount]).toEqual([1, 0, 0]);
  });

  it("keeps the cheapest fare per trip across polls, merging the delta objects by id", async () => {
    const dearer = wFare("F1", "T1", 150);
    const cheaper = wFare("F1b", "T1", 99.5);
    const { make } = world({ polls: [json(page(1, { ...TRIP1, fares: [dearer] })), json(page(2, { fares: [cheaper] })), json(page(2))] }); // legs and trip arrive only once
    const offers = await make().quote(Q);
    expect(offers.map((o) => o.priceAmount)).toEqual([99.5]);
    expect(offers[0]?.deeplink).toBe("https://www.wego.com/handoff/F1b?x=1");
  });

  it("returns at most MAX_QUOTE_OFFERS_PER_CALL trips", async () => {
    const trips = Array.from({ length: 30 }, (_, i) => ({ legs: [wLeg(`A${i}`), wBack(`B${i}`)], trip: wTrip(`T${i}`, [`A${i}`, `B${i}`]), fare: wFare(`F${i}`, `T${i}`, 100 + i) }));
    const { make } = world({ polls: [json(page(30, { legs: trips.flatMap((t) => t.legs), trips: trips.map((t) => t.trip), fares: trips.map((t) => t.fare) }))] });
    const offers = await make().quote(Q);
    expect(offers).toHaveLength(MAX_QUOTE_OFFERS_PER_CALL);
    expect(offers.map((o) => o.priceAmount)).toEqual(Array.from({ length: MAX_QUOTE_OFFERS_PER_CALL }, (_, i) => 100 + i));
  });

  it("leaves what the docs do not give as null (or empty): no departure time, stops, duration, airlines, link", async () => {
    const bare = page(1, {
      legs: [
        { id: "L1", departureAirportCode: "TLV", arrivalAirportCode: "BCN" },
        { id: "L2", departureAirportCode: "BCN", arrivalAirportCode: "TLV" },
      ],
      trips: [wTrip("T1", ["L1", "L2"])],
      fares: [{ id: "F1", tripId: "T1", price: { currencyCode: "eur", totalAmount: 88 } }],
    });
    const { make } = world({ polls: [json(bare)] });
    const offers = await make().quote(Q);
    const none = { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: [] };
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ priceAmount: 88, priceCurrency: "EUR", outbound: none, inbound: none, deeplink: null, verifyLink: null, includes: {} });
  });

  it("does not turn a UTC or offset-less timestamp into a local departure time, and never trusts a non-https link", async () => {
    const utc = [wLeg("L1", { departureDateTime: "2026-11-12T06:05:00Z", arrivalDateTime: "2026-11-12T10:20:00" }), wBack("L2")];
    for (const handoffUrl of ["javascript:alert(1)", "http://www.wego.com/x", "https://user:pw@www.wego.com/x", "//www.wego.com/x", "not a url", 5, null, `https://www.wego.com/${"a".repeat(3000)}`]) {
      const { make } = world({ polls: [json(page(1, { legs: utc, trips: [wTrip("T1", ["L1", "L2"])], fares: [wFare("F1", "T1", 100, { handoffUrl })] }))] });
      const [offer] = await make().quote(Q);
      expect(offer?.outbound.departTime, String(handoffUrl)).toBeNull();
      expect(offer?.outbound.arriveTime).toBeNull();
      expect(offer?.inbound.departTime).toBe("13:30");
      expect(offer?.deeplink, String(handoffUrl)).toBeNull();
    }
  });

  it("drops fares it cannot trust: no readable price, a bad currency, a trip that is not two known legs, other dates or airports", async () => {
    const good = { legs: [wLeg("L1"), wBack("L2")], trips: [wTrip("T1", ["L1", "L2"])], fares: [wFare("F1", "T1", 100)] };
    const price = (over: Rec) => ({ currencyCode: "USD", totalAmount: 50, ...over });
    const badFares: Rec[] = [
      wFare("P1", "T1", 50, { price: undefined }),
      wFare("P2", "T1", 50, { price: price({ totalAmount: 0 }) }),
      wFare("P3", "T1", 50, { price: price({ totalAmount: -5 }) }),
      wFare("P4", "T1", 50, { price: price({ totalAmount: "50" }) }),
      wFare("P5", "T1", 50, { price: price({ currencyCode: "US" }) }),
      wFare("P6", "T1", 50, { price: price({ currencyCode: "US1" }) }),
      wFare("P7", "T1", 50, { price: price({ currencyCode: null }) }),
      wFare("P8", "GHOST", 50), // trip not in the response
      wFare("P9", "T3", 50), // one leg only
      wFare("P10", "T4", 50), // three legs
      wFare("P11", "T5", 50), // return leg on other dates
      wFare("P12", "T6", 50), // other airport
      wFare("P13", "T7", 50), // outbound on other dates
      { id: "", tripId: "T1", price: price({}) }, // no id
    ];
    const more = {
      legs: [wLeg("L5"), wLeg("L6"), wLeg("L7"), wBack("L8", { departureDateTime: "2026-11-19T13:30:00+01:00" }), wBack("L9", { arrivalAirportCode: "SDV" }), wLeg("L10", { departureDateTime: "2026-11-13T08:05:00+02:00" })],
      trips: [wTrip("T3", ["L1"]), wTrip("T4", ["L1", "L2", "L5"]), wTrip("T5", ["L1", "L8"]), wTrip("T6", ["L1", "L9"]), wTrip("T7", ["L10", "L2"])],
    };
    const { make } = world({ polls: [json(page(20, { legs: [...good.legs, ...more.legs], trips: [...good.trips, ...more.trips], fares: [...badFares, ...good.fares] }))] });
    const offers = await make().quote(Q);
    expect(offers.map((o) => o.priceAmount)).toEqual([100]);
  });
});

describe("what goes out", () => {
  it("asks the token endpoint as documented: POST, JSON body with the client id only, no Authorization, key in no URL", async () => {
    const { make, calls } = world();
    await make().quote(Q);
    const token = calls[0];
    expect(token).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(token?.headers).toMatchObject({ "Content-Type": "application/json", "X-Wego-Version": "1" });
    expect(token?.headers.Authorization).toBeUndefined();
    expect(JSON.parse(token?.body ?? "")).toEqual({ client_id: KEY, grant_type: "client_credentials", scope: "affiliate" });
  });

  it("creates the search as documented: a round trip of exactly two legs, the second inverted and dated with the return date", async () => {
    const { make, calls } = world();
    await make().quote(Q);
    const create = calls[1];
    expect(create).toMatchObject({ url: SEARCH_URL, method: "POST" });
    expect(create?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(create?.body ?? "")).toEqual({
      search: {
        adultsCount: 1, childrenCount: 0, infantsCount: 0, cabin: "economy", currencyCode: "USD", locale: "en", siteCode: "XX", deviceType: "DESKTOP", appType: "WEB_APP",
        userLoggedIn: false, clientCreatedAt: NOW.toISOString(), shopcashClickId: "", showWegoFares: false, showWegoFaresOnly: false,
        legs: [
          { outboundDate: "2026-11-12", departureAirportCode: "TLV", arrivalAirportCode: "BCN" },
          { outboundDate: "2026-11-18", departureAirportCode: "BCN", arrivalAirportCode: "TLV" },
        ],
      },
    });
  });

  it("polls with the previous count as the offset, after the guide's waits, and never puts a key or a token in a URL", async () => {
    const { make, calls, slept, urls } = world();
    await make().quote(Q);
    expect(urls()).toEqual([TOKEN_URL, SEARCH_URL, RESULTS_URL(0), RESULTS_URL(1), RESULTS_URL(2)]);
    expect(slept).toEqual([500, 1000, 1500]);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(c.url).not.toContain(TOKEN);
      expect(c.method).toBe(c.url === RESULTS_URL(0) || c.url === RESULTS_URL(1) || c.url === RESULTS_URL(2) ? "GET" : "POST");
      expect(JSON.stringify(c.headers)).not.toContain(KEY); // the client id is only in the token request's body
      if (c.url !== TOKEN_URL) expect(c.body ?? "").not.toContain(KEY);
      expect(c.init.redirect).toBe("manual"); // a redirect is never followed with a credential attached
    }
  });

  it("stops polling once the count stopped growing and fares are in hand", async () => {
    const { make, urls } = world({ polls: [json(page(1, TRIP1)), json(page(1)), json(page(9, TRIP2))] });
    const offers = await make().quote(Q);
    expect(urls()).toEqual([TOKEN_URL, SEARCH_URL, RESULTS_URL(0), RESULTS_URL(1)]);
    expect(offers).toHaveLength(1);
  });

  it("never polls more than WEGO_MAX_POLLS times, whatever the vendor keeps sending", async () => {
    let n = 0;
    const endless = () => {
      n += 1;
      return new Response(JSON.stringify(page(n, { legs: [wLeg(`A${n}`), wBack(`B${n}`)], trips: [wTrip(`T${n}`, [`A${n}`, `B${n}`])], fares: [wFare(`F${n}`, `T${n}`, 500 - n)] })), { status: 200 });
    };
    const { make, fetchFn } = world({ polls: [endless] });
    const source = make();
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(WEGO_MAX_POLLS);
    expect(fetchFn).toHaveBeenCalledTimes(WEGO_MAX_REQUESTS_PER_SEARCH);
    expect(source.callCount()).toBe(WEGO_MAX_REQUESTS_PER_SEARCH);
  });

  it("stops polling when the deadline is near instead of overrunning it, and hands only the time that is left to a request", async () => {
    let t = 1_000_000;
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => real(ms));
    const { make, fetchFn } = world({ polls: [json(page(1, TRIP1))] });
    const slow = vi.fn(async (input: unknown, init?: RequestInit) => {
      t += 1_800; // every vendor answer takes 1.8 s
      return fetchFn(input, init);
    });
    const source = make({ fetchFn: slow as unknown as typeof fetch, clock: () => t, sleep: async (ms) => void (t += ms) });
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(1); // the one poll that fitted delivered
    expect(slow).toHaveBeenCalledTimes(3); // token, creation, one poll: the second poll would not fit
    const asked = spy.mock.calls.map((c) => c[0]);
    expect(asked.every((ms) => ms >= 1 && ms <= WEGO_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(asked.at(-1)).toBeLessThan(WEGO_REQUEST_TIMEOUT_MS); // what was left of the deadline, not the full request timeout
  });
});

describe("an empty or unreadable answer is [], not an error", () => {
  it("a search that found nothing", async () => {
    const { make, fetchFn } = world({ polls: [json(page(0))] });
    await expect(make().quote(Q)).resolves.toEqual([]);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(WEGO_MAX_REQUESTS_PER_SEARCH);
  });

  it("a poll of an unexpected shape", async () => {
    const shapes: unknown[] = [[], null, "hello", 42, {}, { count: "many" }, { count: 1, fares: "no", trips: {}, legs: 3 }, { count: 1, fares: [null, 7, "x", []] }, page(1, { fares: [wFare("F1", "T1", 10)] })];
    for (const shape of shapes) {
      const { make } = world({ polls: [json(shape)] });
      await expect(make().quote(Q), JSON.stringify(shape)).resolves.toEqual([]);
    }
    const { make } = world({ polls: [text("<html>maintenance</html>")] });
    await expect(make().quote(Q)).resolves.toEqual([]);
  });

  it("a page larger than the reader accepts is not parsed", async () => {
    const { make } = world({ polls: [text(JSON.stringify({ count: 1, pad: "x".repeat(600_000), ...TRIP1 }))] });
    await expect(make().quote(Q)).resolves.toEqual([]);
  });

  it("a creation answer without a usable search id ends the quote there: no poll is built from it", async () => {
    const bodies: Array<Make> = [
      json([], 201), json(null, 201), json({}, 201), json({ search: null }, 201), json({ search: { id: 5 } }, 201), json({ search: { id: "" } }, 201),
      json({ search: { id: "../../evil?x=1#" } }, 201), json({ search: { id: "a/b" } }, 201), json({ search: { id: "a".repeat(200) } }, 201), text("<html>", 201),
    ];
    for (const create of bodies) {
      const { make, urls } = world({ create });
      await expect(make().quote(Q)).resolves.toEqual([]);
      expect(urls()).toEqual([TOKEN_URL, SEARCH_URL]);
    }
  });

  it("a token answer that cannot be used ends the quote before the search is created", async () => {
    const bodies: Array<Make> = [
      json({}), json([]), json({ access_token: 5 }), json({ access_token: "" }), json({ access_token: "has space" }), json({ access_token: "line\nbreak" }), json({ access_token: "x".repeat(5000) }), text("nope"),
    ];
    for (const token of bodies) {
      const { make, urls } = world({ token });
      await expect(make().quote(Q)).resolves.toEqual([]);
      expect(urls()).toEqual([TOKEN_URL]);
    }
  });

  it("a query it cannot send costs nothing: no unit, no request", async () => {
    const { db, make, fetchFn } = world();
    const source = make();
    const bad: QuoteQuery[] = [
      { ...Q, origin: "TELAVIV" }, { ...Q, destination: "" }, { ...Q, origin: "T1" }, { ...Q, departDate: "2026-13-01" }, { ...Q, departDate: "12/11/2026" },
      { ...Q, returnDate: "2026-02-30" }, { ...Q, returnDate: "2026-11-11" },
    ];
    for (const q of bad) await expect(source.quote(q), JSON.stringify(q)).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await used(db)).toBe(0);
    // ...and it did not use up the one quote this search may make
    await expect(source.quote(Q)).resolves.toHaveLength(2);
  });
});

describe("failures are reported as errors, never retried, and the unit is spent", () => {
  it("HTTP 401, 429 and 500 at the token, the creation and a poll", async () => {
    for (const status of [401, 429, 500]) {
      const stages: Array<[string, Script, number]> = [
        ["token", { token: text("denied", status) }, 1],
        ["creation", { create: text("denied", status) }, 2],
        ["poll", { polls: [text("denied", status)] }, 3],
      ];
      for (const [stage, script, expectedCalls] of stages) {
        const { db, make, fetchFn } = world(script);
        const source = make();
        const err = await quoteError(source.quote(Q));
        expect([stage, err.code, err.status]).toEqual([stage, "http", status]);
        expect(fetchFn, `${stage} ${status}`).toHaveBeenCalledTimes(expectedCalls); // no retry
        expect(source.callCount()).toBe(expectedCalls);
        expect(await used(db), `${stage} ${status}`).toBe(1); // a failed quote still used its unit
      }
    }
  });

  it("a redirect is an HTTP error, not followed", async () => {
    const { make, fetchFn } = world({ create: () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }) });
    const err = await quoteError(make().quote(Q));
    expect([err.code, err.status]).toEqual(["http", 302]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a timeout, a network failure and a failing body read", async () => {
    const timeout = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const offline = () => {
      throw new TypeError("fetch failed");
    };
    const cases: Array<[string, Script, string]> = [
      ["timeout at the token", { token: timeout }, "timeout"],
      ["timeout at the creation", { create: timeout }, "timeout"],
      ["timeout at a poll", { polls: [timeout] }, "timeout"],
      ["network at the token", { token: offline }, "network"],
      ["network at the creation", { create: offline }, "network"],
      ["network at a poll", { polls: [offline] }, "network"],
      ["body read fails", { create: () => ({ status: 201, text: () => Promise.reject(new TypeError("stream broke")) }) as unknown as Response }, "network"],
    ];
    for (const [label, script, code] of cases) {
      const { db, make } = world(script);
      const err = await quoteError(make().quote(Q));
      expect([label, err.code, err.status]).toEqual([label, code, null]);
      expect(await used(db), label).toBe(1);
    }
  });

  it("a vendor that never answers is cut off by AbortSignal.timeout on every request", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(25));
    const untilAborted = <T>(signal?: AbortSignal | null) => new Promise<T>((_ok, fail) => signal?.addEventListener("abort", () => fail(signal.reason)));
    const stalls: Record<string, (init?: RequestInit) => Promise<Response>> = {
      "no headers": (init) => untilAborted<Response>(init?.signal),
      "no body": async (init) => ({ status: 200, text: () => untilAborted<string>(init?.signal) }) as unknown as Response,
    };
    for (const [label, stall] of Object.entries(stalls)) {
      const { make } = world();
      const source = make({ fetchFn: vi.fn(async (_url: unknown, init?: RequestInit) => stall(init)) as unknown as typeof fetch });
      const err = await quoteError(source.quote(Q));
      expect([label, err.code]).toEqual([label, "timeout"]);
      expect(source.callCount()).toBe(1); // nothing after the request that timed out
    }
    expect(spy).toHaveBeenCalled();
  });

  it("every request carries an abort signal that is armed and not yet fired, of at most the request timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { make, calls } = world();
    await make().quote(Q);
    expect(calls.length).toBe(WEGO_MAX_REQUESTS_PER_SEARCH);
    expect(spy).toHaveBeenCalledTimes(calls.length);
    for (const c of calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(c.init.signal?.aborted).toBe(false);
    }
    for (const [ms] of spy.mock.calls) expect(ms).toBeLessThanOrEqual(WEGO_REQUEST_TIMEOUT_MS);
  });

  it("a failing poll after fares arrived only ends the wait: the live prices in hand are returned", async () => {
    for (const bad of [text("boom", 500), text("slow down", 429), () => { throw new TypeError("fetch failed"); }]) {
      const { make } = world({ polls: [json(page(1, TRIP1)), bad] });
      const offers = await make().quote(Q);
      expect(offers.map((o) => o.priceAmount)).toEqual([123.46]);
    }
  });
});

describe("the key never appears in an error, a URL, a log line or a header", () => {
  it("errors are a bare code, even when the vendor echoes the key and the token back in its answer", async () => {
    const echo = { error: "invalid_client", error_description: `client ${KEY} unknown, token ${TOKEN}`, access_token: TOKEN };
    const timeout = () => {
      throw new DOMException(`aborted ${KEY}`, "TimeoutError");
    };
    const offline = () => {
      throw new TypeError(`fetch failed for ${KEY} ${TOKEN}`);
    };
    const scripts: Script[] = [
      { token: json(echo, 401) }, { token: json(echo, 400) }, { create: json(echo, 422) }, { create: json(echo, 429) }, { polls: [json(echo, 500)] },
      { token: timeout }, { create: offline }, { polls: [offline] },
    ];
    const log = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    for (const script of scripts) {
      const { make } = world(script);
      const source = make();
      const err = await quoteError(source.quote(Q));
      for (const shown of [err.message, String(err), JSON.stringify(err), err.stack ?? "", err.name, describeQuoteError(source, err)]) {
        expect(shown).not.toContain(KEY);
        expect(shown).not.toContain(TOKEN);
        expect(shown).not.toContain("invalid_client"); // and nothing of the vendor's body
      }
      expect(err.message).toBe(err.code);
    }
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });
});

describe("quota: reserved before the request, refused at the cap, closed on any doubt", () => {
  it("the counter already reads 1 when the very first vendor request (the token) goes out", async () => {
    const { db, make } = world();
    let seen = -1;
    const source = make({
      fetchFn: vi.fn(async (input: unknown) => {
        if (seen < 0) seen = await used(db);
        return new Response(JSON.stringify(String(input) === TOKEN_URL ? TOKEN_BODY : String(input) === SEARCH_URL ? CREATED_BODY : page(0)), { status: String(input) === SEARCH_URL ? 201 : 200 });
      }) as unknown as typeof fetch,
    });
    expect(source.callCount()).toBe(0);
    await source.quote(Q);
    expect(seen).toBe(1);
    expect(await used(db)).toBe(1); // one unit for the whole quote (token, creation and polls)
  });

  it("a quote that ends in an error before the search was even created has still used its unit", async () => {
    const { db, make } = world({ token: text("no", 401) });
    await quoteError(make().quote(Q));
    expect(await used(db)).toBe(1);
  });

  it("a source at its cap is never called", async () => {
    const { db, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap);
    const source = make();
    expect((await quoteError(source.quote(Q))).code).toBe("quota_exhausted");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(source.callCount()).toBe(0);
    expect(await used(db)).toBe(WEGO_QUOTA.cap); // the counter did not move
  });

  it("the last unit before the cap is used once; the next search finds the source exhausted (counter shared through the database)", async () => {
    const { db, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap - 1);
    await expect(make().quote(Q)).resolves.toHaveLength(2);
    const callsAfterLast = fetchFn.mock.calls.length;
    for (let i = 0; i < 3; i++) expect((await quoteError(make().quote(Q))).code).toBe("quota_exhausted");
    expect(fetchFn.mock.calls.length).toBe(callsAfterLast);
    expect(await used(db)).toBe(WEGO_QUOTA.cap);
  });

  it("the cap holds under concurrency: many searches at once, exactly the free units reach the vendor", async () => {
    const { db, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap - 3);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => make().quote(Q)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "quota_exhausted" });
    expect(await used(db)).toBe(WEGO_QUOTA.cap);
    const creations = fetchFn.mock.calls.filter((c) => String(c[0]) === SEARCH_URL).length;
    expect(creations).toBe(3); // the metered call went out exactly once per reserved unit
  });

  it("fails closed: a missing table, a database error or a refused reservation means the vendor is NOT called", async () => {
    const noTable = createTestD1();
    await noTable.prepare("DROP TABLE source_quota").run();
    const repos: Array<[string, WegoOptions["repo"]]> = [
      ["missing table", createRepo(noTable)],
      ["rejecting repo", { reserveQuota: async () => { throw new Error("D1 down"); } } as unknown as WegoOptions["repo"]],
      ["throwing repo", { reserveQuota: () => { throw new Error("D1 down"); } } as unknown as WegoOptions["repo"]],
      ["refusing repo", { reserveQuota: async () => false } as unknown as WegoOptions["repo"]],
      ["odd answer", { reserveQuota: async () => 1 } as unknown as WegoOptions["repo"]],
      ["no answer", { reserveQuota: async () => undefined } as unknown as WegoOptions["repo"]],
      ["throwing D1", createRepo({ prepare: () => { throw new Error("D1_ERROR"); } } as unknown as D1Database)],
    ];
    for (const [label, repo] of repos) {
      const { make, fetchFn } = world();
      const source = make({ repo });
      expect((await quoteError(source.quote(Q))).code, label).toBe("quota_exhausted");
      expect(fetchFn, label).not.toHaveBeenCalled();
      expect(source.callCount(), label).toBe(0);
    }
  });

  it("a clock that cannot name a time means no request and no unit", async () => {
    const { db, make, fetchFn } = world();
    await expect(make({ now: new Date(Number.NaN) }).quote(Q)).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await used(db)).toBe(0);
  });

  it("counts under its own name, once per quote", async () => {
    const { db, make } = world();
    await make().quote(Q);
    expect((await db.prepare("SELECT source, period, used FROM source_quota").all()).results).toEqual([{ source: "wego", period: "lifetime", used: 1 }]);
  });
});

describe("one quote per search", () => {
  it("of several date pairs asked at once only the first goes out; the others get [] without a unit or a request", async () => {
    const { db, make, fetchFn } = world();
    const source = make();
    const pairs: Array<[string, string]> = [["2026-11-12", "2026-11-18"], ["2026-11-13", "2026-11-19"], ["2026-11-14", "2026-11-20"], ["2026-11-15", "2026-11-21"]];
    const results = await Promise.all(pairs.map(([departDate, returnDate]) => source.quote({ ...Q, departDate, returnDate })));
    expect(results.map((r) => r.length)).toEqual([2, 0, 0, 0]);
    expect(await used(db)).toBe(1);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(WEGO_MAX_REQUESTS_PER_SEARCH);
    expect(source.callCount()).toBe(fetchFn.mock.calls.length);
    const asked = (JSON.parse(String(fetchFn.mock.calls.find((c) => String(c[0]) === SEARCH_URL)?.[1]?.body)) as { search: { legs: Array<{ outboundDate: string }> } }).search.legs;
    expect(asked.map((l) => l.outboundDate)).toEqual(["2026-11-12", "2026-11-18"]); // the first pair = the cheapest one, the pipeline queues it first
  });
});

describe("the bearer token", () => {
  it("is reused by the next search instead of asking again, and sent as a Bearer header", async () => {
    const { make, urls, calls } = world();
    await make().quote(Q);
    await make().quote(Q);
    expect(urls().filter((u) => u === TOKEN_URL)).toHaveLength(1);
    const creations = calls.filter((c) => c.url === SEARCH_URL);
    expect(creations).toHaveLength(2);
    for (const c of creations) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("is asked again once it is (nearly) expired, and for another client id", async () => {
    let t = 5_000_000;
    const { make, urls } = world();
    await make({ clock: () => t }).quote(Q);
    t += 43_199_000 - 600_000 - 1_000; // still inside expires_in minus the margin
    await make({ clock: () => t }).quote(Q);
    expect(urls().filter((u) => u === TOKEN_URL)).toHaveLength(1);
    t += 2_000;
    await make({ clock: () => t }).quote(Q);
    expect(urls().filter((u) => u === TOKEN_URL)).toHaveLength(2);
    await make({ clock: () => t, apiKey: "ANOTHER-CLIENT-ID" }).quote(Q);
    expect(urls().filter((u) => u === TOKEN_URL)).toHaveLength(3);
  });

  it("is not cached when the vendor states no usable lifetime", async () => {
    for (const expires of [undefined, 0, -5, 300, "43200"]) {
      resetWegoTokenCache();
      const { make, urls } = world({ token: json({ ...TOKEN_BODY, expires_in: expires }) });
      await make().quote(Q);
      await make().quote(Q);
      expect(urls().filter((u) => u === TOKEN_URL), String(expires)).toHaveLength(2);
    }
  });

  it("is dropped when the vendor rejects it (401), so the next search asks for a new one; the rejected quote is not retried", async () => {
    const script: Script = {};
    const { make, urls } = world(script);
    const tokenRequests = () => urls().filter((u) => u === TOKEN_URL).length;
    await make().quote(Q);
    expect(tokenRequests()).toBe(1);
    script.create = text("expired", 401);
    const before = urls().length;
    const err = await quoteError(make().quote(Q));
    expect(err.status).toBe(401);
    expect(urls().slice(before)).toEqual([SEARCH_URL]); // the cached token was used: no token request, and no second attempt
    delete script.create;
    await make().quote(Q);
    expect(tokenRequests()).toBe(2);
  });
});

describe("in the pipeline (quotes.ts contract)", () => {
  it("runQuotes: gets the first pair's offers per ADULT in the vendor's currency, asks one pair only, and reports stats without a failure", async () => {
    const { make } = world();
    const source = make();
    const dates: Array<[string, string]> = [["2026-11-12", "2026-11-18"], ["2026-11-13", "2026-11-19"]];
    const run = await runQuotes([source], { origin: "TLV", dest: "BCN" }, dates, { adults: 2 });
    expect(run.offers.map((o) => [o.source, o.priceAmount, o.priceCurrency, o.departDate])).toEqual([["wego", 400, "AED", "2026-11-12"], ["wego", 123.46, "USD", "2026-11-12"]]);
    const stat = run.stats.get("wego");
    expect(stat).toMatchObject({ succeeded: 2, offers: 2, failures: [], notes: [] });
    expect(stat?.calls).toBe(source.callCount());
    expect(stat?.calls).toBeLessThanOrEqual(WEGO_MAX_REQUESTS_PER_SEARCH);
  });

  it("runQuotes: says how many requests its next quote may spend, so the phase counts requests and not quotes", async () => {
    const { make } = world();
    const source = make();
    expect(source.nextQuoteRequests?.()).toBe(WEGO_MAX_REQUESTS_PER_SEARCH);
    await source.quote(Q);
    expect(source.nextQuoteRequests?.()).toBe(0); // the one quote of this search is taken: later pairs cost nothing
    expect(WEGO_MAX_REQUESTS_PER_SEARCH).toBeLessThanOrEqual(MAX_QUOTE_CALLS);
  });

  it("runQuotes: four pairs and a spent quota is one refusal with a note: not ok, no request, and the slots are given back", async () => {
    const { db, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap);
    const dates: Array<[string, string]> = [["2026-11-12", "2026-11-18"], ["2026-11-13", "2026-11-19"], ["2026-11-14", "2026-11-20"], ["2026-11-15", "2026-11-21"]];
    const source = make();
    const run = await runQuotes([source], { origin: "TLV", dest: "BCN" }, dates, { adults: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(run.stats.get("wego")).toMatchObject({ calls: 0, offers: 0, notes: ["Wego: free quota used up (lifetime)"] });
    expect(quoteStatus(source, run.stats.get("wego"), 0)).toMatchObject({ name: "wego", enabled: true, ok: false, calls: 0, offers: 0, error: "Wego: free quota used up (lifetime)" });
  });

  it("runQuotes: a source out of quota is stopped with a note, no request", async () => {
    const { db, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap);
    const run = await runQuotes([make()], { origin: "TLV", dest: "BCN" }, [["2026-11-12", "2026-11-18"]], { adults: 1 });
    expect(run.offers).toEqual([]);
    expect(run.stats.get("wego")?.notes).toEqual(["Wego: free quota used up (lifetime)"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  const request: SearchRequest = {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7, adults: 2, children: 0, infants: 0,
    cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
  };
  const tpOffer: Offer = {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: 100, priceCurrency: "USD", source: "travelpayouts", ticketStructure: "roundtrip",
    outbound: { departTime: "08:05", arriveTime: null, stops: 0, durationMin: 255, airlines: ["LY"] }, inbound: { departTime: "13:30", arriveTime: null, stops: 0, durationMin: 255, airlines: ["LY"] },
    includes: {}, deeplink: "https://www.aviasales.com/search/TLV1211BCN18111?marker=m", verifyLink: null, checkedAt: NOW.toISOString(), extrasAmountIls: 0, totalIls: null, tags: [],
  };
  const tp = (): TravelpayoutsClient => ({
    configured: true,
    callCount: () => 0,
    roundTrips: async (o, d) => (o === "TLV" && d === "BCN" ? [structuredClone(tpOffer)] : []),
    oneWays: async () => [],
  });

  it("runSearch: the live fare confirms and replaces the cached one, keeps Wego's own link, is scaled to the party and shows in meta.sources", async () => {
    const { repo, make } = world({ polls: [json(page(1, { legs: [wLeg("L1"), wBack("L2")], trips: [wTrip("T1", ["L1", "L2"])], fares: [wFare("F1", "T1", 90)] }))] });
    const source = make();
    const res = await runSearch({ repo, tp: tp(), fx: async () => FX, now: NOW, quoteSources: [source] }, request);
    const top = res.cards[0];
    expect(top?.offer).toMatchObject({ source: "wego", priceAmount: 180, priceCurrency: "USD", deeplink: "https://www.wego.com/handoff/F1?x=1" }); // 90 per adult x 2
    expect(res.cards.some((c) => c.offer.source === "travelpayouts")).toBe(false); // the stale cached fare of the same flight is gone
    const status = res.meta.sources.find((s) => s.name === "wego");
    expect(status).toMatchObject({ name: "wego", enabled: true, ok: true, offers: 1, error: null });
    expect(status?.calls).toBe(source.callCount());
  });

  it("runSearch: with the free quota used up the search still answers, from Travelpayouts, and Wego is not called", async () => {
    const { db, repo, make, fetchFn } = world();
    await seed(db, WEGO_QUOTA.cap);
    const res = await runSearch({ repo, tp: tp(), fx: async () => FX, now: NOW, quoteSources: [make()] }, request);
    expect(res.cards[0]?.offer.source).toBe("travelpayouts");
    expect(res.meta.sources.find((s) => s.name === "wego")).toMatchObject({ enabled: true, ok: false, calls: 0, offers: 0, error: "Wego: free quota used up (lifetime)" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("runSearch: without a key Wego is not configured, so it is neither called nor listed", async () => {
    const { repo, make, fetchFn } = world();
    const res = await runSearch({ repo, tp: tp(), fx: async () => FX, now: NOW, quoteSources: [make({ apiKey: undefined })] }, request);
    expect(res.meta.sources.map((s) => s.name)).toEqual(["travelpayouts", "google_flights"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
