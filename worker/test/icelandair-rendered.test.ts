import {describe,it,expect,vi} from "vitest";
import {ICELANDAIR_PAGE,parseIcelandairFares,loadRenderedIcelandair,collectRenderedIcelandair} from "../src/icelandair-rendered";
import {createIcelandairCachedSource} from "../src/sources/icelandair-cached";
import type {Env} from "../src/types";
const now=new Date("2026-10-08T00:00:00.000Z");
const fare={__typename:"Fare",originAirportCode:"LHR",destinationAirportCode:"KEF",departureDate:"2026-11-28",returnDate:"2026-12-03",totalPrice:172.25,currencyCode:"GBP",travelClass:"eco",flightType:"ROUND_TRIP",redemption:null,promoCode:null};
const html=(rows:unknown[])=>`<script id="__NEXT_DATA__">${JSON.stringify({fares:rows})}</script>`;
describe("observed Icelandair cash fares",()=>{
 it("keeps explicit Heathrow/Gatwick airport pairs and both dates, excluding city-only advertisements",()=>{
  const fares=parseIcelandairFares(html([fare,{...fare,originAirportCode:"LGW",totalPrice:235.6},{...fare,originAirportCode:"LON",totalPrice:153},{...fare,destinationAirportCode:"REK"}]),now);
  expect(fares).toHaveLength(2);expect(fares).toContainEqual(expect.objectContaining({origin:"LHR",destination:"KEF",amount:172.25,currency:"GBP",departDate:"2026-11-28",returnDate:"2026-12-03"}));
 });
 it("rejects reward, promo, unknown cabin, invalid dates and missing return totals",()=>{
  expect(parseIcelandairFares(html([{...fare,redemption:true},{...fare,promoCode:"MEMBER"},{...fare,travelClass:null},{...fare,travelClass:"business"},{...fare,returnDate:"2026-11-31"},{...fare,returnDate:null},{...fare,totalPrice:-1}]),now)).toEqual([]);
 });
 it("uses only the fixed official page with bounded rendering",async()=>{
  const quickAction=vi.fn(async()=>Response.json({success:true,result:html([fare])}));
  expect(await loadRenderedIcelandair({quickAction},now)).toMatchObject([{amount:172.25}]);
  expect(quickAction).toHaveBeenCalledWith("content",expect.objectContaining({url:ICELANDAIR_PAGE}));
  await expect(loadRenderedIcelandair({quickAction:async()=>Response.json({success:false})},now)).rejects.toThrow("Invalid rendering");
  await expect(loadRenderedIcelandair({quickAction:async()=>new Response("x".repeat(4000001))},now)).rejects.toThrow("too large");
 });
 it("serves exact dates from collected public data when history writes are unavailable",async()=>{
  let saved:unknown[]=[];
  const cache={put:async<T>(_key:string,fares:T[])=>{saved=fares;},get:async<T>()=>({fares:saved as T[],expires:now.getTime()+3600000})};
  const env={ICELANDAIR_RENDERED_ENABLED:"true",BROWSER:{quickAction:async()=>Response.json({success:true,result:html([fare])})}} as unknown as Env;
  const savePrices=vi.fn(async()=>{throw new Error("history unavailable");});
  expect(await collectRenderedIcelandair({env,repo:{savePrices},now,cache})).toMatchObject({ok:true,fares:1,saved:0,historyUnavailable:true});
  const source=createIcelandairCachedSource(cache);
  const query={origin:"LHR",destination:"KEF",departDate:"2026-11-28",returnDate:"2026-12-03",party:{adults:1,children:0,infants:0}};
  expect(await source.quote(query)).toMatchObject([{source:"icelandair",priceAmount:172.25,checkedAt:now.toISOString()}]);
  expect(await source.quote({...query,returnDate:"2026-12-04"})).toEqual([]);
  expect(await source.quote({...query,party:{adults:2,children:0,infants:0}})).toEqual([]);
  expect(source.callCount()).toBe(0);
 });
});
