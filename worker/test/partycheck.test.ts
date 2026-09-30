/**
 * "Book together or one by one?", the LIVE part (src/partycheck.ts): the verdict, the comparison, the request validation, which
 * source may be used, and POST /api/party-check's handler with the REAL quota core (createQuoteSource, withDailyShare, the D1
 * counters) behind it. Every vendor is a stub: nothing here leaves the machine.
 * Owner rule under test: nothing may cost money. A check reserves BOTH its units before any request, all or none; fewer than two
 * left (cap or daily share) means no request at all; the first failure ends the check, and so does a first answer without a
 * usable fare; nothing is retried; and only a card of a recent search (its signed token) can be checked at all.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import {
  compareFares,
  handlePartyCheck,
  parsePartyCheckBody,
  PARTY_CHECK_MAX_PER_DAY,
  PARTY_CHECK_ORDER,
  PARTY_CHECK_RATE_LIMIT_MAX,
  PARTY_CHECK_RATE_LIMIT_WINDOW_SECONDS,
  PARTY_CHECK_UNITS,
  PARTY_MIN_DIFF_ILS,
  partyCapable,
  partyCheckSource,
  partyChecksPerDay,
  partyVerdict,
  PARTY_TOKEN_TTL_SECONDS,
  runPartyCheck,
  signPartyToken,
  verifyPartyToken,
  type PartyCheckDeps,
  type PartyTokenFields,
} from "../src/partycheck";
import {
  createQuoteSource,
  dailyShare,
  QuoteError,
  vendorAdults,
  withDailyShare,
  type FareQuoteSource,
  type PartyFare,
  type PartyPricing,
  type QuoteAdapter,
  type QuotaSpec,
  type QuoteSourceName,
} from "../src/quotes";
import { createIgnavSource, IGNAV_QUOTA, ignavAdapter } from "../src/sources/ignav";
import { createSearchApiSource, SEARCHAPI_QUOTA, searchApiAdapter } from "../src/sources/searchapi";
import { createSerpApiSource, SERPAPI_QUOTA, serpApiAdapter } from "../src/sources/serpapi";
import { createWegoSource, WEGO_QUOTA } from "../src/sources/wego";
import type { FxRates, Leg, PartyCheckResult, Repo } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const DAY_START = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
const FX: FxRates = { date: "2026-10-01", source: "test", ratesToIls: { ILS: 1, USD: 3.5, EUR: 4 } };
const KEY = "vendor-SECRET-key-0123456789";
/** One-off 900 of 1,000: a daily share of 30, so 5 checks a day (the absolute cap). */
const BIG: QuotaSpec = { period: "lifetime", cap: 900, allowance: 1000 };
const BODY = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", adults: 2 };
/** The secret the search signs its cards with (production: the limiter salt). */
const SECRET = "test-salt-for-party-tokens";

/** The token a search answer gives the card of these fields (what the web sends back with a check). */
const tokenFor = (f: PartyTokenFields, secret = SECRET, at = NOW) => signPartyToken(secret, f, at);
const fieldsOf = (b: Record<string, unknown>): PartyTokenFields => ({
  origin: String(b.origin),
  destination: String(b.destination),
  departDate: String(b.departDate),
  returnDate: String(b.returnDate),
  adults: Number(b.adults),
});
/** One character in the middle of the signature changed (a middle character always changes the decoded bytes). */
const tamper = (token: string): string => {
  const i = token.lastIndexOf(".") + 10;
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
};
/** A request body the way the web sends it: the card's fields plus that card's token (unless the body already says otherwise). */
async function signed(body: unknown): Promise<unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body) || "token" in body) return body;
  const b = body as Record<string, unknown>;
  if (!["origin", "destination", "departDate", "returnDate", "adults"].every((k) => typeof b[k] === "string" || typeof b[k] === "number")) return body;
  return { ...b, token: await tokenFor(fieldsOf(b)) };
}

const leg = (over: Partial<Leg> = {}): Leg => ({ departTime: "07:00", arriveTime: null, stops: 0, durationMin: 240, airlines: ["LY"], ...over });
const pf = (amount: number, over: Partial<PartyFare> = {}): PartyFare => ({ amount, currency: "USD", flightKey: null, outbound: leg(), inbound: leg({ departTime: "18:00" }), ...over });

// --- a stand-in vendor behind the real core ---------------------------------------------------------------

interface VendorFare {
  price: number;
  currency?: string;
  key?: string | null;
  dep?: string;
  airline?: string;
}

/** Asks for `adults` in its URL (with the key, like SerpApi does); reads { fares: [...] }. */
function testAdapter(pricing: PartyPricing | undefined, quota: QuotaSpec = BIG, name: QuoteSourceName = "ignav"): QuoteAdapter {
  return {
    name,
    quota,
    partyPricing: pricing,
    request: (q, key) => ({
      url: `https://vendor.test/fares?o=${q.origin}&d=${q.destination}&dep=${q.departDate}&ret=${q.returnDate}&adults=${vendorAdults(q)}&api_key=${key}`,
      headers: {},
    }),
    parse: (body) =>
      ((body as { fares?: VendorFare[] }).fares ?? []).map((f) => ({
        price: f.price,
        currency: f.currency ?? "USD",
        outbound: leg({ departTime: f.dep ?? "07:00", airlines: [f.airline ?? "LY"] }),
        inbound: leg({ departTime: "18:00", airlines: [f.airline ?? "LY"] }),
        flightKey: f.key ?? null,
      })),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const adultsOf = (url: unknown) => Number(new URL(String(url)).searchParams.get("adults"));

/** The vendor answers by the adults it was asked for. */
function vendor(single: VendorFare[], group: VendorFare[]) {
  return vi.fn(async (url: unknown, _init?: RequestInit) => json({ fares: adultsOf(url) === 1 ? single : group }));
}

function world(opts: { pricing?: PartyPricing; quota?: QuotaSpec; fetchFn?: ReturnType<typeof vi.fn>; fx?: () => Promise<FxRates>; repo?: Repo } = {}) {
  const db = createTestD1();
  const repo = opts.repo ?? createRepo(db);
  const fetchFn = opts.fetchFn ?? vendor([{ price: 100, key: "X" }], [{ price: 260, key: "X" }]);
  const source = createQuoteSource(testAdapter("pricing" in opts ? opts.pricing : "total", opts.quota ?? BIG), {
    key: KEY,
    repo: withDailyShare(repo),
    now: NOW,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const fx = vi.fn(opts.fx ?? (async () => FX));
  const deps: PartyCheckDeps & { clientKey: string } = { repo, sources: [source], fx, tokenSecret: SECRET, now: NOW, clientKey: "party-client:test" };
  /** A check as the web sends it: a full request gets its card's token (see signed); `raw` sends the body untouched. */
  const check = async (body: unknown = BODY, over: Partial<PartyCheckDeps & { clientKey: string }> = {}, raw = false) => {
    const value = raw ? body : await signed(body);
    return handlePartyCheck({ ...deps, ...over }, async () => ({ ok: true as const, value }));
  };
  return { db, repo, fetchFn, source, deps, check, fx };
}

const used = async (db: D1Database, source = "ignav") =>
  (await db.prepare("SELECT used FROM source_quota WHERE source = ? AND period = 'lifetime'").bind(source).first<number>("used")) ?? 0;
const daily = async (db: D1Database, key: string) =>
  (await db.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?").bind(key, DAY_START).first<number>("count")) ?? 0;
const seedUsed = (db: D1Database, n: number, source = "ignav") =>
  db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES (?, 'lifetime', ?, ?)").bind(source, n, NOW.toISOString()).run();
const seedDaily = (db: D1Database, key: string, n: number) => db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)").bind(key, DAY_START, n).run();
const errorOf = (r: { body?: unknown }) => (r.body as { error: { code: string; message: string; retryAfterSec?: number; fields?: Record<string, string>; fieldCodes?: Record<string, string> } }).error;

// --- the verdict ------------------------------------------------------------------------------------------

describe("partyVerdict: separate = first adult at the single price, the others at the group's price per person (an ESTIMATE)", () => {
  it("equal prices: no difference, book together", () => {
    const v = partyVerdict(300, 600, 2);
    // No estimate outside "separate" (see the "together" case below for why).
    expect(v).toEqual({ verdict: "same", perPersonIls: 300, separateEstimateIls: null, savingIls: 0, thresholdIls: PARTY_MIN_DIFF_ILS });
    expect(Object.is(v.savingIls, -0)).toBe(false);
  });

  it("the last cheap seat: one by one is estimated cheaper by exactly the group's price per person minus the single price", () => {
    // 2 adults: together 1,000 (500 each), one alone 400 -> separate estimate 400 + 500 = 900, saving 100 >= max(20, 30).
    expect(partyVerdict(400, 1000, 2)).toEqual({ verdict: "separate", perPersonIls: 500, separateEstimateIls: 900, savingIls: 100, thresholdIls: 30 });
  });

  it("N = 3: only the first seat is at the single price", () => {
    // together 1,500 (500 each), one alone 450 -> 450 + 2 x 500 = 1,450, saving 50 >= max(20, 45).
    expect(partyVerdict(450, 1500, 3)).toEqual({ verdict: "separate", perPersonIls: 500, separateEstimateIls: 1450, savingIls: 50, thresholdIls: 45 });
    // 460 alone: saving 40 < 45: not worth it.
    expect(partyVerdict(460, 1500, 3).verdict).toBe("same");
  });

  it("the group is cheaper per person: book together, and no 'separate' estimate (the formula would name an impossible cost)", () => {
    // together 800 (400 each), one alone 450: the group saves 50 per person >= max(20, 24).
    // single + (N-1) x together/N would say 850, but two one-adult bookings cost at least 2 x 450 = 900: no estimate is given.
    expect(partyVerdict(450, 800, 2)).toEqual({ verdict: "together", perPersonIls: 400, separateEstimateIls: null, savingIls: -50, thresholdIls: 24 });
    // A difference below the threshold either way: no estimate either.
    expect(partyVerdict(290, 600, 2).separateEstimateIls).toBeNull();
    expect(partyVerdict(310, 600, 2).separateEstimateIls).toBeNull();
    // Only "separate" carries it.
    expect(partyVerdict(400, 1000, 2).separateEstimateIls).toBe(900);
  });

  it("a difference below the threshold is 'same', in both directions; the threshold is max(20 ILS, 3% of the group total)", () => {
    expect(partyVerdict(290, 600, 2).verdict).toBe("same"); // saving 10 < 20
    expect(partyVerdict(310, 600, 2).verdict).toBe("same"); // group cheaper by 10 < 20
    expect(partyVerdict(281, 600, 2).verdict).toBe("same"); // 19 < 20
    expect(partyVerdict(280, 600, 2).verdict).toBe("separate"); // exactly 20: counts
    expect(partyVerdict(320, 600, 2).verdict).toBe("together"); // exactly 20 the other way
    // 3% wins on a large total: 3% of 4,000 = 120.
    expect(partyVerdict(1890, 4000, 2)).toMatchObject({ verdict: "same", thresholdIls: 120 }); // saving 110 < 120
    expect(partyVerdict(1880, 4000, 2)).toMatchObject({ verdict: "separate", savingIls: 120 });
  });

  it("missing or broken data is 'unknown', with no numbers", () => {
    const unknown = { verdict: "unknown", perPersonIls: null, separateEstimateIls: null, savingIls: null, thresholdIls: null };
    for (const [single, together, n] of [
      [null, 600, 2],
      [300, null, 2],
      [0, 600, 2],
      [300, -1, 2],
      [Number.NaN, 600, 2],
      [300, Number.POSITIVE_INFINITY, 2],
      [300, 600, 1],
      [300, 600, 2.5],
    ] as Array<[number | null, number | null, number]>) {
      expect(partyVerdict(single, together, n), `${single} ${together} ${n}`).toEqual(unknown);
    }
  });
});

// --- the comparison ---------------------------------------------------------------------------------------

describe("compareFares: the same flight when both answers name it, else cheapest vs cheapest (and it says so)", () => {
  it("finds the same flight in both answers: the one cheapest for one adult among the flights both have", () => {
    const single = [pf(100, { flightKey: "A" }), pf(90, { flightKey: "B" }), pf(80, { flightKey: "C" })];
    const group = [pf(300, { flightKey: "A" }), pf(250, { flightKey: "B" }), pf(150, { flightKey: "Z" })];
    const cmp = compareFares(single, group, 2, FX, "total");
    expect(cmp.basis).toBe("same_flight");
    expect(cmp.single?.fare.flightKey).toBe("B"); // C is cheaper alone but the group answer has no C
    expect(cmp.together?.fare.flightKey).toBe("B");
    expect(cmp.together?.ils).toBe(875);
  });

  it("without flight identity, or with no flight in common, compares cheapest with cheapest", () => {
    const plain = compareFares([pf(120), pf(100)], [pf(260), pf(230)], 2, FX, "total");
    expect(plain.basis).toBe("cheapest");
    expect([plain.single?.total, plain.together?.total]).toEqual([100, 230]);
    const disjoint = compareFares([pf(100, { flightKey: "A" })], [pf(230, { flightKey: "B" })], 2, FX, "total");
    expect(disjoint.basis).toBe("cheapest");
    // Why: no identity at all, versus named flights of which none is in both answers.
    expect(plain.why).toBe("no_identity");
    expect(disjoint.why).toBe("no_common_flight");
    expect(compareFares([pf(100, { flightKey: "A" })], [pf(230)], 2, FX, "total").why).toBe("no_identity");
  });

  it("a per-person vendor price is multiplied by the adults for the group total", () => {
    const cmp = compareFares([pf(100)], [pf(130)], 3, FX, "per_person");
    expect(cmp.together?.total).toBe(390);
    expect(cmp.together?.ils).toBeCloseTo(1365, 6);
  });

  it("converts each fare with the day's rate; a currency without a rate cannot be compared; nothing priceable = nothing to compare", () => {
    const cmp = compareFares([pf(100, { currency: "EUR" })], [pf(240, { currency: "XXX" }), pf(260)], 2, FX, "total");
    expect([cmp.single?.ils, cmp.together?.ils]).toEqual([400, 910]);
    expect(compareFares([], [pf(260)], 2, FX, "total")).toEqual({ basis: null, why: "no_single", single: null, together: null });
    expect(compareFares([pf(100)], [], 2, FX, "total")).toEqual({ basis: null, why: "no_group", single: null, together: null });
    expect(compareFares([pf(100)], [pf(260, { currency: "XXX" })], 2, FX, "total").basis).toBeNull();
  });
});

// --- validation -------------------------------------------------------------------------------------------

describe("parsePartyCheckBody", () => {
  const fieldsOf = (body: unknown) => {
    const r = parsePartyCheckBody(body, NOW);
    return r.ok ? {} : r.fieldCodes;
  };

  it("accepts a round trip or a one way for 2-9 adults, normalising the airport codes", () => {
    expect(parsePartyCheckBody({ ...BODY, origin: "tlv", destination: " bcn " }, NOW)).toEqual({ ok: true, q: { ...BODY, origin: "TLV", destination: "BCN", token: null } });
    expect(parsePartyCheckBody({ ...BODY, returnDate: null, adults: 9 }, NOW)).toEqual({ ok: true, q: { ...BODY, returnDate: null, adults: 9, token: null } });
    // A well-formed token is passed through as is (runPartyCheck checks it against the secret).
    const token = `v1.1790000000.${"A".repeat(43)}`;
    expect(parsePartyCheckBody({ ...BODY, token }, NOW)).toEqual({ ok: true, q: { ...BODY, token } });
    const { returnDate: _drop, ...noReturn } = BODY;
    expect(parsePartyCheckBody(noReturn, NOW)).toMatchObject({ ok: true, q: { returnDate: null } });
    expect(parsePartyCheckBody({ ...BODY, children: 0, infants: null, extra: "ignored" }, NOW).ok).toBe(true);
  });

  it("refuses a body that is not an object", () => {
    for (const body of [null, [], "x", 3]) expect(parsePartyCheckBody(body, NOW)).toMatchObject({ ok: false, fieldCodes: { body: "invalid_format" } });
  });

  it("gives a machine code per bad field, all at once", () => {
    expect(fieldsOf({})).toEqual({ origin: "required", destination: "required", departDate: "required", adults: "required" });
    expect(fieldsOf({ ...BODY, origin: "TLVX", destination: 7 })).toEqual({ origin: "invalid_format", destination: "invalid_format" });
    expect(fieldsOf({ ...BODY, destination: "tlv" })).toEqual({ destination: "same_place" });
    expect(fieldsOf({ ...BODY, departDate: "2026-02-30" })).toEqual({ departDate: "invalid_format" });
    expect(fieldsOf({ ...BODY, departDate: "2026-09-30", returnDate: "2026-10-05" })).toEqual({ departDate: "past_date" });
    expect(fieldsOf({ ...BODY, departDate: "2027-10-02", returnDate: "2027-10-05" })).toEqual({ departDate: "out_of_range" });
    expect(fieldsOf({ ...BODY, returnDate: "2026-11-12" })).toEqual({ returnDate: "start_after_end" });
    expect(fieldsOf({ ...BODY, returnDate: "2026-11-10" })).toEqual({ returnDate: "start_after_end" });
    expect(fieldsOf({ ...BODY, returnDate: "2026-12-13" })).toEqual({ returnDate: "out_of_range" }); // 31 nights
    expect(fieldsOf({ ...BODY, returnDate: "18/11/2026" })).toEqual({ returnDate: "invalid_format" });
  });

  it("adults: a whole number from 2 to 9, never coerced; children and infants are refused", () => {
    expect(fieldsOf({ ...BODY, adults: 1 })).toEqual({ adults: "out_of_range" });
    expect(fieldsOf({ ...BODY, adults: 10 })).toEqual({ adults: "out_of_range" });
    expect(fieldsOf({ ...BODY, adults: "2" })).toEqual({ adults: "invalid_format" });
    expect(fieldsOf({ ...BODY, adults: 2.5 })).toEqual({ adults: "invalid_format" });
    expect(fieldsOf({ ...BODY, children: 1 })).toEqual({ children: "not_supported" });
    expect(fieldsOf({ ...BODY, infants: 1, children: "1" })).toEqual({ infants: "not_supported", children: "not_supported" });
  });

  it("an inherited property is never a field", () => {
    const polluted = JSON.parse('{"__proto__":{"adults":5},"origin":"TLV","destination":"BCN","departDate":"2026-11-12"}') as Record<string, unknown>;
    expect(parsePartyCheckBody(polluted, NOW)).toMatchObject({ ok: false, fieldCodes: { adults: "required" } });
  });
});

// --- which source -----------------------------------------------------------------------------------------

describe("which source the live check may use", () => {
  const plainRepo = () => createRepo(createTestD1());
  const noFetch = (() => {
    throw new Error("no fetch in this test");
  }) as unknown as typeof fetch;

  it("the vendor docs decide: only Wego's multi-adult price is read (INFERRED from its docs, checked on every fare); SerpApi, SearchApi and Ignav are unknown", () => {
    expect(serpApiAdapter.partyPricing).toBe("unknown");
    expect(searchApiAdapter.partyPricing).toBe("unknown");
    expect(ignavAdapter.partyPricing).toBe("unknown");
    expect(createWegoSource({ apiKey: "c", repo: plainRepo(), now: NOW, fetchFn: noFetch }).partyPricing).toBe("total");
  });

  it("checks per day stay well below each source's daily share, and a share of under 4 requests cannot afford one", () => {
    expect(PARTY_CHECK_UNITS).toBe(2);
    expect(partyChecksPerDay(IGNAV_QUOTA)).toBe(PARTY_CHECK_MAX_PER_DAY); // share 27: 5 checks = 10 requests
    expect(partyChecksPerDay(SERPAPI_QUOTA)).toBe(1); // share 4: 1 check = 2 requests
    expect(partyChecksPerDay(SEARCHAPI_QUOTA)).toBe(0); // share 2
    expect(partyChecksPerDay(WEGO_QUOTA)).toBe(0); // share 1: a two-search check never fits
    for (const quota of [IGNAV_QUOTA, SERPAPI_QUOTA, SEARCHAPI_QUOTA, WEGO_QUOTA, BIG]) {
      expect(partyChecksPerDay(quota) * PARTY_CHECK_UNITS).toBeLessThanOrEqual(dailyShare(quota.period, quota.cap) / 2);
    }
    expect(partyChecksPerDay({ period: "lifetime", cap: 999, allowance: 1000 })).toBe(0); // an unsafe spec never qualifies
  });

  it("with every real vendor configured, none qualifies today: the endpoint answers 404 and the button stays hidden", () => {
    const repo = withDailyShare(plainRepo());
    const all = [
      createIgnavSource({ apiKey: "k", repo, now: NOW, fetchFn: noFetch }),
      createWegoSource({ apiKey: "k", repo, now: NOW, fetchFn: noFetch }),
      createSearchApiSource({ apiKey: "k", repo, now: NOW, fetchFn: noFetch }),
      createSerpApiSource({ apiKey: "k", repo, now: NOW, fetchFn: noFetch }),
    ];
    expect(all.every((s) => s.configured)).toBe(true);
    expect(all.map(partyCapable)).toEqual([false, false, false, false]);
    expect(partyCheckSource(all)).toBeNull();
  });

  it("takes the first capable source in the fixed order, skipping unknown pricing, a missing key and a source without a series", () => {
    expect(PARTY_CHECK_ORDER).toEqual(["ignav", "wego", "searchapi", "serpapi", "duffel"]);
    const mk = (name: QuoteSourceName, pricing: PartyPricing | undefined, key = "k") =>
      createQuoteSource(testAdapter(pricing, BIG, name), { key, repo: plainRepo(), now: NOW, fetchFn: noFetch });
    const serp = mk("serpapi", "per_person");
    const ignav = mk("ignav", "total");
    expect(partyCheckSource([serp, ignav])).toBe(ignav);
    expect(partyCheckSource([serp, mk("ignav", "unknown")])).toBe(serp);
    expect(partyCheckSource([serp, mk("ignav", undefined)])).toBe(serp);
    expect(partyCheckSource([mk("ignav", "total", "")])).toBeNull(); // no key: not configured
    const noSeries: FareQuoteSource = { name: "ignav", configured: true, quota: BIG, partyPricing: "total", callCount: () => 0, quote: async () => [] };
    expect(partyCheckSource([noSeries])).toBeNull();
  });
});

// --- the endpoint handler ---------------------------------------------------------------------------------

describe("POST /api/party-check: the check", () => {
  it("asks ONE adult first, then the whole group, and compares the same flight", async () => {
    const w = world({ fetchFn: vendor([{ price: 100, key: "LY315", dep: "07:05" }, { price: 90, key: "W6" }], [{ price: 260, key: "LY315" }, { price: 250, key: "A3" }]) });
    const res = await w.check();
    expect(res.status).toBe(200);
    expect(w.fetchFn.mock.calls.map((c) => adultsOf(c[0]))).toEqual([1, 2]);
    const body = res.body as PartyCheckResult;
    expect(body).toEqual({
      source: "ignav",
      sourceName: "Ignav",
      checkedAt: NOW.toISOString(),
      adults: 2,
      matchBasis: "same_flight",
      flight: { outboundDepartTime: "07:05", inboundDepartTime: "18:00", airlines: ["LY"] },
      single: { amount: 100, currency: "USD", ils: 350 },
      together: { amount: 260, currency: "USD", ils: 910, perPersonIls: 455 },
      separateEstimateIls: 805,
      savingIls: 105,
      thresholdIls: 27.3,
      verdict: "separate",
      noteHe: expect.stringContaining("הערכה"),
      fx: { date: "2026-10-01", source: "test" },
    });
    expect(body.noteHe).toContain("אותה טיסה");
    expect(body.noteHe).toContain("Ignav");
    expect(body.noteHe).toContain("₪105");
  });

  it("without flight identity it compares cheapest with cheapest and says so", async () => {
    const w = world({ fetchFn: vendor([{ price: 100 }, { price: 120 }], [{ price: 190 }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body.matchBasis).toBe("cheapest");
    expect(body.flight).toBeNull();
    expect(body.verdict).toBe("same"); // 95 per person vs 100 alone: 17.5 < 20
    expect(body.noteHe).toContain("ייתכן שאלה טיסות שונות");
  });

  it("the group cheaper per person: 'together'; three adults take three in the group request", async () => {
    const w = world({ fetchFn: vendor([{ price: 100 }], [{ price: 240 }]) });
    const body = (await w.check({ ...BODY, adults: 3 })).body as PartyCheckResult;
    expect(w.fetchFn.mock.calls.map((c) => adultsOf(c[0]))).toEqual([1, 3]);
    expect(body).toMatchObject({ adults: 3, verdict: "together", together: { amount: 240, ils: 840, perPersonIls: 280 } });
  });

  it("a per-person vendor price (PartyPricing \"per_person\") is multiplied for the group", async () => {
    const w = world({ pricing: "per_person", fetchFn: vendor([{ price: 100, key: "X" }], [{ price: 150, key: "X" }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body.together).toEqual({ amount: 300, currency: "USD", ils: 1050, perPersonIls: 525 });
    expect(body.verdict).toBe("separate");
  });

  it("an answer without a comparable fare: 200 with verdict 'unknown' and no numbers, and the note says which search found nothing", async () => {
    const w = world({ fetchFn: vendor([{ price: 100 }], []) });
    const res = await w.check();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: "unknown", matchBasis: null, single: null, together: null, separateEstimateIls: null, savingIls: null });
    const note = (res.body as PartyCheckResult).noteHe;
    expect(note).toContain("בחיפוש לכל הקבוצה לא נמצא מחיר שאפשר להשוות");
    // The web's title already says "we could not compare": the note does not repeat it, and claims no prices it does not show.
    expect(note).not.toContain("לא הצלחנו להשוות");
    expect(note).not.toContain("המחירים נבדקו");
    expect(note).toContain("הבדיקה נעשתה עכשיו אצל Ignav");
  });

  it("the compared flight is named in the result, and the note says how it was picked (not 'this card's flight')", async () => {
    const w = world({ fetchFn: vendor([{ price: 100, key: "LY315", dep: "07:05" }], [{ price: 260, key: "LY315", dep: "07:05" }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body.flight).toEqual({ outboundDepartTime: "07:05", inboundDepartTime: "18:00", airlines: ["LY"] });
    expect(body.noteHe).toContain("הזולה ביותר לנוסע אחד מבין הטיסות שהופיעו בשתיהן");
    expect(body.noteHe).not.toContain("השווינו את אותה טיסה בשתי הבדיקות (לפי"); // the old wording that read as the card's own flight
  });

  it("cheapest against cheapest on DIFFERENT flights is never 'separate': the prices are shown and the answer says it cannot tell", async () => {
    // The review's case: one adult on flight A (07:00) for ~₪400, the group on flight B (09:00) for ₪1,000. Booking one by one
    // would put the first traveller on A and the other on B: no single flight offers that split.
    const w = world({ fetchFn: vendor([{ price: 400, currency: "ILS", key: "A", dep: "07:00" }], [{ price: 1000, currency: "ILS", key: "B", dep: "09:00" }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body).toMatchObject({
      verdict: "unknown",
      matchBasis: "cheapest",
      flight: null,
      single: { amount: 400, currency: "ILS", ils: 400 },
      together: { amount: 1000, currency: "ILS", ils: 1000, perPersonIls: 500 },
      separateEstimateIls: null,
      savingIls: null,
      thresholdIls: null,
    });
    // The reason names the actual cause: the vendor DID name its flights, none was in both answers.
    expect(body.noteHe).toContain("הם בטיסות שונות");
    expect(body.noteHe).not.toContain("הספק לא מסר פרטי טיסה");
    expect(body.noteHe).not.toContain("לחסוך");
    // Without any flight identity the same numbers say so with that cause.
    const plain = world({ fetchFn: vendor([{ price: 400, currency: "ILS" }], [{ price: 1000, currency: "ILS" }]) });
    const unnamed = (await plain.check()).body as PartyCheckResult;
    expect(unnamed.verdict).toBe("unknown");
    expect(unnamed.noteHe).toContain("הספק לא מסר פרטי טיסה");
  });

  it("cheapest against cheapest may still say 'together' or 'same', with the cause of the basis in words", async () => {
    // Group B at 700 (350 each) against one adult on A at 400: booking everybody on B beats any split, on any flight.
    const w = world({ fetchFn: vendor([{ price: 400, currency: "ILS", key: "A" }], [{ price: 700, currency: "ILS", key: "B" }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body).toMatchObject({ verdict: "together", matchBasis: "cheapest", separateEstimateIls: null, savingIls: -50 });
    expect(body.noteHe).toContain("אף טיסה לא הופיעה בשתי הבדיקות");
    expect(body.noteHe).toContain("עדיף להזמין את כולם יחד");
  });

  it("the sums in the note are the differences of the prices exactly as the web shows them (whole shekels, rounded up)", async () => {
    // One adult 87.675 EUR = ₪350.70, the group 227.55 EUR = ₪910.20 (₪455.10 each): estimate ₪805.80, saving ₪104.40.
    // The web shows ₪911 and ₪806 (formatILS rounds up), so the note says ₪105, never ₪104.
    const w = world({ fetchFn: vendor([{ price: 87.675, currency: "EUR", key: "X" }], [{ price: 227.55, currency: "EUR", key: "X" }]) });
    const body = (await w.check()).body as PartyCheckResult;
    expect(body.verdict).toBe("separate");
    expect([body.together?.ils, body.separateEstimateIls, body.savingIls]).toEqual([910.2, 805.8, 104.4]);
    expect(body.noteHe).toContain("כ־₪105");
    expect(body.noteHe).not.toContain("₪104");
    // "together": the per-person difference between the two figures shown (₪451 alone, ₪401 each together): ₪50.
    // One alone ₪450.90 (shown ₪451), together ₪800.20 = ₪400.10 each (shown ₪401): the difference exactly is ₪50.80, but the
    // two figures on the screen differ by ₪50, and that is what the note says.
    const t = world({ fetchFn: vendor([{ price: 450.9, currency: "ILS" }], [{ price: 800.2, currency: "ILS" }]) });
    const together = (await t.check()).body as PartyCheckResult;
    expect(together.verdict).toBe("together");
    expect(together.noteHe).toContain("נמוך בכ־₪50 ");
    expect(together.noteHe).not.toContain("₪51");
  });

  it("three adults: the separate estimate and its words are about ONE traveller alone and the others together", async () => {
    // together 1,500 USD-equivalent: 3 x 500; one alone 450 -> saving 50 >= max(20, 45).
    const w = world({ fetchFn: vendor([{ price: 450, currency: "ILS", key: "X" }], [{ price: 1500, currency: "ILS", key: "X" }]) });
    const body = (await w.check({ ...BODY, adults: 3 })).body as PartyCheckResult;
    expect(body).toMatchObject({ verdict: "separate", separateEstimateIls: 1450, savingIls: 50 });
    expect(body.noteHe).toContain("הזמנה נפרדת לנוסע אחד, ושאר הנוסעים יחד בהזמנה אחת");
    expect(body.noteHe).not.toContain("לכל נוסע");
  });
});

describe("POST /api/party-check: nothing may cost money", () => {
  it("the one-adult search answers HTTP 200 without a usable fare: the check stops there, the group search is never sent", async () => {
    for (const first of [{ fares: [] }, { error: "no results" }, { fares: [{ price: 0 }, { price: 90, currency: "usd" }] }]) {
      const fetchFn = vi.fn(async (url: unknown) => json(adultsOf(url) === 1 ? first : { fares: [{ price: 260 }] }));
      const w = world({ fetchFn });
      const res = await w.check();
      expect(res.status, JSON.stringify(first)).toBe(200);
      expect(fetchFn, JSON.stringify(first)).toHaveBeenCalledTimes(1); // no second vendor request
      expect(fetchFn.mock.calls.map((c) => adultsOf(c[0]))).toEqual([1]);
      expect(res.body).toMatchObject({ verdict: "unknown", single: null, together: null, separateEstimateIls: null });
      expect((res.body as PartyCheckResult).noteHe).toContain("ולכן לא חיפשנו גם לכל הקבוצה");
      expect(await used(w.db)).toBe(2); // both units were reserved up front (no refund): it can only overcount
    }
  });

  it("a one-adult answer whose fares cannot be compared (a currency without a day's rate) also ends the check: no group search", async () => {
    const group = { fares: [{ price: 260, key: "X" }] };
    const fetchFn = vi.fn(async (url: unknown) => json(adultsOf(url) === 1 ? { fares: [{ price: 90, currency: "GBP", key: "X" }] } : group));
    const w = world({ fetchFn }); // the day's rates: ILS, USD and EUR only
    const res = await w.check();
    expect(res.status).toBe(200);
    expect(fetchFn.mock.calls.map((c) => adultsOf(c[0]))).toEqual([1]); // the group search is never sent
    expect(res.body).toMatchObject({ verdict: "unknown", single: null, together: null, separateEstimateIls: null });
    expect((res.body as PartyCheckResult).noteHe).toContain("ולכן לא חיפשנו גם לכל הקבוצה");
    expect(await used(w.db)).toBe(2); // both units were reserved up front (no refund): it can only overcount
    // One comparable fare in the answer is enough to go on to the group search.
    const mixed = vi.fn(async (url: unknown) => json(adultsOf(url) === 1 ? { fares: [{ price: 90, currency: "GBP", key: "X" }, { price: 100, key: "X" }] } : group));
    const w2 = world({ fetchFn: mixed });
    expect((await w2.check()).status).toBe(200);
    expect(mixed.mock.calls.map((c) => adultsOf(c[0]))).toEqual([1, 2]);
  });

  it("only a card of a recent search: no token, a made-up route, or a token for other fields -> 400 before ANYTHING is spent", async () => {
    const w = world();
    const token = await tokenFor(fieldsOf(BODY));
    const attempts: Array<[string, unknown]> = [
      ["no token", BODY],
      ["made-up route", { ...BODY, origin: "QQQ", destination: "ZZZ" }],
      ["made-up route, a real card's token", { ...BODY, origin: "QQQ", destination: "ZZZ", token }],
      ["other dates", { ...BODY, departDate: "2026-11-13", token }],
      ["other return", { ...BODY, returnDate: "2026-11-19", token }],
      ["other adults", { ...BODY, adults: 3, token }],
      ["another secret", { ...BODY, token: await tokenFor(fieldsOf(BODY), "someone-elses-salt") }],
      ["tampered signature", { ...BODY, token: tamper(token) }],
    ];
    for (const [label, body] of attempts) {
      const res = await w.check(body, { clientKey: `party-client:${label}` }, true);
      expect([res.status, errorOf(res).code], label).toEqual([400, "invalid_token"]);
    }
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(w.fx).not.toHaveBeenCalled(); // not even the exchange rates
    expect(await used(w.db)).toBe(0);
    expect(await daily(w.db, "quota:ignav")).toBe(0);
    expect(await daily(w.db, "party:ignav")).toBe(0);
    // The real card's own token is accepted.
    expect((await w.check({ ...BODY, token }, { clientKey: "party-client:real" }, true)).status).toBe(200);
  });

  it("a card token is good for a day: after that 400 offer_expired, and nothing is spent", async () => {
    const w = world();
    const old = await tokenFor(fieldsOf(BODY), SECRET, new Date(NOW.getTime() - PARTY_TOKEN_TTL_SECONDS * 1000 - 1000));
    const res = await w.check({ ...BODY, token: old }, {}, true);
    expect([res.status, errorOf(res).code]).toEqual([400, "offer_expired"]);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await used(w.db)).toBe(0);
    const fresh = await tokenFor(fieldsOf(BODY), SECRET, new Date(NOW.getTime() - (PARTY_TOKEN_TTL_SECONDS - 60) * 1000));
    expect((await w.check({ ...BODY, token: fresh }, {}, true)).status).toBe(200);
  });

  it("no capable source: 404 unavailable, no request, nothing counted", async () => {
    for (const pricing of ["unknown", undefined] as const) {
      const w = world({ pricing });
      const res = await w.check();
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("unavailable");
      expect(w.fetchFn).not.toHaveBeenCalled();
      expect(await used(w.db)).toBe(0);
      expect(await daily(w.db, "party:ignav")).toBe(0);
    }
    const none = world();
    expect((await none.check(BODY, { sources: [] })).status).toBe(404);
  });

  it("a one-way check (returnDate null): no source prices one-ways, 404, no request", async () => {
    const w = world();
    const res = await w.check({ ...BODY, returnDate: null });
    expect([res.status, errorOf(res).code]).toEqual([404, "unavailable"]);
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it("reserves BOTH units (cap and daily share) and the check's own daily slot BEFORE the first request", async () => {
    const seen: number[][] = [];
    const db = createTestD1();
    const fetchFn = vi.fn(async (url: unknown) => {
      seen.push([await used(db), await daily(db, "quota:ignav"), await daily(db, "party:ignav")]);
      return json({ fares: [{ price: adultsOf(url) === 1 ? 100 : 200 }] });
    });
    const w = world({ repo: createRepo(db), fetchFn });
    expect((await w.check()).status).toBe(200);
    expect(seen).toEqual([
      [2, 2, 1], // at the first request both units are already counted
      [2, 2, 1], // and the second request took no further unit
    ]);
  });

  it("only 1 unit left under the cap: refused with ZERO requests, and the counter is not raised", async () => {
    const w = world();
    await seedUsed(w.db, BIG.cap - 1);
    const res = await w.check();
    expect([res.status, errorOf(res).code]).toEqual([503, "quota_exhausted"]);
    expect(errorOf(res).retryAfterSec).toBeUndefined(); // a spent cap does not come back at midnight: no wait is promised
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await used(w.db)).toBe(BIG.cap - 1);
  });

  it("0 units left: refused with zero requests", async () => {
    const w = world();
    await seedUsed(w.db, BIG.cap);
    const res = await w.check();
    expect([res.status, errorOf(res).code]).toEqual([503, "quota_exhausted"]);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await used(w.db)).toBe(BIG.cap);
  });

  it("only 1 unit left in today's share: refused with zero requests, the real counter untouched", async () => {
    const w = world();
    await seedDaily(w.db, "quota:ignav", dailyShare(BIG.period, BIG.cap) - 1);
    const res = await w.check();
    // Today's share comes back at UTC midnight (unlike the cap): its own code, with the wait.
    expect([res.status, errorOf(res).code, errorOf(res).retryAfterSec]).toEqual([503, "daily_limit", 15 * 3600]);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await used(w.db)).toBe(0);
    expect(await daily(w.db, "quota:ignav")).toBe(dailyShare(BIG.period, BIG.cap) - 1);
  });

  it("a counter that cannot be read or written means no request (fail closed)", async () => {
    const broken = createRepo(createTestD1());
    const repo: Repo = { ...broken, reserveQuotaUnits: async () => { throw new Error("D1 down"); }, reserveDailyUnits: async () => { throw new Error("D1 down"); } };
    const w = world({ repo });
    const res = await w.check();
    expect(res.status).toBe(503);
    expect(w.fetchFn).not.toHaveBeenCalled();
    // A repo that cannot reserve several units at all is refused the same way.
    const { reserveQuotaUnits: _a, reserveDailyUnits: _b, ...old } = createRepo(createTestD1());
    const legacy = world({ repo: old as Repo });
    expect((await legacy.check()).status).toBe(503);
    expect(legacy.fetchFn).not.toHaveBeenCalled();
  });

  it("the vendor fails on the FIRST request (429, 5xx, timeout, network): the check stops, no second request, no retry", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => json({ error: "Your account has run out of searches." }, 429),
      () => json({ error: "boom" }, 500),
      () => json({ error: "later" }, 503),
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      () => Promise.reject(new TypeError(`fetch failed for https://vendor.test/fares?api_key=${KEY}`)),
    ];
    for (const fail of failures) {
      const fetchFn = vi.fn(async (_url: unknown) => fail());
      const w = world({ fetchFn });
      const res = await w.check();
      expect([res.status, errorOf(res).code]).toEqual([503, "upstream_unavailable"]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await used(w.db)).toBe(2); // both units were reserved up front and are not refunded: it can only overcount
      const text = JSON.stringify(res.body);
      for (const secret of [KEY, "vendor.test", "run out of searches", "boom", "api_key"]) expect(text).not.toContain(secret);
    }
  });

  it("the vendor fails on the SECOND request: 503, exactly two requests, the first answer is not shown alone", async () => {
    const fetchFn = vi.fn(async (url: unknown) => (adultsOf(url) === 1 ? json({ fares: [{ price: 100 }] }) : json({ error: "x" }, 502)));
    const w = world({ fetchFn });
    const res = await w.check();
    expect([res.status, errorOf(res).code]).toEqual([503, "upstream_unavailable"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("no exchange rates: 503 before anything is reserved or requested", async () => {
    const w = world({ fx: async () => { throw new Error("No FX rates available"); } });
    const res = await w.check();
    expect([res.status, errorOf(res).code]).toEqual([503, "fx_unavailable"]);
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(await used(w.db)).toBe(0);
    expect(await daily(w.db, "party:ignav")).toBe(0);
    expect(await daily(w.db, "quota:ignav")).toBe(0);
  });

  it("the check's own daily cap per source: after it, 503 daily_limit with zero requests, until UTC midnight", async () => {
    const w = world();
    const perDay = partyChecksPerDay(BIG);
    expect(perDay).toBe(PARTY_CHECK_MAX_PER_DAY);
    for (let i = 0; i < perDay; i++) expect((await w.check(BODY, { clientKey: `party-client:${i}` })).status).toBe(200);
    const calls = w.fetchFn.mock.calls.length;
    expect(calls).toBe(perDay * PARTY_CHECK_UNITS);
    const res = await w.check(BODY, { clientKey: "party-client:other" });
    expect([res.status, errorOf(res).code]).toEqual([503, "daily_limit"]);
    expect(errorOf(res).retryAfterSec).toBe(15 * 3600); // 09:00 UTC -> midnight
    expect(res.headers).toEqual({ "Retry-After": String(15 * 3600) });
    expect(w.fetchFn.mock.calls.length).toBe(calls);
    expect(await used(w.db)).toBe(perDay * PARTY_CHECK_UNITS);
  });

  it("a series never retries and never sends more requests than it reserved units (the core, directly)", async () => {
    const fetchFn = vi.fn(async () => json({ fares: [{ price: 1 }] }));
    const db = createTestD1();
    const source = createQuoteSource(testAdapter("total"), { key: KEY, repo: createRepo(db), now: NOW, fetchFn: fetchFn as unknown as typeof fetch });
    const q = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", party: { adults: 2 } };
    await expect(source.partySeries!([{ ...q, adults: 1 }, { ...q, adults: 2 }, { ...q, adults: 3 }])).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(await used(db)).toBe(3);
    // A bad query fails before any unit is reserved.
    await expect(source.partySeries!([{ ...q, adults: 1 }, { ...q, adults: 12 }])).rejects.toThrow(RangeError);
    expect(await used(db)).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Not configured: nothing at all.
    const off = createQuoteSource(testAdapter("total"), { key: " ", repo: createRepo(db), now: NOW, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(off.partySeries!([{ ...q, adults: 1 }])).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new QuoteError("http", 429).message).toBe("http"); // the error text is the code only
  });
});

describe("POST /api/party-check: the per-client limit and validation", () => {
  it(`at most ${PARTY_CHECK_RATE_LIMIT_MAX} checks per client per ${PARTY_CHECK_RATE_LIMIT_WINDOW_SECONDS / 60} minutes; the next one is 429 and asks nobody`, async () => {
    const w = world();
    for (let i = 0; i < PARTY_CHECK_RATE_LIMIT_MAX; i++) expect((await w.check()).status).toBe(200);
    const calls = w.fetchFn.mock.calls.length;
    const res = await w.check();
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe("rate_limited");
    expect(errorOf(res).retryAfterSec).toBeGreaterThan(0);
    expect(res.headers?.["Retry-After"]).toBe(String(errorOf(res).retryAfterSec));
    expect(w.fetchFn.mock.calls.length).toBe(calls);
    // Another client is not limited by it.
    expect((await w.check(BODY, { clientKey: "party-client:someone-else" })).status).toBe(200);
  });

  it("the limit also covers bad requests, and a limiter that cannot count answers 503 (fail closed)", async () => {
    const w = world();
    for (let i = 0; i < PARTY_CHECK_RATE_LIMIT_MAX; i++) expect((await w.check({ nonsense: true })).status).toBe(400);
    expect((await w.check()).status).toBe(429);
    const broken: Repo = { ...createRepo(createTestD1()), checkRateLimit: async () => { throw new Error("D1 down"); } };
    const down = world({ repo: broken });
    const res = await down.check();
    expect([res.status, errorOf(res).code]).toEqual([503, "storage_unavailable"]);
    expect(down.fetchFn).not.toHaveBeenCalled();
  });

  it("an invalid body is 400 with every field's code, and nothing is asked", async () => {
    const w = world();
    const res = await w.check({ ...BODY, adults: 1, children: 2 });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({ code: "invalid_request", fieldCodes: { adults: "out_of_range", children: "not_supported" } });
    expect(Object.keys(errorOf(res).fields ?? {}).sort()).toEqual(["adults", "children"]);
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it("the body reader's own refusal (size, type, JSON) is passed through untouched", async () => {
    const w = world();
    const refusal = { status: 413, body: { error: { code: "payload_too_large", message: "x" } } };
    const res = await handlePartyCheck(w.deps, async () => ({ ok: false as const, result: refusal }));
    expect(res).toBe(refusal);
    expect(w.fetchFn).not.toHaveBeenCalled();
  });

  it("runPartyCheck alone (after validation) behaves the same", async () => {
    const w = world();
    const res = await runPartyCheck(w.deps, { ...BODY, token: await tokenFor(fieldsOf(BODY)) });
    expect(res.status).toBe(200);
    expect(w.fetchFn).toHaveBeenCalledTimes(2);
    expect((await runPartyCheck(w.deps, { ...BODY, token: null })).status).toBe(400);
    expect(w.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a malformed token is a 400 field error of the body, like any other field", async () => {
    const w = world();
    for (const token of ["", "v1.x.y", 7, "v2.1790000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
      const res = await w.check({ ...BODY, token }, { clientKey: `party-client:${String(token)}` }, true);
      expect([res.status, errorOf(res).code, errorOf(res).fieldCodes], String(token)).toEqual([400, "invalid_request", { token: "invalid_format" }]);
    }
    expect(w.fetchFn).not.toHaveBeenCalled();
  });
});
