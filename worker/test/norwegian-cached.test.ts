import { describe,it,expect,vi } from "vitest";
import { createNorwegianCachedSource,norwegianCollectionMonth } from "../src/sources/norwegian-cached";
import { createTestD1 } from "./helpers/d1";
const now=new Date("2026-10-08T00:00:00.000Z");
const query={origin:"ATH",destination:"OSL",departDate:"2027-06-05",returnDate:"2027-06-09",party:{adults:1,children:0,infants:0}};
const fare=(origin:string,destination:string,date:string,amount:number)=>({origin,destination,date,amount,currency:"EUR",stops:0,checkedAt:now.toISOString(),pricing:"advertised_calendar_price"});
async function seed(db:D1Database,rows:unknown[],month="2027-06"){
 await db.prepare("INSERT INTO public_calendar_snapshots(source,origin,destination,month,fares_json,checked_at) VALUES(?,?,?,?,?,?)")
  .bind("norwegian","ATH","OSL",month,JSON.stringify(rows),now.toISOString()).run();
}
describe("Norwegian exact calendar pairs",()=>{
 it("combines only both requested dates, preserves cents, timestamp and unknown operating carrier",async()=>{
  const db=createTestD1();await seed(db,[fare("ATH","OSL","2027-06-05",56.44),fare("OSL","ATH","2027-06-09",70.44)]);
  const prepare=vi.spyOn(db,"prepare");const source=createNorwegianCachedSource(db,now);
  expect(await source.quote(query)).toMatchObject([{source:"norwegian",priceAmount:126.88,ticketStructure:"split",checkedAt:now.toISOString(),outbound:{stops:0,airlines:[]},inbound:{stops:0,airlines:[]}}]);
  expect(await source.quote({...query,returnDate:"2027-06-10"})).toEqual([]);
  expect(prepare).toHaveBeenCalledTimes(1);expect(source.callCount()).toBe(0);
  expect(await source.quote({...query,party:{adults:2,children:0,infants:0}})).toEqual([]);
  expect(await source.quote({...query,origin:"TLV"})).toEqual([]);
 });
 it("reads two months for trips crossing a month boundary",async()=>{
  const db=createTestD1();await seed(db,[fare("ATH","OSL","2027-06-30",56.44)]);await seed(db,[fare("OSL","ATH","2027-07-03",70.44)],"2027-07");
  expect(await createNorwegianCachedSource(db,now).quote({...query,departDate:"2027-06-30",returnDate:"2027-07-03"})).toMatchObject([{priceAmount:126.88}]);
 });
 it("never invents missing legs, refreshes old fares or accepts another route",async()=>{
  const db=createTestD1();await seed(db,[fare("ATH","OSL","2027-06-05",56.44),fare("FCO","ATH","2027-06-09",70.44)]);
  expect(await createNorwegianCachedSource(db,now).quote(query)).toEqual([]);
  expect(await createNorwegianCachedSource(db,new Date(now.getTime()+37*3600000)).quote(query)).toEqual([]);
 });
 it("rotates all supported months and rolls over calendar years",()=>{
  const months=Array.from({length:13},(_,hour)=>norwegianCollectionMonth(new Date(`2026-10-08T${String(hour).padStart(2,"0")}:00:00Z`)));
  expect(new Set(months).size).toBe(13);expect(months[0]).toBe("2026-10");expect(months[12]).toBe("2027-10");
 });
});
