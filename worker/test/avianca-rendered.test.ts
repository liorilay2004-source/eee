import {describe,expect,it,vi} from "vitest";
import {loadRenderedAvianca} from "../src/avianca-rendered";
import {AVIANCA_PAGE} from "../src/avianca-card";
const now=new Date("2026-10-08T00:00:00Z");
const card='<div>Round trip from 330 USD</div><div class="hh-rtcard undefined"><div class="hh-rtcard-title">Round trip</div><div class="hh-rtcard-row"><span>Sat, Nov 07, 2026</span></div><div class="hh-rtcard-row"><span>Sat, Nov 14, 2026</span></div><span class="hh-rtcard-currency">USD</span><span class="hh-rtcard-amount">330</span><button class="hh-rtcard-cta">Book now</button><button class="hh-rtcard-clear">Clear selection</button></div>';
describe("bounded Avianca complete-card loader",()=>{
 it("waits for the observed second date and parses the settled full fare",async()=>{
  const quickAction=vi.fn(async()=>Response.json({success:true,result:card}));
  expect(await loadRenderedAvianca({quickAction},now)).toMatchObject([{amount:330,departDate:"2026-11-07",returnDate:"2026-11-14"}]);
  expect(quickAction).toHaveBeenCalledExactlyOnceWith("content",expect.objectContaining({url:AVIANCA_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:10000},waitForSelector:{selector:".hh-rtcard-dates .hh-rtcard-row:nth-child(2)",timeout:10000},waitForTimeout:2000}));
 });
 it("rejects oversized responses, unsuccessful renders and inconsistent amounts",async()=>{
  await expect(loadRenderedAvianca({quickAction:vi.fn(async()=>new Response("x".repeat(4_000_001)))},now)).rejects.toThrow("too large");
  await expect(loadRenderedAvianca({quickAction:vi.fn(async()=>Response.json({success:false,result:card}))},now)).rejects.toThrow("Invalid rendering response");
  expect(await loadRenderedAvianca({quickAction:vi.fn(async()=>Response.json({success:true,result:card.replace('>330<','>165<')}))},now)).toEqual([]);
 });
});
