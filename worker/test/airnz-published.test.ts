import { describe, expect, it } from "vitest";
import { createAirNzPublishedSource } from "../src/sources/airnz-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-08T00:00:00Z");
const sourceUrl = "https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles";
const fare = { __typename: "Fare", originAirportCode: "LAX", destinationAirportCode: "AKL", travelClass: "Economy", departureDate: "2027-04-12", returnDate: "2027-05-10", totalPrice: 911.53, currencyCode: "USD", flightType: "ROUND_TRIP", redemption: null };
const html = (rows: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: rows } })}</script>`;
const q = { origin: "LAX", destination: "AKL", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Air New Zealand official dated fares", () => {
  it("returns only both exact dates and reuses the origin page across destinations", async () => {
    const source = createAirNzPublishedSource(now, (async () => new Response(html([fare, { ...fare, destinationAirportCode: "BNE", totalPrice: 889.73 }]))) as typeof fetch);
    expect((await source.quote(q))[0]).toMatchObject({ source: "air_new_zealand", priceAmount: 911.53, priceCurrency: "USD", outbound: { airlines: ["NZ"], stops: null }, deeplink: sourceUrl });
    expect((await source.quote({ ...q, destination: "BNE" }))[0]?.priceAmount).toBe(889.73);
    expect(await source.quote({ ...q, returnDate: "2027-05-11" })).toEqual([]);
    expect(source.callCount()).toBe(1);
  });
  it("rejects points and premium cabins without converting them into cash economy", () => {
    const rows = [fare, { ...fare, travelClass: "Business Premier", totalPrice: 2000 }, { ...fare, travelClass: "Premium Economy", totalPrice: 1500 }, { ...fare, redemption: { points: 50000 } }];
    expect(parsePublishedFares(html(rows), { airline: "NZ", origin: "LAX", destination: "AKL", sourceUrl, now })).toHaveLength(1);
  });
  it("does not fetch other origins or multiply a single-adult advertisement", async () => {
    const source = createAirNzPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "TLV" })).toEqual([]);
    expect(await source.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});
