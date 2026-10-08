import {storedQuoteWithinAge} from "../src/pipeline";
import {it,expect,vi} from "vitest";
import {createTurkishCachedSource} from "../src/sources/turkish-cached";
import {TURKISH_ATHENS_PAGE} from "../src/turkish-rendered";
import type {QuoteQuery} from "../src/quotes";
const now=new Date("2026-10-08T05:09:31.873Z");
const q={origin:"IST",destination:"ATH",departDate:"2026-11-17",returnDate:"2026-12-01",party:{adults:1,children:0,infants:0}} as QuoteQuery;
const fare={airline:"TK",origin:"IST",destination:"ATH",departDate:q.departDate,returnDate:q.returnDate,amount:7237.73,currency:"TRY",structure:"roundtrip",sourceUrl:TURKISH_ATHENS_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"};
it("quotes exactly the stored pair with unknown flight details and no airline network requests",async()=>{
 const get=vi.fn(async()=>({fares:[fare],expires:now.getTime()+3600000}));
 const source=createTurkishCachedSource(now,{get:get as never,put:async()=>{}});
 const offers=await source.quote(q);expect(offers).toHaveLength(1);
 expect(offers[0]).toMatchObject({source:"turkish",priceAmount:7237.73,priceCurrency:"TRY",outbound:{airlines:[],stops:null},includes:{}});
 expect(source.callCount()).toBe(0);expect(source.nextQuoteRequests?.(q)).toBe(0);
 for(const patch of [{origin:"ATH",destination:"IST"},{returnDate:"2026-12-02"},{party:{adults:2,children:0,infants:0}},{adults:2}])expect(await source.quote({...q,...patch})).toEqual([]);
 expect(get).toHaveBeenCalledTimes(1);
});

it("expires Turkish stored search quotes at one hour without rounding or claiming a vendor expiry",()=>{
 const quote={source:"turkish" as const,checkedAt:now.toISOString()};
 expect(storedQuoteWithinAge(quote,new Date(now.getTime()+3599999))).toBe(true);
 expect(storedQuoteWithinAge(quote,new Date(now.getTime()+3600000))).toBe(false);
 expect(storedQuoteWithinAge({...quote,checkedAt:"invalid"},now)).toBe(false);
 expect(storedQuoteWithinAge(quote,new Date(now.getTime()-1))).toBe(false);
});