import {it,expect,vi} from "vitest";
import {createFrontierCachedSource} from "../src/sources/frontier-cached";
const now=new Date('2026-10-08T09:00:00Z'),forward='https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix',reverse='https://flights.flyfrontier.com/en/flights-from-phoenix-to-denver';
const q={origin:'DEN',destination:'PHX',departDate:'2027-01-05',returnDate:'2027-01-10',party:{adults:1,children:0,infants:0}};
const out={airline:'F9',origin:'DEN',destination:'PHX',departDate:q.departDate,returnDate:null,amount:18.98,currency:'USD',structure:'oneway',sourceUrl:forward,checkedAt:now.toISOString(),pricing:'published_advertisement'};
it('combines exact independently observed directions without upstream requests',async()=>{
 const back={...out,origin:'PHX',destination:'DEN',departDate:q.returnDate,amount:25.98,sourceUrl:reverse};
 const get=vi.fn(async(page:string)=>({fares:page===forward?[out]:page===reverse?[back]:[],expires:now.getTime()+600000}));
 const source=createFrontierCachedSource(now,{get:get as any,put:vi.fn()});
 expect(await source.quote(q)).toMatchObject([{source:'frontier',priceAmount:44.96,ticketStructure:'split',deeplink:forward,returnDeeplink:reverse,outbound:{stops:null,departTime:null}}]);expect(await source.oneWays!(q)).toHaveLength(2);expect(source.callCount()).toBe(0);
 expect(await source.quote({...q,returnDate:'2027-01-11'})).toEqual([]);expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
});
it('rejects expired captures and tolerates one missing or failed direction',async()=>{
 const source=createFrontierCachedSource(new Date(now.getTime()+600000),{get:(async()=>({fares:[out],expires:now.getTime()+1200000})) as any,put:vi.fn()});expect(await source.quote(q)).toEqual([]);expect(await source.oneWays!(q)).toEqual([]);
 const failed=createFrontierCachedSource(now,{get:vi.fn().mockRejectedValue(new Error('unavailable')),put:vi.fn()});expect(await failed.quote(q)).toEqual([]);
});
it('rejects stored prices removed or replaced by the current snapshot',async()=>{
 const back={...out,origin:'PHX',destination:'DEN',departDate:q.returnDate,amount:25.98,sourceUrl:reverse};
 const cache={get:(async(page:string)=>({fares:page===forward?[out]:[back],expires:now.getTime()+600000})) as any,put:vi.fn()};
 const source=createFrontierCachedSource(now,cache);
 const [offer]=await source.quote(q);
 if(!offer)throw new Error('Expected current quote');
 expect(await source.validatesStoredOffer!(offer)).toBe(true);
 expect(await source.validatesStoredOffer!({...offer,priceAmount:20})).toBe(false);
 expect(await source.validatesStoredOffer!({...offer,checkedAt:new Date(now.getTime()-1000).toISOString()})).toBe(false);
 const removed=createFrontierCachedSource(now,{get:(async()=>({fares:[],expires:now.getTime()+600000})) as any,put:vi.fn()});
 expect(await removed.validatesStoredOffer!(offer)).toBe(false);
});
