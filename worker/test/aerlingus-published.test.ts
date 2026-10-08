import { describe, expect, it, vi } from "vitest";
import { createAerLingusPublishedSource } from "../src/sources/aerlingus-published";
import { createDirectCombinationSource } from "../src/sources/direct-combination";
import type { FareQuoteSource } from "../src/quotes";
const now = new Date("2026-10-08T00:00:00Z");
const q = { origin: "DUB", destination: "AMS", departDate: "2027-01-26", returnDate: "2027-01-29", party: { adults: 1, children: 0, infants: 0 } };
const fare = { __typename: "Fare", originAirportCode: "DUB", destinationAirportCode: "AMS", departureDate: q.departDate, returnDate: "", totalPrice: 41.45, currencyCode: "EUR", travelClass: "low", flightType: "ONE_WAY" };
describe("Aer Lingus dated fares in combination search", () => {
  it("exposes exact one-way fare, reuses cached page and never invents a return", async () => {
    const fetchFn = vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare, { ...fare, flightType: "ROUND_TRIP", returnDate: q.returnDate, totalPrice: 1 }] })}</script>`)) as unknown as typeof fetch;
    const source = createAerLingusPublishedSource(now, fetchFn);
    expect(await source.quote(q)).toEqual([]);
    const oneWays = await source.oneWays!(q);
    expect(oneWays).toMatchObject([{ airline: "EI", origin: "DUB", destination: "AMS", amount: 41.45 }]);
    const returnSource = { name: "ryanair", configured: true, callCount: () => 0, quota: { period: "monthly", cap: 0, allowance: 0 }, quote: async () => [], oneWays: async () => [{ source: "ryanair", airline: "FR", origin: "AMS", destination: "DUB", date: q.returnDate, amount: 30, currency: "EUR", bookingUrl: "https://www.ryanair.com/", checkedAt: now.toISOString() }] } as FareQuoteSource;
    const combination = await createDirectCombinationSource([source, returnSource]).quote(q);
    expect(combination).toMatchObject([{ source: "direct_combination", priceAmount: 71.45, ticketStructure: "split" }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("does not fetch unsupported group prices", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await createAerLingusPublishedSource(now, fetchFn).oneWays!({ ...q, party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
