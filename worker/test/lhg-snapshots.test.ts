import {describe,it,expect,vi} from "vitest";
import {saveLhgSnapshots,readLhgSnapshot} from "../src/lhg-snapshots";
import {parseLufthansaAdvertisements} from "../src/lufthansa-advertisements";
import {createLufthansaCachedSource} from "../src/sources/lufthansa-cached";
import {parseSwissAdvertisements} from "../src/swiss-advertisements";
import type {PublicFareCache} from "../src/public-fare-cache";
const now=new Date("2026-10-08T04:00:00Z");
const fares=parseLufthansaAdvertisements([{text:"from 304 €",url:"/aircore/deeplink/redirect/en/gr/ATH/TLV/05.06.2027/19.06.2027/RT"},{text:"from 310 €",url:"/aircore/deeplink/redirect/en/gr/ATH/TLV/06.06.2027/20.06.2027/RT"}],now);
const query={origin:"ATH",destination:"TLV",departDate:"2027-06-05",returnDate:"2027-06-19",party:{adults:1,children:0,infants:0}};
function database(row:unknown={fares_json:JSON.stringify(fares),checked_at:now.toISOString()}){
 const bind=vi.fn();const first=vi.fn(async()=>row);const prepare=vi.fn((sql:string)=>({bind:(...params:unknown[])=>{bind(...params);return {first,sql,params};}}));
 const batch=vi.fn(async()=>[]);
 return {db:{prepare,batch} as unknown as D1Database,prepare,bind,first,batch};
}
describe("compact LHG storage",()=>{
 it("stores Swiss francs without changing the currency or direction",async()=>{
  const swiss=parseSwissAdvertisements([{text:"from CHF 358",url:"/aircore/deeplink/redirect/en/ch/ZRH/TLV/01.06.2027/15.06.2027/RT"}],now);
  const {db,bind}=database({fares_json:JSON.stringify(swiss),checked_at:now.toISOString()});
  expect(await saveLhgSnapshots(db,"swiss",swiss,now)).toBe(1);
  expect(bind.mock.calls[0]!.slice(0,4)).toEqual(["swiss","ZRH","TLV","2027-06"]);
  expect(await readLhgSnapshot(db,"swiss","2027-06",now)).toEqual(swiss);
  await expect(saveLhgSnapshots(db,"swiss",[{...swiss[0]!,currency:"EUR"}],now)).rejects.toThrow("Unexpected snapshot currency");
 });
 it("stores two same-month advertisements in one current row",async()=>{
  const {db,prepare,bind,batch}=database();
  expect(await saveLhgSnapshots(db,"lufthansa",fares,now)).toBe(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]![0]).toContain("ON CONFLICT");
  expect(bind.mock.calls[0]!.slice(0,4)).toEqual(["lufthansa","ATH","TLV","2027-06"]);
  expect(JSON.parse(bind.mock.calls[0]![4] as string)).toHaveLength(2);
  expect(batch).toHaveBeenCalledTimes(1);
 });
 it("reads only the exact source, route and month primary key",async()=>{
  const {db,bind}=database();expect(await readLhgSnapshot(db,"lufthansa","2027-06",now)).toEqual(fares);
  expect(bind).toHaveBeenCalledWith("lufthansa","ATH","TLV","2027-06");
 });
 it("does not store foreign routes in a source snapshot",async()=>{
  await expect(saveLhgSnapshots(database().db,"brussels_airlines",fares,now)).rejects.toThrow("Unexpected snapshot route");
 });
 it("rejects stale snapshots",async()=>{
  expect(await readLhgSnapshot(database().db,"lufthansa","2027-06",new Date(now.getTime()+37*3600000))).toEqual([]);
 });
 it("rejects malformed JSON and future timestamps",async()=>{
  expect(await readLhgSnapshot(database({fares_json:"broken",checked_at:now.toISOString()}).db,"lufthansa","2027-06",now)).toEqual([]);
  expect(await readLhgSnapshot(database({fares_json:JSON.stringify(fares),checked_at:new Date(now.getTime()+1000).toISOString()}).db,"lufthansa","2027-06",now)).toEqual([]);
 });
 it("matches the exact trip from storage and memoizes one monthly read",async()=>{
  const {db,prepare}=database();const source=createLufthansaCachedSource(now,undefined,db);
  expect(await source.quote(query)).toMatchObject([{priceAmount:304,checkedAt:now.toISOString()}]);
  expect(await source.quote({...query,returnDate:"2027-06-20"})).toEqual([]);
  expect(prepare).toHaveBeenCalledTimes(1);expect(source.callCount()).toBe(0);
 });
 it("does not read storage when the public cache already contains prices",async()=>{
  const {db,prepare}=database();const cache={get:async()=>({fares,expires:now.getTime()+1000}),put:async()=>{}} as PublicFareCache;
  expect(await createLufthansaCachedSource(now,cache,db).quote(query)).toHaveLength(1);
  expect(prepare).not.toHaveBeenCalled();
 });
 it("keeps storage failure local to this source",async()=>{
  const db={prepare(){throw new Error("Daily row limit");}} as unknown as D1Database;
  expect(await createLufthansaCachedSource(now,undefined,db).quote(query)).toEqual([]);
 });
});
