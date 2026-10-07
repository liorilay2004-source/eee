import { describe, expect, it } from "vitest";
import { createVirginPublishedSource } from "../src/sources/virgin-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-21T00:00:00Z");
const sourceUrl = "https://flights.virginatlantic.com/en-il/flights-from-tel-aviv";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "JFK", travelClass: "Economy Classic Flex", departureDate: "2027-02-23", returnDate: "2027-03-01", totalPrice: 892.37, currencyCode: "USD", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "TLV", destination: "JFK", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Virgin Atlantic public dated fares", () => {
  it("reads the observed February round trip and keeps its original currency", async () => {
    const source = createVirginPublishedSource(now, (async () => new Response(html([fare]))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "virgin_atlantic", priceAmount: 892.37, priceCurrency: "USD", departDate: q.departDate, returnDate: q.returnDate, outbound: { airlines: ["VS"], stops: null }, deeplink: sourceUrl });
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("accepts economy casing but excludes the published executive fare", () => {
    expect(parsePublishedFares(html([fare, { ...fare, travelClass: "ECONOMY" }, { ...fare, travelClass: "executive", totalPrice: 2541.3 }]), { airline: "VS", origin: "TLV", destination: "JFK", sourceUrl, now })).toHaveLength(1);
  });
  it("does not call an unverified route or scale a single-adult price", async () => {
    const source = createVirginPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
  it("keeps all observed destinations distinct and excludes premium cabins", () => {
    const fares = parsePublishedFares(html([fare, { ...fare, destinationAirportCode: "MIA", totalPrice: 921.57 }, { ...fare, travelClass: "Economy Classic", totalPrice: 900 }, { ...fare, travelClass: "Premium", totalPrice: 3531.96 }, { ...fare, travelClass: "Upper Class", totalPrice: 9714.96 }]), { airline: "VS", origin: "TLV", destination: "JFK", sourceUrl, now, allDestinations: true });
    expect(fares).toHaveLength(3);
    expect(fares.filter(f => f.destination === "MIA")).toMatchObject([{ amount: 921.57 }]);
    expect(fares.every(f => f.amount < 1000)).toBe(true);
  });
  it("does not treat Virgin cabin names as economy on another airline", () => {
    expect(parsePublishedFares(html([fare]), { airline: "TP", origin: "TLV", destination: "JFK", sourceUrl: "https://www.flytap.com/en_pt/flights-from-tel-aviv-to-lisbon", now })).toEqual([]);
  });
});
