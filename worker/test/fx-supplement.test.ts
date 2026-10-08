import {it,expect,vi} from "vitest";
import {supplementFx} from "../src/fx-supplement";
import {readFxCache,writeFxCache} from "../src/fx-cache";
const now=new Date("2026-10-08T05:30:00Z");
const base={date:"2026-10-08",source:"bank_of_israel",ratesToIls:{ILS:1,USD:3.5,EUR:4}};
const xml=(date="2026-10-07")=>`<Cube time='${date}'><Cube currency='USD' rate='1.1177'/><Cube currency='ILS' rate='3.4290'/><Cube currency='TRY' rate='54.9822'/></Cube>`;
it("adds missing TRY without replacing primary rates, preserving the older reference date",async()=>{
 const fetcher=vi.fn(async()=>new Response(xml())) as unknown as typeof fetch;
 const fx=await supplementFx(base,["TRY"],fetcher,now);
 expect(fx.ratesToIls.TRY).toBeCloseTo(3.429/54.9822,10);
 expect(fx.ratesToIls.USD).toBe(3.5);expect(fx.ratesToIls.EUR).toBe(4);
 expect(fx.source).toBe("bank_of_israel+ecb:stale");expect(fx.date).toBe("2026-10-07");
 expect(base.ratesToIls).not.toHaveProperty("TRY");
});
it("makes zero requests when required rates already exist and coalesces missing-rate requests",async()=>{
 const fetcher=vi.fn(async()=>new Response(xml())) as unknown as typeof fetch;
 expect(await supplementFx(base,["USD"],fetcher,now)).toBe(base);expect(fetcher).not.toHaveBeenCalled();
 await Promise.all([supplementFx(base,["TRY"],fetcher,now),supplementFx(base,["TRY"],fetcher,now)]);
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it("keeps the usable primary table after supplemental errors, future/old rates or huge payloads",async()=>{
 for(const body of [xml("2026-10-09"),xml("2026-09-30"),"bad xml","x".repeat(32001)]){
  const fetcher=(async()=>new Response(body)) as typeof fetch;
  expect(await supplementFx(base,["TRY"],fetcher,now)).toBe(base);
 }
 expect(await supplementFx(base,["TRY"],(async()=>{throw Error("down");}) as typeof fetch,now)).toBe(base);
});
it("uses a separate ECB cache namespace",async()=>{
 const rows=new Map<string,Response>();
 const storage={match:async(q:Request)=>rows.get(q.url)?.clone(),put:async(q:Request,r:Response)=>{rows.set(q.url,r.clone());}} as unknown as Cache;
 await writeFxCache(storage,now,base);
 await writeFxCache(storage,now,{date:"2026-10-07",source:"ecb:stale",ratesToIls:{ILS:1,USD:3,TRY:.06}},"ecb");
 const fetcher=vi.fn() as unknown as typeof fetch;
 const fx=await supplementFx(base,["TRY"],fetcher,now,storage);
 expect(fx.ratesToIls.TRY).toBe(.06);expect(fetcher).not.toHaveBeenCalled();
 expect(await readFxCache(storage,now)).toEqual(base);
});
