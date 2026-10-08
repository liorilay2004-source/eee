import {it,expect,vi} from "vitest";
import {readAegeanCalendar,saveAegeanCalendar} from "../src/aegean-calendar-cache";
import {aegeanCalendarUrl} from "../src/aegean-lowfare";
import {aegeanDemandTrip,collectRecentAegeanCalendar} from "../src/aegean-calendar-collection";
import {createAegeanPublishedSource} from "../src/sources/aegean-published";
import type {Env} from "../src/types";
import {createTestD1} from "./helpers/d1";
const now=new Date("2026-10-08T04:30:00Z");
const trip={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
const fare={...trip,amount:232.37,currency:"EUR" as const,outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(trip),checkedAt:now.toISOString(),pricing:"published_advertisement" as const,carrier:null};
const demand={window_start:trip.departDate,window_end:trip.returnDate,stay_min:4,stay_max:4,pax_json:JSON.stringify({adults:1,children:0,infants:0})};
function database(row:unknown={fare_json:JSON.stringify(fare),checked_at:now.toISOString()}) {
 const bind=vi.fn();const run=vi.fn(async()=>({success:true}));const prepare=vi.fn((_sql:string)=>({bind:(...params:unknown[])=>{bind(...params);return {run,first:async()=>row};}}));
 return {db:{prepare} as unknown as D1Database,prepare,bind,run};
}
it("stores one current exact date pair with conflict update",async()=>{const {db,prepare,bind,run}=database();await saveAegeanCalendar(db,fare,now);expect(prepare.mock.calls[0]![0]).toContain("ON CONFLICT");expect(bind.mock.calls[0]!.slice(0,5)).toEqual(["aegean","TLV","ATH","2027-06-01","2027-06-05"]);expect(run).toHaveBeenCalledOnce();});
it("applies real SQLite migrations and updates without multiplying history rows",async()=>{const db=createTestD1();await saveAegeanCalendar(db,fare,now);await saveAegeanCalendar(db,fare,now);expect(await db.prepare("SELECT count(*) AS n FROM public_trip_snapshots").first<number>("n")).toBe(1);expect(await readAegeanCalendar(undefined,trip,now,db)).toEqual(fare);});
it("reads the exact primary key and rejects stale, mismatched or malformed snapshots",async()=>{const {db,bind}=database();expect(await readAegeanCalendar(undefined,trip,now,db)).toEqual(fare);expect(bind).toHaveBeenCalledWith("aegean","TLV","ATH",trip.departDate,trip.returnDate);expect(await readAegeanCalendar(undefined,{...trip,returnDate:"2027-06-06"},now,db)).toBeNull();expect(await readAegeanCalendar(undefined,trip,new Date(now.getTime()+6*3600000),db)).toBeNull();expect(await readAegeanCalendar(undefined,trip,now,database({fare_json:"bad"}).db)).toBeNull();});
it("answers with the original exact calendar fare without any airline fetch or inferred flight data",async()=>{const fetchFn=vi.fn();const source=createAegeanPublishedSource(now,fetchFn as typeof fetch,undefined,database().db);expect(await source.quote({...trip,party:{adults:1,children:0,infants:0}})).toMatchObject([{priceAmount:232.37,priceCurrency:"EUR",outbound:{airlines:[],stops:null},inbound:{airlines:[],stops:null},deeplink:fare.bookingUrl}]);expect(fetchFn).not.toHaveBeenCalled();expect(source.callCount()).toBe(0);});
it("collects only exact one-adult searches, not flexible ranges, malformed dates or unsupported parties",()=>{expect(aegeanDemandTrip(demand,now)).toEqual(trip);for(const row of [{...demand,stay_min:3},{...demand,pax_json:'{"adults":2,"children":0,"infants":0}'},{...demand,window_start:"2027-06-31"},{...demand,pax_json:"bad"}])expect(aegeanDemandTrip(row,now)).toBeNull();});
it("does not navigate when recent demand cannot be read",async()=>{const quickAction=vi.fn();const env={AEGEAN_PUBLISHED_ENABLED:"true",BROWSER:{quickAction},DB:{prepare(){throw new Error("daily limit");}}} as unknown as Env;expect(await collectRecentAegeanCalendar(env,now,{get:async()=>null,put:async()=>{}})).toEqual({collected:0,skipped:true});expect(quickAction).not.toHaveBeenCalled();});
