import {it,expect,vi} from "vitest";
import {createSingaporeCachedSource} from "../src/sources/singapore-cached";
import {SINGAPORE_PAGE} from "../src/sources/singapore-fares";
import {createPublicFareCache,publicFareMaximumRows} from "../src/public-fare-cache";
it("matches collected July dates exactly without fetching or multiplying adult fares",async()=>{
 const row={airline:"SQ",origin:"SIN",destination:"HND",departDate:"2027-07-14",returnDate:"2027-07-20",amount:973.6,currency:"SGD",structure:"roundtrip",sourceUrl:SINGAPORE_PAGE,checkedAt:"2026-10-08T08:00:00Z",pricing:"published_advertisement"};
 const source=createSingaporeCachedSource({get:vi.fn(async()=>({fares:[row],expires:Date.now()+600000})) as any,put:vi.fn()});
 const q={origin:"SIN",destination:"HND",departDate:row.departDate,returnDate:row.returnDate,party:{adults:1,children:0,infants:0}};
 expect(await source.quote(q)).toMatchObject([{source:"singapore",priceAmount:973.6,priceCurrency:"SGD",outbound:{departTime:null,stops:null},tags:["published_advertisement"]}]);
 expect(await source.quote({...q,returnDate:"2027-07-21"})).toEqual([]);expect(await source.quote({...q,destination:"TYO"})).toEqual([]);expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);expect(source.callCount()).toBe(0);
});
it("bounds larger snapshots only for the approved Singapore dataset",()=>{expect(publicFareMaximumRows(SINGAPORE_PAGE)).toBe(1000);expect(publicFareMaximumRows("https://www.aircanada.com/en-ca/flights-from-tel-aviv")).toBe(500);});
it("roundtrips 698 rows through shared cache and expires them at ten minutes",async()=>{
 const now=new Date("2026-10-08T08:00:00Z"),rows=new Map<string,Response>();
 const storage={match:async(r:Request)=>rows.get(r.url)?.clone(),put:async(r:Request,v:Response)=>{rows.set(r.url,v.clone());}};
 const cache=createPublicFareCache(storage as any,now),fares=Array.from({length:698},(_,id)=>({id,amount:973.6,checkedAt:now.toISOString()}));
 await cache.put(SINGAPORE_PAGE,fares);expect((await cache.get(SINGAPORE_PAGE))?.fares).toEqual(fares);
 expect(await createPublicFareCache(storage as any,new Date(now.getTime()+600000)).get(SINGAPORE_PAGE)).toBeNull();
 await cache.put(SINGAPORE_PAGE,Array.from({length:1001},()=>({amount:42})));expect((await cache.get(SINGAPORE_PAGE))?.fares).toEqual(fares);
});