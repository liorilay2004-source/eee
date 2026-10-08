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
