import { describe, expect, it } from "vitest";
import { createAirBalticPublishedSource } from "../src/sources/airbaltic-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-08T00:00:00Z");
const sourceUrl = "https://www.airbaltic.com/en/flight-deals/flights-from-israel";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "RIX", departureDate: "2026-11-25", returnDate: "2026-11-29", totalPrice: 298.55, currencyCode: "EUR", flightType: "ROUND_TRIP", travelClass: "ECONOMY", redemption: null };
const html = (rows: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ fares: rows })}</script>`;
const q = { origin: "TLV", destination: "RIX", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("airBaltic official dated advertisements", () => {
  it("matches full round trips and independently priced directions from the same shared pages", async () => {
    const outward = { ...fare, departureDate: "2027-03-21", returnDate: "", totalPrice: 201.63, flightType: "ONE_WAY" };
    const back = { ...outward, originAirportCode: "RIX", destinationAirportCode: "TLV", departureDate: "2027-03-24", totalPrice: 148.32 };
    const paris = { ...fare, destinationAirportCode: "CDG", departureDate: "2027-04-16", returnDate: "2027-05-11", totalPrice: 462.49 };
    const source = createAirBalticPublishedSource(now, (async (url: RequestInfo | URL) => new Response(html(String(url) === sourceUrl ? [fare, outward, paris] : [back]))) as typeof fetch);
    expect((await source.quote(q))[0]).toMatchObject({ source: "air_baltic", priceAmount: 298.55, priceCurrency: "EUR", ticketStructure: "roundtrip", outbound: { airlines: ["BT"], stops: null }, deeplink: sourceUrl });
    const splitQuery = { ...q, departDate: outward.departureDate, returnDate: back.departureDate };
    expect((await source.quote(splitQuery))[0]).toMatchObject({ priceAmount: 349.95, ticketStructure: "split", returnDeeplink: "https://www.airbaltic.com/en/flight-deals/flights-from-riga-to-tel-aviv" });
    expect(await source.oneWays!(splitQuery)).toHaveLength(2);
    expect((await source.quote({ ...q, destination: "CDG", departDate: paris.departureDate, returnDate: paris.returnDate }))[0]?.priceAmount).toBe(462.49);
    expect(await source.quote({ ...splitQuery, returnDate: "2027-03-25" })).toEqual([]);
    expect(source.callCount()).toBe(2);
    expect(source.nextQuoteRequests?.(q)).toBe(0);
  });
  it("does not fetch other origins or scale the advertisement for a group", async () => {
    const source = createAirBalticPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
  it("rejects points, business cabins and other airport records", () => {
    const rows = [fare, { ...fare, redemption: { points: 1000 } }, { ...fare, travelClass: "BUSINESS" }, { ...fare, originAirportCode: "RIX" }];
    expect(parsePublishedFares(html(rows), { airline: "BT", origin: "TLV", destination: "RIX", sourceUrl, now })).toHaveLength(1);
  });
});
