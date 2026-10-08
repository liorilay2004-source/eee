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

describe("Avianca background collection",()=>{
 it("stores the complete dated quote and supports exact cache-only searches",async()=>{
  const {collectRenderedAvianca}=await import("../src/avianca-rendered");
  const {createAviancaCachedSource}=await import("../src/sources/avianca-cached");
  const {parseAviancaCard}=await import("../src/avianca-card");
  const savePrices=vi.fn();const put=vi.fn();const env={AVIANCA_RENDERED_ENABLED:"true",BROWSER:{quickAction:vi.fn(async()=>Response.json({success:true,result:card}))}} as unknown as import("../src/types").Env;
  expect(await collectRenderedAvianca({env,repo:{savePrices},now,cache:{put,get:vi.fn()}})).toMatchObject({ok:true,fares:1,saved:1});
  expect(savePrices.mock.calls[0]![0]).toMatchObject([{source:"avianca",priceAmount:330,departDate:"2026-11-07",returnDate:"2026-11-14"}]);
  const source=createAviancaCachedSource({put,get:async<T>()=>({expires:now.getTime()+600000,fares:parseAviancaCard(card,now) as T[]})});
  const q={origin:"MIA",destination:"CLO",departDate:"2026-11-07",returnDate:"2026-11-14",party:{adults:1,children:0,infants:0}};
  expect(await source.quote(q)).toMatchObject([{source:"avianca",priceAmount:330}]);
  expect(await source.quote({...q,returnDate:"2026-11-15"})).toEqual([]);
  expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
  expect(source.callCount()).toBe(0);
 });
 it("does not save partial renders or run a disabled source",async()=>{
  const {collectRenderedAvianca}=await import("../src/avianca-rendered");
  const quickAction=vi.fn(async()=>Response.json({success:true,result:card.replace('>330<','>165<')}));const savePrices=vi.fn();const env={BROWSER:{quickAction}} as unknown as import("../src/types").Env;
  expect(await collectRenderedAvianca({env,repo:{savePrices},now})).toMatchObject({skipped:true});expect(quickAction).not.toHaveBeenCalled();
  expect(await collectRenderedAvianca({env:{...env,AVIANCA_RENDERED_ENABLED:"true"},repo:{savePrices},now})).toMatchObject({ok:false,saved:0});expect(savePrices).not.toHaveBeenCalled();
 });
});
