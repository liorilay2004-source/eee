import { describe, expect, it } from "vitest";
import { runQuotes } from "../src/quotes";
import { createRyanairDirectSource } from "../src/sources/ryanair-direct";
import { createAegeanPublishedSource } from "../src/sources/aegean-published";
import { createDirectCombinationSource } from "../src/sources/direct-combination";
const now = new Date("2026-10-08T01:00:00Z");
const q = { origin: "FCO", destination: "ATH", departDate: "2026-10-20", returnDate: "2026-10-24", party: { adults: 1, children: 0, infants: 0 } };
describe("official mixed-airline quote integration", () => {
  it("combines real one-way records without repeating provider requests or changing dates", async () => {
    const requests: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      if (url.includes("services-api.ryanair.com")) {
        const back = url.includes("/ATH/FCO/");
        const date = back ? q.returnDate : q.departDate;
        return new Response(JSON.stringify({ outbound: { fares: [{ day: date, departureDate: `${date}T10:00:00`, arrivalDate: `${date}T12:00:00`, price: { currencyCode: "EUR", value: back ? 40.5 : 90 } }] } }));
      }
      const fares = url.includes("from-rome-to-athens") ? [{ __typename: "Fare", originAirportCode: "FCO", destinationAirportCode: "ATH", departureDate: q.departDate, returnDate: "", totalPrice: 54.36, currencyCode: "EUR", flightType: "ONE_WAY", travelClass: "ECONOMY" }] : [];
      return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares })}</script>`);
    }) as typeof fetch;
    const ryanair = createRyanairDirectSource(now, fetchFn);
    const aegean = createAegeanPublishedSource(now, fetchFn);
    const combination = createDirectCombinationSource([ryanair, aegean]);
    const result = await runQuotes([ryanair, aegean, combination], { origin: q.origin, dest: q.destination }, [[q.departDate, q.returnDate]], q.party);
    const mixed = result.offers.filter(f => f.source === "direct_combination");
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({ origin: "FCO", destination: "ATH", departDate: q.departDate, returnDate: q.returnDate, priceAmount: 94.86, priceCurrency: "EUR", ticketStructure: "split", outbound: { airlines: ["A3"], departTime: null }, inbound: { airlines: ["FR"], departTime: "10:00" }, deeplink: "https://flights.aegeanair.com/en/flights-from-rome-to-athens", returnDeeplink: "https://www.ryanair.com/" });
    expect(requests).toHaveLength(4);
    expect(result.stats.get("ryanair")?.calls).toBe(2);
    expect(result.stats.get("aegean")?.calls).toBe(2);
    expect(result.stats.get("direct_combination")?.calls).toBe(0);
    expect(await combination.quote({ ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
    expect(requests).toHaveLength(4);
    expect(await combination.quote({ ...q, returnDate: "2026-10-25" })).toEqual([]);
    expect(requests).toHaveLength(4);
  });
  it("is unavailable with only one provider and does not claim a price for unconfigured sources", () => {
    expect(createDirectCombinationSource([]).configured).toBe(false);
    expect(createDirectCombinationSource([createRyanairDirectSource(now)]).configured).toBe(false);
  });
  it("does not spend request slots on unsupported published routes", () => {
    const source = createAegeanPublishedSource(now, fetch);
    expect(source.nextQuoteRequests?.(q)).toBe(2);
    expect(source.nextQuoteRequests?.({ ...q, destination: "JFK" })).toBe(0);
  });
});
