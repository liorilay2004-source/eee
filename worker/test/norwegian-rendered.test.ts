import {expect,it,vi} from "vitest";
import {loadRenderedNorwegian,collectNorwegianMonth} from "../src/norwegian-rendered";
it("does not overwrite stored fares when a render has no priced directions",async()=>{
 const run=vi.fn();const bind=vi.fn(()=>({run}));const prepare=vi.fn(()=>({bind}));
 const html='D_City=ATH&amp;A_City=OSL&amp;D_Month=202706&amp;R_Month=202706&amp;AdultCount=1&amp;CurrencyCode=EUR';
 const result=await collectNorwegianMonth({BROWSER:{quickAction:async()=>Response.json({success:true,result:html})},DB:{prepare} as unknown as D1Database},"2027-06",new Date("2026-10-08"));
 expect(result).toEqual({ok:false,fares:0});expect(prepare).not.toHaveBeenCalled();
});
it("validates the observed route, month and one-adult configuration",async()=>{
 const html='D_City=ATH&amp;A_City=OSL&amp;D_Month=202706&amp;R_Month=202706&amp;AdultCount=1&amp;CurrencyCode=EUR';
 const quickAction=vi.fn(async()=>Response.json({success:true,result:html}));
 expect(await loadRenderedNorwegian({quickAction},"2027-06")).toBe(html);
 expect(quickAction.mock.calls).toHaveLength(1);
 await expect(loadRenderedNorwegian({quickAction},"2027-13")).rejects.toThrow("month");
 await expect(loadRenderedNorwegian({quickAction:async()=>Response.json({success:true,result:'Wrong route'})},"2027-06")).rejects.toThrow("mismatch");
});
