import {it,expect,vi} from "vitest";
import {createAegeanPublishedSource} from "../src/sources/aegean-published";
import {aegeanCalendarUrl} from "../src/aegean-lowfare";
import type {QuoteQuery} from "../src/quotes";
const now=new Date("2026-10-08T05:30:00Z");
const q={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05",party:{adults:1,children:0,infants:0}} as QuoteQuery;
const fare={origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,amount:232.37,currency:"EUR" as const,outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(q),checkedAt:now.toISOString(),pricing:"published_advertisement" as const,carrier:null};
it("quotes a collected exact trip even with failed D1 and never calls the marketing pages",async()=>{
 const fetcher=vi.fn() as unknown as typeof fetch,onDemand=vi.fn(async()=>fare);
 const db={prepare:()=>{throw Error("daily limit");}} as unknown as D1Database;
 const source=createAegeanPublishedSource(now,fetcher,undefined,db,onDemand);
 const offers=await source.quote(q);
 expect(offers).toHaveLength(1);expect(offers[0]).toMatchObject({priceAmount:232.37,priceCurrency:"EUR",outbound:{airlines:[],stops:null},inbound:{airlines:[],stops:null}});
 expect(fetcher).not.toHaveBeenCalled();expect(onDemand).toHaveBeenCalledTimes(1);
 expect(source.callCount()).toBe(1);expect(source.nextQuoteRequests(q)).toBe(5);
});
it("does not collect for multiple passengers and reads an existing selected fare without collection",async()=>{
 const onDemand=vi.fn(async()=>fare),fetcher=vi.fn(async()=>new Response("",{status:404})) as unknown as typeof fetch;
 const cache={get:async()=>({fares:[fare],expires:now.getTime()+3600000}),put:async()=>{}};
 const source=createAegeanPublishedSource(now,fetcher,cache as never,undefined,onDemand);
 expect(await source.quote(q)).toHaveLength(1);expect(onDemand).not.toHaveBeenCalled();
 await source.quote({...q,party:{adults:2,children:0,infants:0}});expect(onDemand).not.toHaveBeenCalled();
});
