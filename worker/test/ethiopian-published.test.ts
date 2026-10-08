import { describe, expect, it } from "vitest";
import { createEthiopianPublishedSource } from "../src/sources/ethiopian-published";
import { parsePublishedFares } from "../src/sources/published-fares";
const now = new Date("2026-10-22T00:00:00Z");
const sourceUrl = "https://www.ethiopianairlines.com/en-il/";
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "BKK", travelClass: "economy", departureDate: "2027-07-12", returnDate: "2027-08-02", totalPrice: 950.38, currencyCode: "USD", flightType: "ROUND_TRIP", redemption: null };
const html = (nodes: unknown[]) => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: nodes } })}</script>`;
const q = { origin: "TLV", destination: "BKK", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("Ethiopian multi-destination official fares", () => {
  it("uses an independently collected route snapshot when the origin page fails", async () => {
    const url = "https://www.ethiopianairlines.com/en-il/flights-from-tel-aviv-to-bangkok";
    const row = { airline: "ET", origin: "TLV", destination: "BKK", departDate: q.departDate, returnDate: q.returnDate, amount: 950.38, currency: "USD", structure: "roundtrip", sourceUrl: url, checkedAt: now.toISOString(), pricing: "published_advertisement" };
    const source = createEthiopianPublishedSource(now, (async () => { throw new Error("origin unavailable"); }) as typeof fetch, {
      get: async<T>(key: string) => key === url ? { fares: [row] as T[], expires: now.getTime() + 600000 } : null,
      put: async () => {},
    });
    expect(await source.quote(q)).toMatchObject([{ source: "ethiopian", priceAmount: 950.38, deeplink: url, tags: ["published_advertisement"] }]);
    await expect(source.oneWays!(q)).rejects.toThrow("response");
    expect(await source.quote({ ...q, party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
  });

  it("reads one origin page once and selects separate exact-date routes", async () => {
    const second = { ...fare, destinationAirportCode: "ICN", departureDate: "2027-07-01", returnDate: "2027-07-13", totalPrice: 732.58 };
    const source = createEthiopianPublishedSource(now, (async () => new Response(html([fare, second]))) as typeof fetch);
    expect((await source.quote(q))[0]).toMatchObject({ source: "ethiopian", destination: "BKK", priceAmount: 950.38, priceCurrency: "USD", outbound: { airlines: ["ET"], stops: null } });
    expect((await source.quote({ ...q, destination: "ICN", departDate: second.departureDate, returnDate: second.returnDate }))[0]?.priceAmount).toBe(732.58);
    expect(source.callCount()).toBe(1);
    expect(await source.quote({ ...q, destination: "ATH" })).toEqual([]);
    expect(await source.quote({ ...q, departDate: "2027-07-13" })).toEqual([]);
  });
  it("keeps distinct destinations with identical price and dates", () => {
    const query = { airline: "ET", origin: "TLV", destination: "BKK", sourceUrl, now, allDestinations: true };
    expect(parsePublishedFares(html([fare, { ...fare, destinationAirportCode: "ICN" }]), query)).toHaveLength(2);
    expect(parsePublishedFares(html([fare, { ...fare, destinationAirportCode: "ICN" }]), { ...query, allDestinations: false })).toHaveLength(1);
  });
  it("does not infer an airport from a city fare or collect another origin", async () => {
    const source = createEthiopianPublishedSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch);
    expect(await source.quote({ ...q, origin: "STN" })).toEqual([]);
    const fares = parsePublishedFares(html([{ ...fare, destinationAirportCode: "TYO" }]), { airline: "ET", origin: "TLV", destination: "NRT", sourceUrl, now });
    expect(fares).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
});


