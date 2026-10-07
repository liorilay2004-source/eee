import { describe, expect, it } from "vitest";
import { createPhilippinePublishedSource } from "../src/sources/philippine-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-21T00:00:00Z");
const sourceUrl = "https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok";
const fare = { __typename: "Fare", originAirportCode: "MNL", destinationAirportCode: "BKK", travelClass: "eco", departureDate: "2026-11-17", returnDate: "2026-11-20", totalPrice: 311.9, currencyCode: "USD", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "MNL", destination: "BKK", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Philippine Airlines public dated fares", () => {
  it("reads the observed November round trip and keeps its original currency", async () => {
    const source = createPhilippinePublishedSource(now, (async () => new Response(html([fare]))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "philippine", priceAmount: 311.9, priceCurrency: "USD", departDate: q.departDate, returnDate: q.returnDate, outbound: { airlines: ["PR"], stops: null }, deeplink: sourceUrl });
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("accepts economy casing but excludes the published executive fare", () => {
    expect(parsePublishedFares(html([fare, { ...fare, travelClass: "ECONOMY" }, { ...fare, travelClass: "executive", totalPrice: 2541.3 }]), { airline: "PR", origin: "MNL", destination: "BKK", sourceUrl, now })).toHaveLength(1);
  });
  it("does not call an unverified route or scale a single-adult price", async () => {
    const source = createPhilippinePublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, destination: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
