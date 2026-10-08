import { describe, expect, it, vi } from "vitest";
import { createAirSerbiaDirectSource } from "../src/sources/airserbia-direct";
const now = new Date("2026-10-08T00:00:00Z");
const q = { origin:"BEG",destination:"ATH",departDate:"2027-01-04",returnDate:"2027-01-08",party:{adults:1,children:0,infants:0} };
describe("Air Serbia independent dated calendar directions", () => {
  it("keeps a valid outward fare when the return calendar fails, without inventing a round trip", async () => {
    const query = {...q, departDate:"2027-02-04",returnDate:"2027-02-08"};
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/BEG/ATH?")
      ? Response.json({origin:"BEG",destination:"ATH",year:2027,month:2,source:"db",prices:{[query.departDate]:{price:61,currency:"EUR",soldOut:false}}})
      : new Response("unavailable", {status:503})) as typeof fetch;
    const source = createAirSerbiaDirectSource(now, fetchFn);
    expect(await source.oneWays!(query)).toMatchObject([{origin:"BEG",destination:"ATH",amount:61,date:query.departDate}]);
    expect(await source.quote(query)).toEqual([]);
  });
  it("still reports an error when both calendars fail", async () => {
    const source = createAirSerbiaDirectSource(now, vi.fn(async () => new Response("unavailable",{status:503})) as typeof fetch);
    await expect(source.oneWays!({...q,departDate:"2027-03-04",returnDate:"2027-03-08"})).rejects.toThrow();
  });
  it("prices each direction separately and reuses both monthly calendars", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => { const url = String(input); const outward = url.includes("/BEG/ATH?"); return Response.json({ origin:outward?"BEG":"ATH",destination:outward?"ATH":"BEG",year:2027,month:1,source:"db",prices:{[outward?q.departDate:q.returnDate]:{price:outward?60.36:74.74,currency:"EUR",soldOut:false,direct:null}} }); }) as typeof fetch;
    const source=createAirSerbiaDirectSource(now,fetchFn);
    const offers=await source.quote(q);
    expect(offers).toMatchObject([{source:"air_serbia",priceAmount:135.1,priceCurrency:"EUR",ticketStructure:"split",outbound:{stops:null},ticketPrices:{outbound:{amount:60.36},inbound:{amount:74.74}}}]);
    expect(await source.oneWays!(q)).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(source.nextQuoteRequests!(q)).toBe(0);
    expect(await source.quote({...q,returnDate:"2027-01-09"})).toEqual([]);
  });
  it("does not fetch unsupported routes or group fares",async()=>{
    const fetchFn=vi.fn() as unknown as typeof fetch;
    const source=createAirSerbiaDirectSource(now,fetchFn);
    expect(await source.quote({...q,destination:"TLV"})).toEqual([]);
    expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
