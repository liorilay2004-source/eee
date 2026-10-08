import {it,expect,vi} from "vitest";
import {loadRenderedIberia} from "../src/iberia-rendered";
import {IBERIA_PAGE} from "../src/iberia-fares";
it("renders only the fixed official page and rejects unsuccessful/oversized responses",async()=>{
 const now=new Date("2026-10-08");const quickAction=vi.fn(async()=>Response.json({success:true,result:'<h1>239 €</h1>'}));
 expect(await loadRenderedIberia({quickAction},now)).toEqual([]);
 expect(quickAction).toHaveBeenCalledWith("content",expect.objectContaining({url:IBERIA_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:10000}}));
 await expect(loadRenderedIberia({quickAction:async()=>Response.json({success:false,result:''})},now)).rejects.toThrow("Invalid rendering response");
 await expect(loadRenderedIberia({quickAction:async()=>new Response('x'.repeat(4000001))},now)).rejects.toThrow("too large");
});

it("collects the complete fare and serves only matching one-adult dates without rendering during search",async()=>{
 const {collectRenderedIberia}=await import("../src/iberia-rendered");const {createIberiaCachedSource}=await import("../src/sources/iberia-cached");const {parseIberiaFares}=await import("../src/iberia-fares");
 const now=new Date("2026-10-08");const html='<article><span class="iata">MAD</span><span class="iata">TLV</span><span class="cards-block-column--article__content-dates--start">2026-10-31</span><span class="cards-block-column--article__content-dates--end">2026-11-11</span><p>Return flights from</p><p class="cards-block-column--article__content-price">239 €</p></article>';
 const quickAction=vi.fn(async()=>Response.json({success:true,result:html}));const savePrices=vi.fn();const put=vi.fn();
 const env={IBERIA_RENDERED_ENABLED:"true",BROWSER:{quickAction}} as unknown as import("../src/types").Env;
 const cache={put,get:async<T>()=>({fares:parseIberiaFares(html,now) as T[],expires:now.getTime()+600000})};
 expect(await collectRenderedIberia({env,repo:{savePrices},now,cache})).toMatchObject({ok:true,fares:1,saved:1});
 expect(savePrices.mock.calls[0]![0]).toMatchObject([{source:"iberia",priceAmount:239}]);
 const source=createIberiaCachedSource(cache);const query={origin:"MAD",destination:"TLV",departDate:"2026-10-31",returnDate:"2026-11-11",party:{adults:1,children:0,infants:0}};
 expect(await source.quote(query)).toMatchObject([{source:"iberia",priceAmount:239}]);
 expect(await source.quote({...query,returnDate:"2026-11-12"})).toEqual([]);
 expect(await source.quote({...query,party:{adults:2,children:0,infants:0}})).toEqual([]);
 expect(quickAction).toHaveBeenCalledTimes(1);expect(source.callCount?.()).toBe(0);
});
