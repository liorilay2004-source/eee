import { describe, expect, it, vi } from "vitest";
import { createSkyExpressPublishedSource } from "../src/sources/skyexpress-published";
const now = new Date("2026-10-08T00:00:00Z");
const fare = { __typename: "Fare", originAirportCode: "ATH", destinationAirportCode: "FCO", departureDate: "2026-12-13", returnDate: "2026-12-18", totalPrice: 102, currencyCode: "EUR", travelClass: "ECONOMY", flightType: "ROUND_TRIP" };
const q = { origin: "ATH", destination: "FCO", departDate: fare.departureDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } };
describe("SKY express official advertisements", () => {
  it("exposes only independently advertised one-way prices from new route snapshots",async()=>{
    const url="https://www.skyexpress.gr/en/flights-from-athens-to-thessaloniki",row={airline:"GQ",origin:"ATH",destination:"SKG",departDate:"2026-11-04",returnDate:null,amount:43.22,currency:"EUR",structure:"oneway",sourceUrl:url,checkedAt:now.toISOString(),pricing:"published_advertisement"};
    const source=createSkyExpressPublishedSource(new Date(now.getTime()+3600000),(async()=>{throw new Error("upstream failed");}) as typeof fetch,{get:async<T>(key:string)=>key===url?{fares:[row,{...row,structure:"roundtrip",returnDate:"2026-11-08",amount:80}] as T[],expires:now.getTime()+7200000}:null,put:async()=>{}});
    expect(await source.oneWays!({...q,destination:"SKG",departDate:row.departDate,returnDate:"2026-11-09"})).toMatchObject([{source:"sky_express",origin:"ATH",destination:"SKG",date:row.departDate,amount:43.22}]);
    expect(await source.oneWays!({...q,destination:"SKG",departDate:row.departDate,returnDate:"2026-11-09",party:{adults:2,children:0,infants:0}})).toEqual([]);
  });
  it("matches exact dates, rejects business and redemption fares, and reuses the page", async () => {
    const fetchFn = vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare, { ...fare, totalPrice: 5, travelClass: "BUSINESS" }, { ...fare, totalPrice: 1, redemption: true }] })}</script>`)) as unknown as typeof fetch;
    const source = createSkyExpressPublishedSource(now, fetchFn);
    const offers = await source.quote(q);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ source: "sky_express", priceAmount: 102, priceCurrency: "EUR", outbound: { airlines: ["GQ"] } });
    expect(await source.quote({ ...q, returnDate: "2026-12-19" })).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(source.nextQuoteRequests?.(q)).toBe(0);
  });
  it("does not multiply an adult advertisement into a group price", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await createSkyExpressPublishedSource(now, fetchFn).quote({ ...q, party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
