import {it,expect} from "vitest";
import {aegeanCalendarUrl,parseAegeanCalendar,type AegeanCalendarText} from "../src/aegean-lowfare";
import {aegeanDemandTrip,collectRecentAegeanCalendar,AEGEAN_RECENT_DEMAND_SQL} from "../src/aegean-calendar-collection";
import {createPublicFareCache} from "../src/public-fare-cache";
import {createAegeanPublishedSource} from "../src/sources/aegean-published";
import {createTestD1} from "./helpers/d1";
import {createRepo} from "../src/db";
import {saveAegeanCalendar} from "../src/aegean-calendar-cache";
import type {Env} from "../src/types";
const now=new Date("2026-10-08T04:54:00Z");
const trip={origin:"ATH",destination:"FCO",departDate:"2027-06-01",returnDate:"2027-06-05"};
// Selected cells and summary copied from the ordinary official calendar DOM on Oct8.
const june:AegeanCalendarText={outboundRows:["1 €66.44","30 €66.44"],inboundRows:["1 €86.36","5 €103.36"],outboundMonths:["Jun from €66.44"],inboundMonths:["Jun from €86.36"],summaries:["Athens (ATH) to Rome (FCO) 01/06/2027 Rome (FCO) to Athens (ATH) 05/06/2027 € 169.80Total"]};
const crossTrip={...trip,departDate:"2027-06-30",returnDate:"2027-07-04"};
const cross:AegeanCalendarText={...june,inboundRows:["1 €95.36","4 €71.36"],inboundMonths:["Jul from €71.36"],summaries:["Athens (ATH) to Rome (FCO) 30/06/2027 Rome (FCO) to Athens (ATH) 04/07/2027 € 137.80Total"]};
it("matches the observed Athens–Rome selected trip",()=>{expect(parseAegeanCalendar(june,trip,now)).toMatchObject({amount:169.8,outboundAmount:66.44,inboundAmount:103.36,...trip});});
it("uses each leg's own month for the observed June–July trip",()=>{expect(parseAegeanCalendar(cross,crossTrip,now)).toMatchObject({amount:137.8,outboundAmount:66.44,inboundAmount:71.36,...crossTrip});expect(parseAegeanCalendar({...cross,inboundMonths:june.inboundMonths},crossTrip,now)).toBeNull();});
it("does not reverse the collected return trip or substitute another airport",()=>{expect(parseAegeanCalendar(june,{...trip,origin:"FCO",destination:"ATH"},now)).toBeNull();expect(parseAegeanCalendar(june,{...trip,destination:"CIA"},now)).toBeNull();});
it.each(["ath","ATH&x=1",".*","ATH/","",null])("rejects malformed airport codes %s",origin=>{expect(()=>aegeanCalendarUrl({...trip,origin:origin as string})).toThrow();});
it("accepts recent exact demand for a route and dates crossing two months",()=>{expect(aegeanDemandTrip({origin:"ATH",destination:"FCO",window_start:"2027-06-30",window_end:"2027-07-04",stay_min:4,stay_max:4,pax_json:'{"adults":1,"children":0,"infants":0}'},now)).toEqual(crossTrip);});
it("uses the recent-demand index and skips browser collection when another route is already fresh",async()=>{
 const db=createTestD1(),repo=createRepo(db);
 await repo.saveSearch({origin:"ATH",destination:"FCO",windowStart:crossTrip.departDate,windowEnd:crossTrip.returnDate,stayMin:4,stayMax:4,adults:1,children:0,infants:0,cabin:"economy",checkedBag:false,outHours:null,retHours:null,maxStops:null,nearbyAirports:false},"collected-route",now);
 const fare=parseAegeanCalendar(cross,crossTrip,now)!;await saveAegeanCalendar(db,fare,now);
 const plan=await db.prepare("EXPLAIN QUERY PLAN "+AEGEAN_RECENT_DEMAND_SQL).bind(new Date(now.getTime()-86400000).toISOString()).all<{detail:string}>();
 expect(plan.results.some(r=>r.detail.includes("idx_searches_collection_recent"))).toBe(true);
 let calls=0;const env={DB:db,AEGEAN_PUBLISHED_ENABLED:"true",BROWSER:{quickAction:async()=>{calls++;throw new Error("no browser request expected");}}} as Env;
 expect(await collectRecentAegeanCalendar(env,now,{get:async()=>null,put:async()=>{}})).toEqual({collected:0,skipped:true});expect(calls).toBe(0);
});
it("returns the exact observed additional route from the shared cache without airline requests",async()=>{
 const rows=new Map<string,Response>();const key=(r:RequestInfo|URL)=>typeof r==="string"?r:r instanceof URL?r.href:r.url;
 const cache=createPublicFareCache({match:async r=>rows.get(key(r))?.clone(),put:async(r,response)=>{rows.set(key(r),response.clone());}},now,6*3600000);
 const fare=parseAegeanCalendar(cross,crossTrip,now)!;await cache.put(fare.bookingUrl,[fare]);
 const source=createAegeanPublishedSource(now,(async()=>{throw new Error("no airline request expected");}) as typeof fetch,cache);
 expect(await source.quote({...crossTrip,party:{adults:1,children:0,infants:0}})).toMatchObject([{origin:"ATH",destination:"FCO",departDate:"2027-06-30",returnDate:"2027-07-04",priceAmount:137.8,priceCurrency:"EUR",outbound:{airlines:[]},inbound:{airlines:[]}}]);expect(source.callCount()).toBe(0);
});
