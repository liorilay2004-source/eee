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
