import { describe, expect, it, vi } from "vitest";
import { createSkyExpressPublishedSource } from "../src/sources/skyexpress-published";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename: "Fare", originAirportCode: "ATH", destinationAirportCode: "FCO", departureDate: "2026-12-13", returnDate: "2026-12-18", totalPrice: 102, currencyCode: "EUR", travelClass: "ECONOMY", flightType: "ROUND_TRIP" };
const q = { origin: "ATH", destination: "FCO", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("SKY express official advertisements", () => {
  it("matches exact dates, rejects business and redemption fares, and reuses the page", async () => {
    const fetchFn = vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare, { ...fare, totalPrice: 5, travelClass: "BUSINESS" }, { ...fare, totalPrice: 1, redemption: true }] })}</script>`)) as unknown as typeof fetch;
    const source = createSkyExpressPublishedSource(now, fetchFn);
    const offers = await source.quote(q);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ source: "sky_express", priceAmount: 102, priceCurrency: "EUR", outbound: { airlines: ["GQ"] } });
    expect(await source.quote({ ...q, returnDate: "2026-12-19" })).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(source.nextQuoteRequests?.(q)).toBe(0);
  });
  it("does not multiply an adult advertisement into a group price", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await createSkyExpressPublishedSource(now, fetchFn).quote({ ...q, party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
