import { describe, expect, it } from "vitest";
import { createAirEuropaPublishedSource } from "../src/sources/aireuropa-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-21T00:00:00Z");
const sourceUrl = "https://www.aireuropa.com/en-il/flight-deals-from-tel-aviv-to-spain";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "MAD", travelClass: "economy", departureDate: "2026-12-22", returnDate: "2026-12-29", totalPrice: 276.37, currencyCode: "USD", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "TLV", destination: "MAD", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Air Europa public dated fares", () => {
  it("reads the observed December round trip and keeps its original currency", async () => {
    const source = createAirEuropaPublishedSource(now, (async () => new Response(html([fare]))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "air_europa", priceAmount: 276.37, priceCurrency: "USD", departDate: q.departDate, returnDate: q.returnDate, outbound: { airlines: ["UX"], stops: null }, deeplink: sourceUrl });
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("accepts economy casing but excludes the published executive fare", () => {
    expect(parsePublishedFares(html([fare, { ...fare, travelClass: "ECONOMY" }, { ...fare, travelClass: "executive", totalPrice: 2541.3 }]), { airline: "UX", origin: "TLV", destination: "MAD", sourceUrl, now })).toHaveLength(1);
  });
  it("does not call an unverified route or scale a single-adult price", async () => {
    const source = createAirEuropaPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
