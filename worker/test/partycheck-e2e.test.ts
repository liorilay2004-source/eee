/**
 * POST /api/party-check and the search's party-check fields end to end: real Requests into worker.fetch, the D1 shim behind
 * it, global fetch stubbed (every outbound call is counted and none leaves the machine). The Date is frozen.
 * With today's vendors nothing qualifies for the live check (see partycheck.ts), so the endpoint answers 404 even with every
 * live key set, and never calls anybody. The last block SIMULATES a vendor that qualifies (Ignav's pricing flipped in memory for
 * those tests only, restored after each) to run the whole production wiring: search, card token, check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import * as entry from "../src/index";
import { PARTY_CHECK_RATE_LIMIT_MAX } from "../src/partycheck";
import { ignavAdapter } from "../src/sources/ignav";
import { MAX_BODY_BYTES } from "../src/validate";
import type { Env, PartyCheckLinks, PartyCheckResult, SearchResponse } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const BASE = "https://api.example.test";
const ORIGIN = "https://app.example.test";
const IP = "203.0.113.9";
const CHECK = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", adults: 2 };
const SEARCH = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };
const ALL_KEYS = { IGNAV_API_KEY: "ig-key", WEGO_API_TOKEN: "wego-client", SEARCHAPI_KEY: "sa-key", SERPAPI_KEY: "serp-key" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `oneWays: false`: Travelpayouts has no one-way fares, so no split ticket is built and the cards are round trips. */
function stubUpstream(opts: { oneWays?: boolean } = {}) {
  const hosts: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.hostname);
    if (url.hostname === "api.travelpayouts.com") {
      if (url.searchParams.get("one_way") === "true") {
        const body = structuredClone(onewayFixture) as { data: { origin: string }[] };
        body.data = opts.oneWays === false ? [] : body.data.filter((d) => d.origin === url.searchParams.get("origin"));
        return json(body);
      }
      return json(roundtripFixture);
    }
    if (url.hostname === "boi.org.il") return json({ exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }, { key: "EUR", currentExchangeRate: 3.9, unit: 1 }] });
    // Any live vendor: answers, so that a call WOULD succeed if it were made. The tests assert that none is made.
    return json({ ok: true });
  });
  vi.stubGlobal("fetch", fn);
  const vendorHosts = () => hosts.filter((h) => h !== "api.travelpayouts.com" && h !== "boi.org.il" && h !== "open.er-api.com" && h !== "www.ecb.europa.eu");
  return { fn, hosts, vendorHosts };
}

const makeEnv = (over: Partial<Env> = {}): Env => ({ DB: createTestD1(), TRAVELPAYOUTS_TOKEN: "tp-token", TRAVELPAYOUTS_MARKER: "12345", ALLOWED_ORIGIN: ORIGIN, ...over });

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await Promise.all(pending);
  return res;
}

const post = (env: Env, body: unknown, path = "/api/party-check", headers: Record<string, string> = {}) =>
  call(env, path, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": IP, Origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

type ErrorBody = { error: { code: string; message: string; fieldCodes?: Record<string, string>; retryAfterSec?: number } };
const quotaRows = async (env: Env) => (await env.DB.prepare("SELECT source, period, used FROM source_quota").all()).results;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/party-check", () => {
  it("no live key: 404 unavailable, JSON, no-store, CORS for the one origin, and no outbound call at all", async () => {
    const up = stubUpstream();
    const res = await post(makeEnv(), CHECK);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("unavailable");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(up.hosts).toEqual([]);
  });

  it("every live key set: still 404 (no vendor documents both what is needed and a share that fits), no vendor call, nothing counted", async () => {
    const up = stubUpstream();
    const env = makeEnv(ALL_KEYS);
    const res = await post(env, CHECK);
    expect(res.status).toBe(404);
    expect(up.vendorHosts()).toEqual([]);
    expect(await quotaRows(env)).toEqual([]);
  });

  it("validation: 400 with a code per field", async () => {
    stubUpstream();
    const res = await post(makeEnv(), { ...CHECK, adults: 1, children: 1, returnDate: "bad" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.fieldCodes).toEqual({ adults: "out_of_range", children: "not_supported", returnDate: "invalid_format" });
  });

  it(`rate limited per client: ${PARTY_CHECK_RATE_LIMIT_MAX} requests, then 429 with Retry-After; another client is not affected`, async () => {
    stubUpstream();
    const env = makeEnv();
    for (let i = 0; i < PARTY_CHECK_RATE_LIMIT_MAX; i++) expect((await post(env, CHECK)).status).toBe(404);
    const limited = await post(env, CHECK);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    expect(((await limited.json()) as ErrorBody).error.code).toBe("rate_limited");
    expect((await post(env, CHECK, "/api/party-check", { "CF-Connecting-IP": "198.51.100.1" })).status).toBe(404);
    // The search's own limit is a different counter: a search still works.
    expect((await post(env, SEARCH, "/api/search")).status).toBe(200);
  });

  it("the stored limiter key is a salted hash, never the client's address", async () => {
    stubUpstream();
    const env = makeEnv({ RATE_LIMIT_SALT: "salt" });
    await post(env, CHECK);
    const keys = (await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^party-client:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain(IP);
  });

  it("HTTP plumbing like every other POST: 405 for GET, preflight for the one origin, 415, 413 and bad JSON", async () => {
    stubUpstream();
    const env = makeEnv();
    const get = await call(env, "/api/party-check");
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST, OPTIONS");
    const pre = await call(env, "/api/party-check", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const text = await call(env, "/api/party-check", { method: "POST", headers: { "content-type": "text/plain", "CF-Connecting-IP": "198.51.100.2" }, body: "{}" });
    expect(text.status).toBe(415);
    const big = await post(makeEnv(), "x".repeat(MAX_BODY_BYTES + 1));
    expect(big.status).toBe(413);
    const bad = await post(makeEnv(), "{nope");
    expect([bad.status, ((await bad.json()) as ErrorBody).error.code]).toEqual([400, "invalid_json"]);
  });
});

describe("the search answer's party-check fields, end to end", () => {
  it("2 adults: meta.partyCheck = { available: false } and every card carries its two links", async () => {
    stubUpstream();
    const res = await post(makeEnv(ALL_KEYS), { ...SEARCH, adults: 2 }, "/api/search");
    expect(res.status).toBe(200);
    const data = (await res.json()) as SearchResponse;
    expect(data.meta.partyCheck).toEqual({ available: false });
    expect(data.cards.length).toBeGreaterThan(0);
    for (const card of data.cards) {
      const check = card.partyCheck as PartyCheckLinks | undefined;
      if (!check) continue; // a card whose link is not an Aviasales search link has none
      expect(check.adults).toBe(2);
      expect(check.partyLink).toBe(card.offer.deeplink);
      expect(check.singleLink).not.toBe(check.partyLink);
    }
    expect(data.cards.some((c) => c.partyCheck)).toBe(true);
  });

  it("no live key at all (the free part): 2 adults still get both links on every card, no token, no vendor call; the check is 404", async () => {
    // With the one-way fixture the cheapest card is a split ticket; without one-ways the cards are round trips: both shapes.
    for (const [oneWays, shape] of [[true, "split"], [false, "roundtrip"]] as const) {
      const up = stubUpstream({ oneWays });
      const env = makeEnv(); // Travelpayouts only: no IGNAV/WEGO/SEARCHAPI/SERPAPI key
      const res = await post(env, { ...SEARCH, adults: 2 }, "/api/search");
      expect(res.status, shape).toBe(200);
      const data = (await res.json()) as SearchResponse;
      expect(data.meta.partyCheck, shape).toEqual({ available: false });
      const linked = data.cards.filter((c) => c.partyCheck && "singleLink" in c.partyCheck);
      expect(linked.some((c) => c.offer.ticketStructure === shape), shape).toBe(true);
      for (const card of linked) {
        const check = card.partyCheck as PartyCheckLinks;
        expect(check.adults).toBe(2);
        expect(check.partyLink).toBe(card.offer.deeplink); // the card's own link, already for the whole party
        // The same Aviasales search with the passenger code of ONE adult (round trip: origin DDMM destination DDMM + code; a split
        // ticket's one-way: origin DDMM destination + code, and its return one-way beside it).
        expect(check.singleLink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/TLV\d{4}BCN(\d{4})?1\?/);
        expect(check.partyLink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/TLV\d{4}BCN(\d{4})?2\?/);
        if (card.offer.ticketStructure === "split") {
          expect(check.returnSingleLink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/BCN\d{4}TLV1\?/);
          expect(check.returnPartyLink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/BCN\d{4}TLV2\?/);
        }
        expect(check).not.toHaveProperty("token"); // nothing can run the live check, so no card is signed
      }
      expect(up.vendorHosts()).toEqual([]);
      const check = await post(env, CHECK);
      expect([check.status, ((await check.json()) as ErrorBody).error.code]).toEqual([404, "unavailable"]);
      expect(up.vendorHosts()).toEqual([]);
      expect(await quotaRows(env)).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("1 adult: no partyCheck anywhere in the JSON", async () => {
    stubUpstream();
    const res = await post(makeEnv(), SEARCH, "/api/search");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("partyCheck");
  });
});

describe("production wiring with a vendor that qualifies (SIMULATED: Ignav's pricing flipped in memory, restored after each test)", () => {
  const KEY = "IGNAV-SECRET-KEY-42";
  let was: QuoteAdapterPricing;
  type QuoteAdapterPricing = (typeof ignavAdapter)["partyPricing"];
  beforeEach(() => {
    was = ignavAdapter.partyPricing;
    (ignavAdapter as { partyPricing?: string }).partyPricing = "total";
  });
  afterEach(() => {
    (ignavAdapter as { partyPricing?: QuoteAdapterPricing }).partyPricing = was;
  });

  /** Travelpayouts and the rates as above; Ignav answers one verified itinerary on the asked dates (100 USD alone, 180 for more). */
  function stubWithIgnav() {
    const ignav: Array<{ adults: number; departure_date: string; return_date: string }> = [];
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        hosts.push(url.hostname);
        if (url.hostname === "api.travelpayouts.com") return json(url.searchParams.get("one_way") === "true" ? { ...onewayFixture, data: [] } : roundtripFixture);
        if (url.hostname === "boi.org.il") return json({ exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }, { key: "EUR", currentExchangeRate: 3.9, unit: 1 }] });
        if (url.hostname === "ignav.com") {
          const q = JSON.parse(String(init?.body)) as { adults: number; departure_date: string; return_date: string };
          ignav.push(q);
          const leg = (date: string, flight: string) => ({ duration_minutes: 255, segments: [{ marketing_carrier_code: "LY", flight_number: flight, departure_time_local: `${date}T08:05:00`, arrival_time_local: `${date}T11:20:00` }] });
          return json({ itineraries: [{ price: { amount: q.adults === 1 ? 100 : 180, currency: "USD", status: "verified" }, outbound: leg(q.departure_date, "395"), inbound: leg(q.return_date, "396"), cabin_class: "economy", requires_self_transfer: false }] });
        }
        throw new Error(`unexpected host ${url.hostname}`);
      }),
    );
    return { ignav, hosts };
  }

  const used = async (env: Env) => (await env.DB.prepare("SELECT used FROM source_quota WHERE source = 'ignav' AND period = 'lifetime'").first<number>("used")) ?? 0;

  it("search -> every round-trip card carries its token -> the check of that card runs: 2 vendor requests, 2 units, no key in the answer", async () => {
    const up = stubWithIgnav();
    const env = makeEnv({ IGNAV_API_KEY: KEY, RATE_LIMIT_SALT: "salt-e2e" });
    const search = await post(env, { ...SEARCH, adults: 2 }, "/api/search");
    expect(search.status).toBe(200);
    const data = (await search.json()) as SearchResponse;
    expect(data.meta.partyCheck).toEqual({ available: true });
    const card = data.cards.find((c) => c.offer.ticketStructure === "roundtrip" && (c.partyCheck as PartyCheckLinks | undefined)?.token);
    expect(card).toBeDefined();
    const token = (card?.partyCheck as PartyCheckLinks).token as string;
    const unitsBefore = await used(env);
    const searchCalls = up.ignav.length;

    const body = { origin: card!.offer.origin, destination: card!.offer.destination, departDate: card!.offer.departDate, returnDate: card!.offer.returnDate, adults: 2, token };
    const res = await post(env, body);
    expect(res.status).toBe(200);
    const text = await res.text();
    const result = JSON.parse(text) as PartyCheckResult;
    expect(result.source).toBe("ignav");
    expect(up.ignav.slice(searchCalls).map((q) => q.adults)).toEqual([1, 2]);
    expect(await used(env)).toBe(unitsBefore + 2);
    for (const secret of [KEY, "ignav.com", "salt-e2e"]) expect(text).not.toContain(secret);
  });

  it("a made-up route, or a real card's token with other dates: 400 before the rates, any counter or any vendor", async () => {
    const up = stubWithIgnav();
    const env = makeEnv({ IGNAV_API_KEY: KEY, RATE_LIMIT_SALT: "salt-e2e" });
    const data = (await (await post(env, { ...SEARCH, adults: 2 }, "/api/search")).json()) as SearchResponse;
    const card = data.cards.find((c) => (c.partyCheck as PartyCheckLinks | undefined)?.token);
    const token = (card?.partyCheck as PartyCheckLinks).token as string;
    const hostsBefore = up.hosts.length;
    const unitsBefore = await used(env);
    const checksBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'party:%'").first<number>("n");
    const madeUp = await post(env, { ...CHECK, origin: "QQQ", destination: "ZZZ" });
    expect([madeUp.status, ((await madeUp.json()) as ErrorBody).error.code]).toEqual([400, "invalid_token"]);
    const otherDates = await post(env, { origin: card!.offer.origin, destination: card!.offer.destination, departDate: "2026-11-20", returnDate: "2026-11-25", adults: 2, token }, "/api/party-check", { "CF-Connecting-IP": "198.51.100.7" });
    expect([otherDates.status, ((await otherDates.json()) as ErrorBody).error.code]).toEqual([400, "invalid_token"]);
    expect(up.hosts.length).toBe(hostsBefore); // not even the exchange rates were fetched
    expect(await used(env)).toBe(unitsBefore);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'party:%'").first<number>("n")).toBe(checksBefore);
  });

  it("a valid token, but the allowance was spent in between (cap, then today's share): 503 by cause, and ZERO vendor requests", async () => {
    const up = stubWithIgnav();
    const env = makeEnv({ IGNAV_API_KEY: KEY, RATE_LIMIT_SALT: "salt-e2e" });
    const data = (await (await post(env, { ...SEARCH, adults: 2 }, "/api/search")).json()) as SearchResponse;
    const card = data.cards.find((c) => (c.partyCheck as PartyCheckLinks | undefined)?.token);
    const token = (card?.partyCheck as PartyCheckLinks).token as string;
    const body = { origin: card!.offer.origin, destination: card!.offer.destination, departDate: card!.offer.departDate, returnDate: card!.offer.returnDate, adults: 2, token };
    const vendorCalls = up.ignav.length;
    // Someone else used the one-off cap up to 1 unit short: a check needs 2.
    const setUsed = (n: number) =>
      env.DB.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('ignav', 'lifetime', ?, ?) ON CONFLICT(source, period) DO UPDATE SET used = excluded.used")
        .bind(n, NOW.toISOString())
        .run();
    await setUsed(799);
    const capped = await post(env, body);
    expect([capped.status, ((await capped.json()) as ErrorBody).error.code]).toEqual([503, "quota_exhausted"]);
    expect(await used(env)).toBe(799);
    // Room under the cap again, but today's share 1 short (27 a day for Ignav's 800): its own code, with the wait.
    await setUsed(0);
    const day = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('quota:ignav', ?, 26) ON CONFLICT(key, window_start) DO UPDATE SET count = 26").bind(day).run();
    const shared = await post(env, body, "/api/party-check", { "CF-Connecting-IP": "198.51.100.8" });
    const err = (await shared.json()) as ErrorBody;
    expect([shared.status, err.error.code]).toEqual([503, "daily_limit"]);
    expect(Number(shared.headers.get("Retry-After"))).toBe(15 * 3600);
    expect(await used(env)).toBe(0);
    expect(up.ignav.length).toBe(vendorCalls); // not one vendor request in either check
  });

  it("the allowance nearly spent: the search stops offering the check, and no card carries a token", async () => {
    stubWithIgnav();
    const env = makeEnv({ IGNAV_API_KEY: KEY });
    // 799 of 800 used: the search's own live quotes cannot run either, and the check could only be refused.
    await env.DB.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('ignav', 'lifetime', 799, ?)").bind(NOW.toISOString()).run();
    const data = (await (await post(env, { ...SEARCH, adults: 2 }, "/api/search")).json()) as SearchResponse;
    expect(data.meta.partyCheck).toEqual({ available: false });
    for (const card of data.cards) expect(card.partyCheck ?? {}).not.toHaveProperty("token");
  });
});
