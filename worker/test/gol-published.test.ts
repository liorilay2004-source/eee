import { describe, expect, it, vi } from "vitest";
import { createGolPublishedSource } from "../src/sources/gol-published";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename: "Fare", originAirportCode: "GRU", destinationAirportCode: "MCZ", departureDate: "2026-12-09", returnDate: "2026-12-16", totalPrice: 341.23, currencyCode: "USD", travelClass: "Economy", flightType: "ROUND_TRIP" };
const q = { origin: "GRU", destination: "MCZ", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("GOL mixed-airport official page", () => {
  it("preserves actual airports across a shared page cache", async () => {
    const fetchFn = vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare, { ...fare, originAirportCode: "CGH", totalPrice: 99 }, { ...fare, originAirportCode: "GIG", totalPrice: 1 }] })}</script>`)) as unknown as typeof fetch;
    const source = createGolPublishedSource(now, fetchFn);
    const gru = await source.quote(q); const cgh = await source.quote({ ...q, origin: "CGH" });
    expect(gru).toHaveLength(1); expect(gru[0]).toMatchObject({ origin: "GRU", source: "gol", priceAmount: 341.23 });
    expect(cgh).toHaveLength(1); expect(cgh[0]).toMatchObject({ origin: "CGH", priceAmount: 99 });
    expect(await source.quote({ ...q, origin: "GIG" })).toEqual([]);
    expect(await source.quote({ ...q, returnDate: "2026-12-17" })).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("does not request unsupported group prices", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await createGolPublishedSource(now, fetchFn).quote({ ...q, party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
