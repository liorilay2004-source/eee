import {it,expect,vi} from "vitest";
import {loadRenderedTurkish,TURKISH_ATHENS_PAGE} from "../src/turkish-rendered";
import {validateTurkishFare,readTurkishFares,collectTurkishFares} from "../src/turkish-cache";
import {createPublicFareCache} from "../src/public-fare-cache";
import type {Env} from "../src/types";
const now=new Date("2026-10-08T05:09:31.873Z");
const fare={__typename:"Fare",originAirportCode:"IST",destinationAirportCode:"ATH",departureDate:"2026-11-17",returnDate:"2026-12-01",totalPrice:7237.73,currencyCode:"TRY",travelClass:"ECONOMY",flightType:"ROUND_TRIP",usdTotalPrice:147.10654};
const html=(records:unknown[])=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{fares:records}})}</script>`;
const browser=(quickAction:unknown)=>({quickAction}) as NonNullable<Env["BROWSER"]>;
it("extracts the observed original TRY price and exact paired dates",async()=>{
 const action=vi.fn(async()=>Response.json({success:true,result:html([fare,{...fare,travelClass:null},{...fare,promoCode:"SPECIAL"},{...fare,travelClass:"BUSINESS"}])}));
 const result=await loadRenderedTurkish(browser(action),now);
 expect(result).toHaveLength(1);
 expect(result[0]).toMatchObject({amount:7237.73,currency:"TRY",departDate:"2026-11-17",returnDate:"2026-12-01",structure:"roundtrip"});
 expect(result[0]).not.toHaveProperty("usdTotalPrice");
 expect(action).toHaveBeenCalledWith("content",expect.objectContaining({url:TURKISH_ATHENS_PAGE}));
});
it("rejects errors, unsuccessful envelopes and oversized responses",async()=>{
 await expect(loadRenderedTurkish(browser(async()=>new Response("",{status:403})),now)).rejects.toThrow();
 await expect(loadRenderedTurkish(browser(async()=>Response.json({success:false,result:"challenge"})),now)).rejects.toThrow();
 await expect(loadRenderedTurkish(browser(async()=>new Response(new Uint8Array(4000001))),now)).rejects.toThrow("too large");
});
it("collects and reads a public cache without D1 or a second browser call",async()=>{
 const rows=new Map<string,Response>();
 const storage={match:async(q:Request)=>rows.get(q.url)?.clone(),put:async(q:Request,r:Response)=>{rows.set(q.url,r.clone());}};
 const cache=createPublicFareCache(storage as unknown as Cache,now,36*3600000);
 const action=vi.fn(async()=>Response.json({success:true,result:html([fare])}));
 expect(await collectTurkishFares(browser(action),cache,now)).toBe(1);
 const result=await readTurkishFares(cache,now);
 expect(result).toHaveLength(1);expect(action).toHaveBeenCalledTimes(1);
 const f=result[0]!;
 expect(validateTurkishFare({...f,privateSession:"not retained"},now)).not.toHaveProperty("privateSession");
 for(const patch of [{origin:"ATH"},{currency:"USD"},{returnDate:"2026-11-16"},{departDate:"2026-02-30"},{amount:NaN},{sourceUrl:TURKISH_ATHENS_PAGE+"?token=x"},{checkedAt:"2026-10-09T00:00:00Z"}])expect(validateTurkishFare({...f,...patch},now)).toBeNull();
 expect(validateTurkishFare(f,new Date(now.getTime()+3600000))).toBeNull();
});
it("cache failures are local and unrecognized Turkish pages cannot be cached",async()=>{
 expect(await readTurkishFares({get:async()=>{throw new Error("down");},put:async()=>{}},now)).toEqual([]);
 const storage={match:vi.fn(),put:vi.fn()};
 const cache=createPublicFareCache(storage as unknown as Cache,now);
 await cache.put(TURKISH_ATHENS_PAGE+"?token=x",[fare]);
 expect(storage.put).not.toHaveBeenCalled();
});
