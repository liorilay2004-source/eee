import {describe,it,expect,vi} from "vitest";
import {loadRenderedFinnair} from "../src/finnair-rendered";
import {FINNAIR_PAGE} from "../src/finnair-fares";
const now=new Date("2026-10-08");
const page='<script id="fcom-ux-state">'+JSON.stringify([{from:"HEL",to:"RIX",fromDate:"2026-11-17",toDate:"2026-11-20",currency:"EUR",travelClassPrices:[{price:96,travelClass:"Economy"}]}])+'</script>';
describe("bounded official Finnair rendering",()=>{
 it("loads the fixed official origin page and keeps exact prices",async()=>{
 const quickAction=vi.fn(async()=>Response.json({success:true,result:page}));
 expect(await loadRenderedFinnair({quickAction},now)).toMatchObject([{origin:"HEL",destination:"RIX",amount:96}]);
 expect(quickAction).toHaveBeenCalledWith("content",expect.objectContaining({url:FINNAIR_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:10000}}));
 });
 it("rejects unsuccessful and oversized payloads",async()=>{
 await expect(loadRenderedFinnair({quickAction:async()=>Response.json({success:false,result:page})},now)).rejects.toThrow("Invalid rendering response");
 await expect(loadRenderedFinnair({quickAction:async()=>new Response("x".repeat(4000001))},now)).rejects.toThrow("too large");
 });
});

describe("Finnair background and cached searches",()=>{
 it("partitions large route collections and searches exact dates without browser calls",async()=>{
 const {collectRenderedFinnair}=await import("../src/finnair-rendered");
 const {createFinnairCachedSource}=await import("../src/sources/finnair-cached");
 const state=Array.from({length:501},(_,i)=>({from:"HEL",to:"RIX",fromDate:"2026-11-17",toDate:"2026-11-20",currency:"EUR",travelClassPrices:[{price:i+96,travelClass:"Economy"}]}));
 const cacheData=new Map<string,unknown[]>();
 const cache={put:vi.fn(async<T>(key:string,fares:T[])=>{cacheData.set(key,fares);}),get:async<T>(key:string)=>cacheData.has(key)?{fares:cacheData.get(key) as T[],expires:now.getTime()+600000}:null};
 const savePrices=vi.fn();const quickAction=vi.fn(async()=>Response.json({success:true,result:`<script id="fcom-ux-state">${JSON.stringify(state)}</script>`}));
 const env={FINNAIR_RENDERED_ENABLED:"true",BROWSER:{quickAction}} as unknown as import("../src/types").Env;
 expect(await collectRenderedFinnair({env,repo:{savePrices},now,cache})).toMatchObject({ok:true,fares:501,saved:501});
 expect(cache.put.mock.calls.map(c=>c[1].length)).toEqual([500,1]);
 expect(savePrices).toHaveBeenCalledTimes(6);
 const source=createFinnairCachedSource(cache);
 const query={origin:"HEL",destination:"RIX",departDate:"2026-11-17",returnDate:"2026-11-20",party:{adults:1,children:0,infants:0}};
 expect((await source.quote(query))[0]).toMatchObject({source:"finnair",priceAmount:96});
 expect(await source.quote({...query,returnDate:"2026-11-21"})).toEqual([]);
 expect(await source.quote({...query,party:{adults:2,children:0,infants:0}})).toEqual([]);
 expect(quickAction).toHaveBeenCalledTimes(1);
 expect(source.callCount?.()).toBe(0);
 });
 it("reports rendering failures without inserting fake fares",async()=>{
 const {collectRenderedFinnair}=await import("../src/finnair-rendered");const savePrices=vi.fn();
 const env={FINNAIR_RENDERED_ENABLED:"true",BROWSER:{quickAction:async()=>Response.json({success:false})}} as unknown as import("../src/types").Env;
 expect(await collectRenderedFinnair({env,repo:{savePrices},now})).toMatchObject({ok:false,saved:0});expect(savePrices).not.toHaveBeenCalled();
 });
});
