import { describe, expect, it, vi } from "vitest";
import { createAmericanPublishedSource } from "../src/sources/american-published";
const now = new Date("2026-10-08T00:00:00Z");
const q = { origin: "LAX", destination: "MEX", departDate: "2027-01-20", returnDate: "2027-01-27", party: { adults: 1, children: 0, infants: 0 } };
const fare = { __typename: "Fare", originAirportCode: "LAX", destinationAirportCode: "MEX", departureDate: q.departDate, returnDate: q.returnDate, totalPrice: 451.63, currencyCode: "USD", travelClass: "ECONOMY", flightType: "ROUND_TRIP" };
describe("American Airlines exact dated official advertisement", () => {
  it("matches both dates and caches the observed fare without rounding to the headline", async () => {
    const fetchFn = vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({fares:[fare,fare]})}</script>`)) as unknown as typeof fetch;
    const source = createAmericanPublishedSource(now, fetchFn);
    expect(await source.quote(q)).toMatchObject([{source:"american",priceAmount:451.63,priceCurrency:"USD",departDate:q.departDate,returnDate:q.returnDate}]);
    expect(await source.quote({...q,returnDate:"2027-01-28"})).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("does not fetch unsupported route or passenger counts",async()=>{
    const fetchFn=vi.fn() as unknown as typeof fetch;
    const source=createAmericanPublishedSource(now,fetchFn);
    expect(await source.quote({...q,destination:"JFK"})).toEqual([]);
    expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
