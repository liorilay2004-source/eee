import { describe, expect, it } from "vitest";
import { matchPublishedTrip, createAegeanPublishedSource } from "../src/sources/aegean-published";
import type { PublishedFare } from "../src/sources/published-fares";
const q = { origin: "TLV", destination: "ATH", departDate: "2027-06-01", returnDate: "2027-06-05", party: { adults: 1, children: 0, infants: 0 } };
const out: PublishedFare = { airline: "A3", origin: "TLV", destination: "ATH", departDate: q.departDate, returnDate: null, amount: 50, currency: "EUR", structure: "oneway", sourceUrl: "https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens", checkedAt: "2026-10-08T00:00:00Z", pricing: "published_advertisement" };
const back: PublishedFare = { ...out, origin: "ATH", destination: "TLV", departDate: q.returnDate, amount: 70 };
describe("exact Aegean published fares", () => {
  it("combines only both selected dates without inventing flight times", () => {
    expect(matchPublishedTrip([out, back], q)).toEqual([expect.objectContaining({ priceAmount: 120, ticketStructure: "split", departDate: q.departDate, returnDate: q.returnDate, outbound: expect.objectContaining({ departTime: null, stops: null }) })]);
    expect(matchPublishedTrip([out, { ...back, departDate: "2027-06-06" }], q)).toEqual([]);
  });
  it("never substitutes a published headline, currency or multi-adult price", () => {
    expect(matchPublishedTrip([out], q)).toEqual([]);
    expect(matchPublishedTrip([out, { ...back, currency: "USD" }], q)).toEqual([]);
    expect(matchPublishedTrip([out, back], { ...q, party: { ...q.party, adults: 2 } })).toEqual([]);
  });
  it("accepts an exact round trip without adding another return fare", () => {
    expect(matchPublishedTrip([{ ...out, structure: "roundtrip", returnDate: q.returnDate, amount: 90 }, back], q)[0]?.priceAmount).toBe(90);
  });
  it("caches parsed public pages without sharing pending promises across requests", async () => {
    const fetchFn = (async () => new Response('<script id="__NEXT_DATA__">{"props":{}}</script>')) as typeof fetch;
    const now = new Date("2026-10-09T00:00:00Z");
    const source = createAegeanPublishedSource(now, fetchFn);
    expect(await source.quote(q)).toEqual([]);
    expect(source.callCount()).toBe(2);
    const next = createAegeanPublishedSource(now, fetchFn);
    expect(await next.quote(q)).toEqual([]);
    expect(next.callCount()).toBe(0);
  });
});
