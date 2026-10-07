import { describe, expect, it } from "vitest";
import { runQuotes, type FareQuoteSource } from "../src/quotes";
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
  it("keeps cached or pending combinations available when other sources consume the remaining request slots", async () => {
    const later = new Date(now.getTime() + 600_001);
    let requests = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      requests++;
      const url = String(input);
      if (url.includes("services-api.ryanair.com")) {
        const back = url.includes("/ATH/FCO/");
        const date = back ? q.returnDate : q.departDate;
        return new Response(JSON.stringify({ outbound: { fares: [{ day: date, departureDate: `${date}T10:00:00`, arrivalDate: `${date}T12:00:00`, price: { currencyCode: "EUR", value: back ? 40.5 : 90 } }] } }));
      }
      const fares = url.includes("from-rome-to-athens") ? [{ __typename: "Fare", originAirportCode: "FCO", destinationAirportCode: "ATH", departureDate: q.departDate, returnDate: "", totalPrice: 54.36, currencyCode: "EUR", flightType: "ONE_WAY", travelClass: "ECONOMY" }] : [];
      return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares })}</script>`);
    }) as typeof fetch;
    const ryanair = createRyanairDirectSource(later, fetchFn);
    const aegean = createAegeanPublishedSource(later, fetchFn);
    const filler = (name: FareQuoteSource["name"]): FareQuoteSource => {
      let calls = 0;
      return { name, configured: true, quota: { period: "monthly", cap: 0, allowance: 0 }, nextQuoteRequests: () => 2, callCount: () => calls, quote: async () => { calls += 2; return []; } };
    };
    const combination = createDirectCombinationSource([ryanair, aegean]);
    const result = await runQuotes([ryanair, aegean, filler("air_canada"), filler("tap"), filler("ethiopian"), combination], { origin: q.origin, dest: q.destination }, [[q.departDate, q.returnDate]], q.party);
    expect(result.offers.filter(o => o.source === "direct_combination")).toMatchObject([{ priceAmount: 94.86 }]);
    expect(requests).toBe(4);
    expect(ryanair.nextQuoteRequests?.(q)).toBe(0);
    expect(aegean.nextQuoteRequests?.(q)).toBe(0);
    expect(combination.nextQuoteRequests?.(q)).toBe(0);
    expect(ryanair.nextQuoteRequests?.({ ...q, returnDate: "2026-11-24" })).toBe(1);
    expect(ryanair.nextQuoteRequests?.({ ...q, party: { ...q.party, adults: 2 } })).toBe(0);
    expect(aegean.nextQuoteRequests?.({ ...q, party: { ...q.party, adults: 2 } })).toBe(0);
    const expired = new Date(later.getTime() + 600_001);
    expect(createRyanairDirectSource(expired, fetchFn).nextQuoteRequests?.(q)).toBe(2);
    expect(createAegeanPublishedSource(expired, fetchFn).nextQuoteRequests?.(q)).toBe(2);
    expect(result.stats.get("direct_combination")?.calls).toBe(0);
  });
  it("does not spend request slots on unsupported published routes", () => {
    const source = createAegeanPublishedSource(new Date(now.getTime() + 1_200_002), fetch);
    expect(source.nextQuoteRequests?.(q)).toBe(2);
    expect(source.nextQuoteRequests?.({ ...q, destination: "JFK" })).toBe(0);
  });
  it("uses other configured official airlines and retains their valid legs when one airline fails", async () => {
    const outward = { source: "air_canada", airline: "AC", origin: "TLV", destination: "LIS", date: "2027-06-01", amount: 40, currency: "EUR", checkedAt: now.toISOString(), bookingUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv" };
    const inbound = { ...outward, source: "tap", airline: "TP", origin: "LIS", destination: "TLV", date: "2027-06-05", amount: 20, bookingUrl: "https://www.flytap.com/en_il/flights-from-tel-aviv" };
    const provider = (name: FareQuoteSource["name"], rows: typeof outward[], fail = false): FareQuoteSource => ({ name, configured: true, quota: { period: "monthly", cap: 0, allowance: 0 }, callCount: () => 0, nextQuoteRequests: () => 0, quote: async () => [], oneWays: async () => { if (fail) throw new Error("unavailable"); return rows; } });
    let paidCalled = false;
    const paid = { ...provider("serpapi", []), oneWays: async () => { paidCalled = true; return []; } };
    const disabled = { ...provider("virgin_atlantic", [{ ...outward, source: "virgin_atlantic", airline: "VS", amount: 1 }]), configured: false };
    const combination = createDirectCombinationSource([provider("air_canada", [outward]), provider("tap", [inbound]), provider("aegean", [], true), paid, disabled]);
    const offers = await combination.quote({ ...q, origin: "TLV", destination: "LIS", departDate: "2027-06-01", returnDate: "2027-06-05" });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ priceAmount: 60, priceCurrency: "EUR", outbound: { airlines: ["AC"] }, inbound: { airlines: ["TP"] }, deeplink: outward.bookingUrl, returnDeeplink: inbound.bookingUrl });
    expect(paidCalled).toBe(false);
  });
  it("reports a failure if every official source fails rather than claiming a successful empty scan", async () => {
    const failed = (name: FareQuoteSource["name"]): FareQuoteSource => ({ name, configured: true, quota: { period: "monthly", cap: 0, allowance: 0 }, callCount: () => 0, nextQuoteRequests: () => 0, quote: async () => [], oneWays: async () => { throw new Error("unavailable"); } });
    await expect(createDirectCombinationSource([failed("air_canada"), failed("tap")]).quote(q)).rejects.toMatchObject({ code: "response" });
  });
});
