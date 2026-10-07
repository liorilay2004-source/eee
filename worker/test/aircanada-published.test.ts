import { describe, expect, it } from "vitest";
import { createAirCanadaPublishedSource } from "../src/sources/aircanada-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-20T00:00:00Z");
const url = "https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "YYZ", travelClass: "ECONOMY", departureDate: "2027-03-01", returnDate: "2027-03-31", totalPrice: 1009, currencyCode: "CAD", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "TLV", destination: "YYZ", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Air Canada official published prices", () => {
  it("returns the observed cash economy fare only on the published exact dates", async () => {
    const source = createAirCanadaPublishedSource(now, (async () => new Response(html([fare]))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "air_canada", priceAmount: 1009, priceCurrency: "CAD", ticketStructure: "roundtrip", outbound: { airlines: ["AC"], departTime: null }, deeplink: url });
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("does not copy point-redemption fares, business fares or headline prices", () => {
    expect(parsePublishedFares(html([{ ...fare, redemption: true }, { ...fare, travelClass: "BUSINESS" }, { __typename: "Fare", totalPrice: 999, currencyCode: "CAD" }]), { airline: "AC", origin: "TLV", destination: "YYZ", sourceUrl: url, now })).toEqual([]);
  });
  it("never scales a one-adult advertisement or silently changes airport", async () => {
    const source = createAirCanadaPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(await source.quote({ ...q, destination: "YTO" })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
