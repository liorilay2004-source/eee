import {describe, expect, it} from "vitest";
import {parseEurowingsCalendar, parseEurowingsRenderedCalendar} from "../src/eurowings-calendar";
import {collectRenderedEurowings, EUROWINGS_API, eurowingsCacheKey, loadRenderedEurowings} from "../src/eurowings-rendered";
import {createEurowingsCachedSource} from "../src/sources/eurowings-cached";
import type {PublicFareCache} from "../src/public-fare-cache";

const now = new Date("2026-10-08T03:00:00Z");
const stations = {origin:"LHR", destination:"DUS", airlineCode:"EW"};
const day = {date:2, price:{raw:66.49}, noDiscountPrice:{raw:69.99}, currency:"GBP", promocode:true};
const section = (type:string, dates:unknown[]=[day]) => ({type,meta:{stations},bookableMonths:[{year:2026,month:11,bookable:true,expandedDates:dates}]});
const payload = (out=section("outbound"), back=section("inbound")) => ({header:{code:"SUCCESS",statusCode:200},meta:{stations},sections:[out,back]});

describe("Eurowings observed calendar", () => {
  it("retains each direction and uses the explicit price without a member promotion", () => {
    expect(parseEurowingsCalendar(payload(),now)).toEqual([
      expect.objectContaining({origin:"LHR",destination:"DUS",date:"2026-11-02",amount:69.99,currency:"GBP"}),
      expect.objectContaining({origin:"DUS",destination:"LHR",date:"2026-11-02",amount:69.99,currency:"GBP"}),
    ]);
    expect(parseEurowingsCalendar(payload(section("outbound",[{...day,promocode:false,price:{raw:199.99}}])),now)[0]?.amount).toBe(199.99);
  });
  it("rejects missing ordinary prices, wrong currency, impossible dates and route mismatches", () => {
    const invalid=[{...day,noDiscountPrice:null},{...day,currency:"EUR"},{...day,date:31},{...day,noDiscountPrice:{raw:-1}},{...day,promocode:null}];
    expect(parseEurowingsCalendar(payload(section("outbound",invalid),section("inbound",[])),now)).toEqual([]);
    expect(parseEurowingsCalendar({...payload(),meta:{stations:{...stations,origin:"LCY"}}},now)).toEqual([]);
    expect(parseEurowingsCalendar(payload(section("outbound"),section("outbound")),now)).toEqual([]);
    expect(parseEurowingsCalendar(payload(section("outbound",[day,day])),now)).toEqual([]);
  });
  it("parses only a bounded rendered JSON document", () => {
    expect(parseEurowingsRenderedCalendar(`<html><pre>${JSON.stringify(payload()).replace(/"/g,"&quot;")}</pre></html>`,now)).toHaveLength(2);
    expect(parseEurowingsRenderedCalendar("Access Denied",now)).toEqual([]);
    expect(parseEurowingsRenderedCalendar("x".repeat(500001),now)).toEqual([]);
  });
  it("collects compact month groups and serves exact cached dates despite unavailable D1", async () => {
    const values = new Map<string,unknown[]>();
    const cache: PublicFareCache = {put:async(key,fares)=>{values.set(key,fares);},get:async<T>(key:string)=>values.has(key)?{fares:values.get(key) as T[],expires:now.getTime()+3600000}:null};
    const db = {prepare:()=>{throw new Error("D1 unavailable");}} as unknown as D1Database;
    const html = `<pre>${JSON.stringify(payload(section("outbound",[day,{...day,date:5}]),section("inbound",[day,{...day,date:5}])) )}</pre>`;
    const browser={quickAction:async(_type:string,options:{url:string})=>{
      expect(options.url).toBe(EUROWINGS_API);
      return Response.json({success:true,result:html});
    }};
    expect(await collectRenderedEurowings({env:{DB:db,BROWSER:browser,EUROWINGS_RENDERED_ENABLED:"true"},now,cache})).toMatchObject({ok:true,fares:4,months:1,historyUnavailable:true});
    expect(values.has(eurowingsCacheKey("2026-11"))).toBe(true);
    const source=createEurowingsCachedSource(db,now,cache);
    const query={origin:"LHR",destination:"DUS",departDate:"2026-11-02",returnDate:"2026-11-05",party:{adults:1,children:0,infants:0}};
    const offers=await source.quote(query);
    expect(offers).toMatchObject([{source:"eurowings",priceAmount:139.98,priceCurrency:"GBP",checkedAt:now.toISOString(),outbound:{stops:null,airlines:[]}}]);
    expect(await source.quote({...query,returnDate:"2026-11-06"})).toEqual([]);
    expect(await source.quote({...query,party:{adults:2,children:0,infants:0}})).toEqual([]);
    expect(await source.quote({...query,origin:"LCY"})).toEqual([]);
    expect(source.callCount()).toBe(0);
    expect(await createEurowingsCachedSource(db,new Date(now.getTime()+37*3600000),cache).quote(query)).toEqual([]);
  });
  it("rejects failed and oversized browser responses", async () => {
    await expect(loadRenderedEurowings({quickAction:async()=>Response.json({success:false})},now)).rejects.toThrow("Invalid calendar");
    await expect(loadRenderedEurowings({quickAction:async()=>new Response("x".repeat(1000001))},now)).rejects.toThrow("too large");
  });
  it("keeps Athens metadata and cached month partitions separate from Dusseldorf", async () => {
    const input=payload();input.meta.stations={...stations,destination:"ATH"};
    for(const s of input.sections) s.meta.stations={...stations,destination:"ATH"};
    expect(parseEurowingsCalendar(input,now)).toEqual([]);
    const athens=parseEurowingsCalendar(input,now,"ATH");
    expect(athens).toMatchObject([{origin:"LHR",destination:"ATH"},{origin:"ATH",destination:"LHR"}]);
    const rows=[...athens,...athens.map(f=>({...f,date:"2026-11-05"}))];
    const cache:PublicFareCache={put:async()=>{},get:async<T>(key:string)=>({fares:(key.endsWith("&destination=ATH")?rows:parseEurowingsCalendar(payload(),now)) as T[],expires:now.getTime()+3600000})};
    const db={prepare:()=>{throw new Error("Must not query D1");}} as unknown as D1Database;
    const source=createEurowingsCachedSource(db,now,cache);
    const query={origin:"LHR",destination:"ATH",departDate:"2026-11-02",returnDate:"2026-11-05",party:{adults:1,children:0,infants:0}};
    expect(await source.quote(query)).toMatchObject([{destination:"ATH",priceAmount:139.98}]);
    expect(await source.quote({...query,destination:"DUS"})).toEqual([]);
    expect(await source.quote({...query,origin:"ATH",destination:"LHR"})).toMatchObject([{origin:"ATH",destination:"LHR"}]);
  });
});
