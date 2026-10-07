import { describe, expect, it } from "vitest";
import { createTapPublishedSource } from "../src/sources/tap-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-21T00:00:00Z");
const sourceUrl = "https://www.flytap.com/en_pt/flights-from-tel-aviv-to-lisbon";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "LIS", travelClass: "economy", departureDate: "2027-06-16", returnDate: "2027-06-20", totalPrice: 434.69, currencyCode: "EUR", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "TLV", destination: "LIS", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("TAP public dated fares", () => {
  it("reads the observed June round trip and keeps its original currency", async () => {
    const source = createTapPublishedSource(now, (async () => new Response(html([fare]))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "tap", priceAmount: 434.69, priceCurrency: "EUR", departDate: q.departDate, returnDate: q.returnDate, outbound: { airlines: ["TP"], stops: null }, deeplink: sourceUrl });
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("accepts economy casing but excludes the published executive fare", () => {
    expect(parsePublishedFares(html([fare, { ...fare, travelClass: "ECONOMY" }, { ...fare, travelClass: "executive", totalPrice: 2541.3 }]), { airline: "TP", origin: "TLV", destination: "LIS", sourceUrl, now })).toHaveLength(1);
  });
  it("does not call an unverified route or scale a single-adult price", async () => {
    const source = createTapPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, destination: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
