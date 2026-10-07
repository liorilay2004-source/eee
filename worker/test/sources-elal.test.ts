import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRepo } from "../src/db";
import { QuoteError, quotaSpecIsSafe } from "../src/quotes";
import { defaultResolver } from "../src/pipeline";
import { createElalDealsSource, ELAL_DEALS_QUOTA, elalDealsRouteUrl, parseElalDealsHtml } from "../src/sources/elal-deals";
import { createTestD1 } from "./helpers/d1";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const dealPage = readFileSync("test/fixtures/elal-deals-page.html", "utf8");
const Q = { origin: "TLV", destination: "ATH", departDate: "2026-10-14", returnDate: "2026-10-21", party: { adults: 1 } };
const htmlResponse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

function setup(body = dealPage, status = 200) {
  const db = createTestD1();
  const repo = createRepo(db);
  const fetchFn = vi.fn(async () => htmlResponse(body, status));
  const source = createElalDealsSource({ origin: "TLV", destination: "ATH", resolver: defaultResolver, repo, fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
  return { db, repo, fetchFn, source };
}

describe("EL AL public Flight Deals reader", () => {
  it("routes only to public route pages that are listed in the current EL AL sitemap", () => {
    expect(elalDealsRouteUrl("TLV", "ATH", defaultResolver)).toBe("https://www.elal.com/flight-deals/en-il/flights-from-tel-aviv-to-athens");
    expect(elalDealsRouteUrl("JFK", "TLV", defaultResolver)).toBe("https://www.elal.com/flight-deals/en-il/flights-from-new-york-to-tel-aviv");
    expect(elalDealsRouteUrl("TLV", "CDG", defaultResolver)).toBe("https://www.elal.com/flight-deals/en-il/flights-from-tel-aviv-to-paris");
    expect(elalDealsRouteUrl("LHR", "CDG", defaultResolver)).toBeNull();
    expect(elalDealsRouteUrl("TLV", "ZZZ", defaultResolver)).toBeNull();
  });

  it("parses fare rows and daily prices, while preserving only stated route, date, currency, and price", () => {
    expect(parseElalDealsHtml(dealPage)).toEqual([
      { origin: "TLV", destination: "ATH", departDate: "2027-05-02", returnDate: "2027-05-06", price: 205, currency: "USD" },
      { origin: "TLV", destination: "ATH", departDate: "2026-10-14", returnDate: "2026-10-21", price: 261, currency: "USD" },
    ]);
  });

  it("returns an exact-date offer with unknown times, stops, and bags, and links back to the official source page", async () => {
    const { db, fetchFn, source } = setup();
    expect(source.configured).toBe(true);
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      origin: "TLV", destination: "ATH", departDate: "2026-10-14", returnDate: "2026-10-21",
      priceAmount: 261, priceCurrency: "USD", source: "elal", ticketStructure: "roundtrip",
      outbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] },
      inbound: { departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: ["LY"] },
      includes: {}, deeplink: null, verifyLink: "https://www.elal.com/flight-deals/en-il/flights-from-tel-aviv-to-athens",
      checkedAt: NOW.toISOString(),
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.elal.com/flight-deals/en-il/flights-from-tel-aviv-to-athens");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init.body).toBeUndefined();
    expect(await db.prepare("SELECT source, period, used FROM source_quota").all()).toMatchObject({ results: [{ source: "elal", period: "2026-10", used: 1 }] });
  });

  it("shares one bounded route-page request across concurrent date-pair calls and never turns another date into a match", async () => {
    const { fetchFn, source } = setup();
    const [a, b] = await Promise.all([source.quote(Q), source.quote({ ...Q, departDate: "2026-10-15", returnDate: "2026-10-22" })]);
    expect(a.map((o) => o.priceAmount)).toEqual([261]);
    expect(b).toEqual([]);
    expect(source.callCount()).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(source.nextQuoteRequests?.()).toBe(0);
  });

  it("has a small local request budget and fails closed if counters cannot be reserved", async () => {
    expect(ELAL_DEALS_QUOTA.localBudget).toBe(true);
    expect(quotaSpecIsSafe(ELAL_DEALS_QUOTA)).toBe(true);
    const db = createTestD1();
    const repo = createRepo(db);
    await db.prepare("INSERT INTO source_quota (source, period, used, updated_at) VALUES ('elal', '2026-10', 100, ?)").bind(NOW.toISOString()).run();
    const fetchFn = vi.fn(async () => htmlResponse(dealPage));
    const source = createElalDealsSource({ origin: "TLV", destination: "ATH", resolver: defaultResolver, repo, fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    await expect(source.quote(Q)).rejects.toMatchObject({ code: "quota_exhausted" });
    expect(fetchFn).not.toHaveBeenCalled();

    const noCounters = createTestD1();
    await noCounters.exec("DROP TABLE source_quota");
    const unavailable = createElalDealsSource({ origin: "TLV", destination: "ATH", resolver: defaultResolver, repo: createRepo(noCounters), fetchFn: fetchFn as unknown as typeof fetch, now: NOW });
    await expect(unavailable.quote(Q)).rejects.toBeInstanceOf(QuoteError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("marks explicit access blocks and malformed page schemas without retrying or breaking the source contract", async () => {
    const blocked = setup("<html><body>Verify you are human</body></html>");
    await expect(blocked.source.quote(Q)).rejects.toMatchObject({ code: "blocked" });
    expect(blocked.fetchFn).toHaveBeenCalledTimes(1);
    const link11 = setup("", 492);
    await expect(link11.source.quote(Q)).rejects.toMatchObject({ code: "blocked", status: 492 });
    expect(link11.fetchFn).toHaveBeenCalledTimes(1);
    const unauthorized = setup("", 401);
    await expect(unauthorized.source.quote(Q)).rejects.toMatchObject({ code: "blocked", status: 401 });
    expect(unauthorized.fetchFn).toHaveBeenCalledTimes(1);
    const malformed = setup("<html><body>Flights From Tel Aviv To Athens</body></html>");
    await expect(malformed.source.quote(Q)).rejects.toMatchObject({ code: "response" });
    expect(malformed.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not parse a page that changes the passenger, cabin, tax, or freshness disclaimer", () => {
    expect(() => parseElalDealsHtml(dealPage.replace("1 passenger (1 adult)", "2 passengers (2 adults)"))).toThrow(QuoteError);
    expect(() => parseElalDealsHtml(dealPage.replace("inclusive of tax and surcharges", "excluding taxes"))).toThrow(QuoteError);
  });
});
