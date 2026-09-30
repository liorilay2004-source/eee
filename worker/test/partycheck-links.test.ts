/**
 * "Book together or one by one?", the FREE part (src/partycheck.ts cardPartyCheck + the pipeline's card field and meta flag).
 * Nothing here calls anything: the links are the card's own Aviasales links, pointed at one adult and at the whole group.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepo } from "../src/db";
import {
  cardPartyCheck,
  PARTY_CHECK_MAX_PER_DAY,
  partyCheckFields,
  partyCheckMeta,
  partyCheckMetaNow,
  partyCheckRoom,
  signedPartyCheckFields,
  signPartyToken,
  verifyPartyToken,
} from "../src/partycheck";
import { runSearch, type SearchDeps } from "../src/pipeline";
import { createQuoteSource, dailyShare, type FareQuoteSource, type QuoteAdapter, type QuotaSpec } from "../src/quotes";
import { createWegoSource } from "../src/sources/wego";
import { partySizedLink, withPartySize } from "../src/travelpayouts";
import type { FxRates, Leg, Offer, OneWayFare, PartyCheckLinks, Repo, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };
const RT = "https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=m";
const OW_OUT = "https://www.aviasales.com/search/TLV1211BCN1?marker=m";
const OW_BACK = "https://www.aviasales.com/search/BCN1811TLV1?marker=m";

const leg = (over: Partial<Leg> = {}): Leg => ({ departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over });

function offer(price: number, over: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: price, priceCurrency: "USD",
    source: "travelpayouts", ticketStructure: "roundtrip", outbound: leg(), inbound: leg({ departTime: "18:00" }), includes: {},
    deeplink: RT, verifyLink: null, checkedAt: NOW.toISOString(), extrasAmountIls: 0, totalIls: null, tags: [], ...over,
  };
}

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7, adults: 1, children: 0, infants: 0,
    cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false, ...over,
  };
}

function mockTp(rt: Offer[], ow: (o: string) => OneWayFare[] = () => []): TravelpayoutsClient {
  let calls = 0;
  return {
    configured: true,
    callCount: () => calls,
    async roundTrips(o, d) {
      calls += 1;
      return o === "TLV" && d === "BCN" ? rt.map((x) => structuredClone(x)) : [];
    },
    async oneWays(o, d) {
      calls += 1;
      return (o === "TLV" && d === "BCN") || (o === "BCN" && d === "TLV") ? ow(o).map((x) => structuredClone(x)) : [];
    },
  };
}

function run(rt: Offer[], r: SearchRequest, over: Partial<SearchDeps> = {}, ow?: (o: string) => OneWayFare[]) {
  const repo = createRepo(createTestD1());
  return runSearch({ repo, tp: mockTp(rt, ow), fx: vi.fn(async () => FX), now: NOW, ...over }, r);
}

/** A stand-in live source: never asked in these tests (no fetch), only looked at. */
function source(name: "ignav" | "serpapi", pricing: QuoteAdapter["partyPricing"], quota: QuotaSpec = { period: "lifetime", cap: 900, allowance: 1000 }): FareQuoteSource {
  const adapter: QuoteAdapter = { name, quota, partyPricing: pricing, request: () => ({ url: "https://vendor.test/", headers: {} }), parse: () => [] };
  return createQuoteSource(adapter, { key: "k", repo: createRepo(createTestD1()), now: NOW, fetchFn: (() => { throw new Error("no fetch in this test"); }) as unknown as typeof fetch });
}

describe("partySizedLink: a card link pointed at a party, or nothing", () => {
  it("rewrites the passenger code of a round-trip and a one-way search link, keeping the ticket id and the marker", () => {
    expect(partySizedLink(RT, { adults: 1 })).toBe("https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=m");
    expect(partySizedLink(RT, { adults: 2 })).toBe("https://www.aviasales.com/search/TLV1211BCN18112?t=W6_example&marker=m");
    expect(partySizedLink(RT, { adults: 9 })).toBe("https://www.aviasales.com/search/TLV1211BCN18119?t=W6_example&marker=m");
    expect(partySizedLink(OW_OUT, { adults: 3 })).toBe("https://www.aviasales.com/search/TLV1211BCN3?marker=m");
    expect(partySizedLink("https://www.aviasales.com/search/TLV1211BCN18112", { adults: 1 })).toBe("https://www.aviasales.com/search/TLV1211BCN18111");
  });

  it("gives null, never a made-up link, for anything that is not a recognisable Aviasales search link", () => {
    for (const link of [
      null,
      undefined,
      "",
      "https://example.com/book?id=7",
      "https://www.aviasales.com/", // no search path
      "https://www.aviasales.com/search/TLV1211BCN18111111", // too many digits to read
      "http://www.aviasales.com/search/TLV1211BCN18111", // not https
      "https://aviasales.evil.test/search/TLV1211BCN18111",
      "https://affiliate-api.wego.com/handoff?x=1",
    ]) {
      expect(partySizedLink(link, { adults: 2 }), String(link)).toBeNull();
    }
  });

  it("gives null for an impossible party instead of throwing, while withPartySize keeps its old behaviour", () => {
    expect(partySizedLink(RT, { adults: 0 })).toBeNull();
    expect(partySizedLink(RT, { adults: 10 })).toBeNull();
    expect(() => withPartySize(RT, { adults: 0 })).toThrow(RangeError);
    expect(withPartySize("https://example.com/book?id=7", { adults: 3 })).toBe("https://example.com/book?id=7");
    expect(withPartySize(null, { adults: 3 })).toBeNull();
  });
});

describe("cardPartyCheck: which card gets which box", () => {
  it("one adult: no field at all", () => {
    expect(cardPartyCheck(offer(100), { adults: 1, children: 0, infants: 0 })).toBeNull();
    expect(partyCheckFields(offer(100), { adults: 1, children: 0, infants: 0 })).toEqual({});
    expect(Object.keys(partyCheckFields(offer(100), { adults: 1, children: 2, infants: 0 }))).toEqual([]);
  });

  it("2+ adults: the card's own link for ONE adult and for the whole group", () => {
    expect(cardPartyCheck(offer(100), { adults: 2, children: 0, infants: 0 })).toEqual({
      adults: 2,
      singleLink: "https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=m",
      partyLink: "https://www.aviasales.com/search/TLV1211BCN18112?t=W6_example&marker=m",
    });
    const three = cardPartyCheck(offer(100), { adults: 3, children: 0, infants: 0 }) as PartyCheckLinks;
    expect(three.partyLink).toBe("https://www.aviasales.com/search/TLV1211BCN18113?t=W6_example&marker=m");
    expect(three).not.toHaveProperty("returnSingleLink");
  });

  it("children or infants: only the reason, no links (they must stay in a booking with an adult)", () => {
    expect(cardPartyCheck(offer(100), { adults: 2, children: 1, infants: 0 })).toEqual({ adults: 2, reason: "children" });
    expect(cardPartyCheck(offer(100), { adults: 2, children: 0, infants: 1 })).toEqual({ adults: 2, reason: "children" });
    expect(cardPartyCheck(offer(100, { deeplink: null }), { adults: 3, children: 2, infants: 1 })).toEqual({ adults: 3, reason: "children" });
  });

  it("a link that is not a recognisable Aviasales search link (Wego's handoff, none, junk): no party check", () => {
    for (const deeplink of ["https://affiliate-api.wego.com/handoff?fare=1", "https://example.com/book?id=7", null, ""]) {
      expect(cardPartyCheck(offer(100, { deeplink }), { adults: 2, children: 0, infants: 0 }), String(deeplink)).toBeNull();
      expect(partyCheckFields(offer(100, { deeplink }), { adults: 2, children: 0, infants: 0 })).toEqual({});
    }
    // A verify link is not the card's booking link: nothing is built from it.
    expect(cardPartyCheck(offer(100, { deeplink: null, verifyLink: RT }), { adults: 2, children: 0, infants: 0 })).toBeNull();
  });

  it("a split ticket: both one-ways, or nothing when one half cannot be compared", () => {
    const split = offer(100, { ticketStructure: "split", deeplink: OW_OUT, returnDeeplink: OW_BACK });
    expect(cardPartyCheck(split, { adults: 2, children: 0, infants: 0 })).toEqual({
      adults: 2,
      singleLink: "https://www.aviasales.com/search/TLV1211BCN1?marker=m",
      partyLink: "https://www.aviasales.com/search/TLV1211BCN2?marker=m",
      returnSingleLink: "https://www.aviasales.com/search/BCN1811TLV1?marker=m",
      returnPartyLink: "https://www.aviasales.com/search/BCN1811TLV2?marker=m",
    });
    expect(cardPartyCheck({ ...split, returnDeeplink: null }, { adults: 2, children: 0, infants: 0 })).toBeNull();
    expect(cardPartyCheck({ ...split, returnDeeplink: "https://example.com/x" }, { adults: 2, children: 0, infants: 0 })).toBeNull();
  });
});

describe("the search answer", () => {
  it("2 adults: every card carries both links, the group link being the card's own booking link", async () => {
    const res = await run([offer(200), offer(260, { departDate: "2026-11-13", returnDate: "2026-11-19", deeplink: "https://www.aviasales.com/search/TLV1311BCN19111?marker=m" })], req({ adults: 2 }));
    expect(res.cards.length).toBeGreaterThan(0);
    for (const card of res.cards) {
      const check = card.partyCheck as PartyCheckLinks;
      expect(check.adults).toBe(2);
      expect(check.partyLink).toBe(card.offer.deeplink); // already pointed at the whole party by the pipeline
      expect(check.singleLink).toBe(partySizedLink(card.offer.deeplink, { adults: 1 }));
      expect(check.singleLink).toMatch(/^https:\/\/www\.aviasales\.com\/search\/TLV\d{4}BCN\d{4}1(\?|$)/);
    }
    expect(res.meta.partyCheck).toEqual({ available: false }); // no live source configured
  });

  it("1 adult: no partyCheck on any card and none in meta: the answer is exactly what it was", async () => {
    const res = await run([offer(200)], req());
    for (const card of res.cards) expect(Object.keys(card)).not.toContain("partyCheck");
    expect(Object.keys(res.meta)).not.toContain("partyCheck");
  });

  it("with children: every card explains why, and the live check is never offered", async () => {
    const res = await run([offer(200)], req({ adults: 2, children: 1 }), { quoteSources: [source("ignav", "total")] });
    for (const card of res.cards) expect(card.partyCheck).toEqual({ adults: 2, reason: "children" });
    expect(res.meta.partyCheck).toEqual({ available: false });
  });

  it("a card whose link cannot be rewritten gets no party check (a link is never made up)", async () => {
    const res = await run([offer(100, { deeplink: "https://example.com/book?id=7" })], req({ adults: 3 }));
    expect(res.cards[0]?.offer.deeplink).toBe("https://example.com/book?id=7");
    expect(res.cards[0]).not.toHaveProperty("partyCheck");
  });

  it("a split ticket card carries the pair for both one-ways", async () => {
    const ow = (o: string): OneWayFare[] => [
      { date: o === "TLV" ? "2026-11-12" : "2026-11-18", priceAmount: 40, priceCurrency: "USD", leg: leg({ airlines: ["W6"] }), deeplink: o === "TLV" ? OW_OUT : OW_BACK },
    ];
    const res = await run([offer(500)], req({ adults: 2 }), {}, ow);
    const split = res.cards.find((c) => c.offer.ticketStructure === "split");
    expect(split?.partyCheck).toEqual({
      adults: 2,
      singleLink: "https://www.aviasales.com/search/TLV1211BCN1?marker=m",
      partyLink: "https://www.aviasales.com/search/TLV1211BCN2?marker=m",
      returnSingleLink: "https://www.aviasales.com/search/BCN1811TLV1?marker=m",
      returnPartyLink: "https://www.aviasales.com/search/BCN1811TLV2?marker=m",
    });
  });

  it("a cache hit carries the same party check", async () => {
    const repo = createRepo(createTestD1());
    const deps: SearchDeps = { repo, tp: mockTp([offer(200)]), fx: vi.fn(async () => FX), now: NOW };
    const first = await runSearch(deps, req({ adults: 2 }));
    const hit = await runSearch(deps, req({ adults: 2 }));
    expect(hit.meta.fromCache).toBe(true);
    expect(hit.cards.map((c) => c.partyCheck)).toEqual(first.cards.map((c) => c.partyCheck));
  });
});

describe("meta.partyCheck.available: true only when a configured source may run the live check", () => {
  const two = { adults: 2, children: 0, infants: 0 };

  it("absent below 2 adults, false without sources", () => {
    expect(partyCheckMeta({ adults: 1, children: 0, infants: 0 }, [source("ignav", "total")])).toEqual({});
    expect(partyCheckMeta(two, [])).toEqual({ partyCheck: { available: false } });
  });

  it("true for a source whose multi-adult price can be read and whose daily share fits a check", () => {
    expect(partyCheckMeta(two, [source("ignav", "total")])).toEqual({ partyCheck: { available: true } });
    expect(partyCheckMeta(two, [source("serpapi", "per_person")])).toEqual({ partyCheck: { available: true } });
  });

  it("false for a source whose docs do not say (unknown or unset), and false with children or infants", () => {
    expect(partyCheckMeta(two, [source("ignav", "unknown")])).toEqual({ partyCheck: { available: false } });
    expect(partyCheckMeta(two, [source("ignav", undefined)])).toEqual({ partyCheck: { available: false } });
    expect(partyCheckMeta({ adults: 2, children: 1, infants: 0 }, [source("ignav", "total")])).toEqual({ partyCheck: { available: false } });
    expect(partyCheckMeta({ adults: 2, children: 0, infants: 1 }, [source("ignav", "total")])).toEqual({ partyCheck: { available: false } });
  });

  it("false for a source whose multi-adult price is read but whose daily share cannot fit a two-request check (Wego today: 1 request a day)", () => {
    const wego = createWegoSource({ apiKey: "client", repo: createRepo(createTestD1()), now: NOW, fetchFn: (() => { throw new Error("no fetch"); }) as unknown as typeof fetch });
    expect(wego.partyPricing).toBe("total");
    expect(partyCheckMeta(two, [wego])).toEqual({ partyCheck: { available: false } });
    // A small cap is the same: 50 one-off = 2 requests a day, and a check may use at most half of it.
    expect(partyCheckMeta(two, [source("ignav", "total", { period: "lifetime", cap: 50, allowance: 100 })])).toEqual({ partyCheck: { available: false } });
  });

  it("the search answer says true when such a source is configured (the check itself only runs when the user asks)", async () => {
    const live = source("ignav", "total");
    const res = await run([offer(200)], req({ adults: 2 }), { quoteSources: [live] });
    expect(res.meta.partyCheck).toEqual({ available: true });
  });
});

describe("meta.partyCheck.available in a search answer also needs ROOM for a check right now (partyCheckMetaNow)", () => {
  const two = { adults: 2, children: 0, infants: 0 };
  const BIG: QuotaSpec = { period: "lifetime", cap: 900, allowance: 1000 };
  const DAY = Date.parse("2026-11-01T00:00:00.000Z") / 1000;
  const seed = async (db: D1Database, used: number, share: number, checks: number) => {
    await db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('ignav', 'lifetime', ?, ?)").bind(used, NOW.toISOString()).run();
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('quota:ignav', ?, ?)").bind(DAY, share).run();
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('party:ignav', ?, ?)").bind(DAY, checks).run();
  };
  const now = async (db: D1Database) => partyCheckMetaNow(two, [source("ignav", "total", BIG)], { repo: createRepo(db), now: NOW });

  it("true with room: 2 units under the cap, 2 in today's share and a slot of the day's checks", async () => {
    const db = createTestD1();
    expect(await now(db)).toEqual({ partyCheck: { available: true } });
    await seed(db, BIG.cap - 2, dailyShare("lifetime", BIG.cap) - 2, PARTY_CHECK_MAX_PER_DAY - 1);
    expect(await now(db)).toEqual({ partyCheck: { available: true } });
  });

  it("false once the cap has fewer than 2 units left (a one-off cap never comes back: the button would only fail)", async () => {
    const db = createTestD1();
    await seed(db, BIG.cap - 1, 0, 0);
    expect(await now(db)).toEqual({ partyCheck: { available: false } });
  });

  it("false once today's share has fewer than 2 units left, or today's checks are used up", async () => {
    const shareDb = createTestD1();
    await seed(shareDb, 0, dailyShare("lifetime", BIG.cap) - 1, 0);
    expect(await now(shareDb)).toEqual({ partyCheck: { available: false } });
    const checksDb = createTestD1();
    await seed(checksDb, 0, 0, PARTY_CHECK_MAX_PER_DAY);
    expect(await now(checksDb)).toEqual({ partyCheck: { available: false } });
    // Yesterday's counts do not matter.
    const old = createTestD1();
    await old.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('party:ignav', ?, ?)").bind(DAY - 86_400, 99).run();
    expect(await now(old)).toEqual({ partyCheck: { available: true } });
  });

  it("fails closed: counters that cannot be read, or a repo that cannot read them, mean no button", async () => {
    const live = source("ignav", "total", BIG);
    const broken: Pick<Repo, "readAllowance"> = { readAllowance: async () => { throw new Error("D1 down"); } };
    expect(await partyCheckRoom(live, { repo: broken, now: NOW })).toBe(false);
    expect(await partyCheckRoom(live, { repo: {}, now: NOW })).toBe(false);
    const odd: Pick<Repo, "readAllowance"> = { readAllowance: async () => ({ used: -1, daily: {} }) };
    expect(await partyCheckRoom(live, { repo: odd, now: NOW })).toBe(false);
    const noTable = createTestD1();
    await noTable.exec("DROP TABLE source_quota");
    expect(await partyCheckMetaNow(two, [live], { repo: createRepo(noTable), now: NOW })).toEqual({ partyCheck: { available: false } });
  });

  it("reads nothing when no capable source is configured, and never for one adult", async () => {
    let reads = 0;
    const counting: Pick<Repo, "readAllowance"> = { readAllowance: async () => { reads += 1; return { used: 0, daily: {} }; } };
    expect(await partyCheckMetaNow(two, [source("ignav", "unknown")], { repo: counting, now: NOW })).toEqual({ partyCheck: { available: false } });
    expect(await partyCheckMetaNow({ adults: 1, children: 0, infants: 0 }, [source("ignav", "total")], { repo: counting, now: NOW })).toEqual({});
    expect(await partyCheckMetaNow({ adults: 2, children: 1, infants: 0 }, [source("ignav", "total")], { repo: counting, now: NOW })).toEqual({ partyCheck: { available: false } });
    expect(reads).toBe(0);
  });

  it("readAllowance reads the counters without reserving anything; odd input is refused", async () => {
    const db = createTestD1();
    const repo = createRepo(db);
    expect(await repo.readAllowance!("ignav", "lifetime", ["quota:ignav", "party:ignav"], NOW)).toEqual({ used: 0, daily: { "quota:ignav": 0, "party:ignav": 0 } });
    await seed(db, 7, 3, 1);
    expect(await repo.readAllowance!("ignav", "lifetime", ["quota:ignav", "party:ignav"], NOW)).toEqual({ used: 7, daily: { "quota:ignav": 3, "party:ignav": 1 } });
    expect(await repo.readAllowance!("ignav", "lifetime", ["quota:ignav", "party:ignav"], NOW)).toEqual({ used: 7, daily: { "quota:ignav": 3, "party:ignav": 1 } }); // unchanged by reading
    await expect(repo.readAllowance!("ignav", "forever", [], NOW)).rejects.toThrow();
    await expect(repo.readAllowance!("ignav", "lifetime", ["search:abc"], NOW)).rejects.toThrow();
  });
});

describe("the card token: only when the live check can run, only on round-trip cards with links", () => {
  const SECRET = "salt-for-tests";
  const sign = (f: Parameters<typeof signPartyToken>[1]) => signPartyToken(SECRET, f, NOW);

  it("a search that can run the check signs every round-trip card for exactly its route, dates and adults", async () => {
    const live = source("ignav", "total");
    const res = await run([offer(200), offer(260, { departDate: "2026-11-13", returnDate: "2026-11-19", deeplink: "https://www.aviasales.com/search/TLV1311BCN19111?marker=m" })], req({ adults: 2 }), { quoteSources: [live], partyToken: sign });
    expect(res.meta.partyCheck).toEqual({ available: true });
    const roundTrips = res.cards.filter((c) => c.offer.ticketStructure === "roundtrip");
    expect(roundTrips.length).toBeGreaterThan(0);
    for (const card of roundTrips) {
      const check = card.partyCheck as PartyCheckLinks;
      expect(check.token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
      const fields = { origin: card.offer.origin, destination: card.offer.destination, departDate: card.offer.departDate, returnDate: card.offer.returnDate, adults: 2 };
      expect(await verifyPartyToken(SECRET, check.token as string, fields, NOW)).toBe("ok");
      expect(await verifyPartyToken(SECRET, check.token as string, { ...fields, adults: 3 }, NOW)).toBe("invalid");
    }
  });

  it("no token when the check cannot run (no capable source, no room, children), without a signer, or on a split ticket", async () => {
    const noSource = await run([offer(200)], req({ adults: 2 }), { partyToken: sign });
    expect(noSource.meta.partyCheck).toEqual({ available: false });
    for (const card of noSource.cards) expect(card.partyCheck).not.toHaveProperty("token");
    const noSigner = await run([offer(200)], req({ adults: 2 }), { quoteSources: [source("ignav", "total")] });
    expect(noSigner.meta.partyCheck).toEqual({ available: true });
    for (const card of noSigner.cards) expect(card.partyCheck).not.toHaveProperty("token");
    const kids = await run([offer(200)], req({ adults: 2, children: 1 }), { quoteSources: [source("ignav", "total")], partyToken: sign });
    for (const card of kids.cards) expect(card.partyCheck).toEqual({ adults: 2, reason: "children" });
    const one = await run([offer(200)], req(), { quoteSources: [source("ignav", "total")], partyToken: sign });
    expect(JSON.stringify(one)).not.toContain("partyCheck");
    const split = offer(100, { ticketStructure: "split", deeplink: OW_OUT, returnDeeplink: OW_BACK });
    expect(await signedPartyCheckFields(split, { adults: 2, children: 0, infants: 0 }, sign)).toEqual(partyCheckFields(split, { adults: 2, children: 0, infants: 0 }));
  });

  it("a signer that fails or returns nothing usable leaves the card without a token (its links stay)", async () => {
    const pax = { adults: 2, children: 0, infants: 0 };
    const plain = partyCheckFields(offer(100), pax);
    expect(await signedPartyCheckFields(offer(100), pax, async () => { throw new Error("no crypto"); })).toEqual(plain);
    expect(await signedPartyCheckFields(offer(100), pax, async () => null)).toEqual(plain);
    expect(await signedPartyCheckFields(offer(100), pax, async () => "not a token")).toEqual(plain);
    expect(await signedPartyCheckFields(offer(100, { deeplink: "https://example.com/x" }), pax, sign)).toEqual({});
  });

  it("signPartyToken refuses to sign without a secret", async () => {
    await expect(signPartyToken("", { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", adults: 2 }, NOW)).rejects.toThrow();
  });
});
