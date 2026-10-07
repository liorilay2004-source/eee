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
    const source = createTapPublishedSource(now, (async (url: RequestInfo | URL) => new Response(html(String(url) === sourceUrl ? [fare] : []))) as typeof fetch);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "tap", priceAmount: 434.69, priceCurrency: "EUR", departDate: q.departDate, returnDate: q.returnDate, outbound: { airlines: ["TP"], stops: null }, deeplink: sourceUrl });
    expect(source.callCount()).toBe(2);
    expect(await source.quote({ ...q, departDate: "2027-06-01", returnDate: "2027-06-05" })).toEqual([]);
    expect(source.callCount()).toBe(2);
  });
  it("shares the verified origin page across Ibiza, Newark and Lisbon without changing dates or currencies", async () => {
    const originUrl = "https://www.flytap.com/en_il/flights-from-tel-aviv";
    const ibz = { ...fare, destinationAirportCode: "IBZ", departureDate: "2027-06-24", returnDate: "2027-06-29", totalPrice: 382.78, currencyCode: "USD" };
    const ewr = { ...fare, destinationAirportCode: "EWR", departureDate: "2027-04-08", returnDate: "2027-04-22", totalPrice: 748.67, currencyCode: "USD" };
    const lis = { ...fare, departureDate: "2027-08-13", returnDate: "2027-08-20", totalPrice: 443.58, currencyCode: "USD" };
    const source = createTapPublishedSource(new Date(now.getTime() + 600_001), (async (url: RequestInfo | URL) => new Response(html(String(url) === originUrl ? [ibz, ewr, lis, { ...ibz, totalPrice: 1000, travelClass: "executive" }] : []))) as typeof fetch);
    expect((await source.quote({ ...q, destination: "IBZ", departDate: ibz.departureDate, returnDate: ibz.returnDate }))[0]).toMatchObject({ priceAmount: 382.78, priceCurrency: "USD", deeplink: originUrl });
    expect((await source.quote({ ...q, destination: "EWR", departDate: ewr.departureDate, returnDate: ewr.returnDate }))[0]?.priceAmount).toBe(748.67);
    expect(source.callCount()).toBe(1);
    expect((await source.quote({ ...q, departDate: lis.departureDate, returnDate: lis.returnDate }))[0]).toMatchObject({ priceAmount: 443.58, priceCurrency: "USD", deeplink: originUrl });
    expect(source.callCount()).toBe(2);
    expect(await source.quote({ ...q, destination: "IBZ", departDate: ibz.departureDate, returnDate: "2027-06-30" })).toEqual([]);
  });
  it("accepts economy casing but excludes the published executive fare", () => {
    expect(parsePublishedFares(html([fare, { ...fare, travelClass: "ECONOMY" }, { ...fare, travelClass: "executive", totalPrice: 2541.3 }]), { airline: "TP", origin: "TLV", destination: "LIS", sourceUrl, now })).toHaveLength(1);
  });
  it("does not call an unverified route or scale a single-adult price", async () => {
    const source = createTapPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
