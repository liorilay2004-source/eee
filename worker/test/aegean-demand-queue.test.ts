import {DatabaseSync} from "node:sqlite";
import {afterEach,describe,expect,it,vi} from "vitest";
import {AEGEAN_DEMAND_ACTIVE_MS,AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS,FareStore} from "../src/fare-store";
import {AEGEAN_DEMAND_OBJECT,getOrCollectAegean} from "../src/aegean-on-demand";
import {aegeanCalendarUrl,type AegeanCalendarTrip} from "../src/aegean-lowfare";
import type {FareStoreNamespace} from "../src/shared-fare-cache";

const now=new Date("2026-10-08T12:00:00.000Z");
const trip:AegeanCalendarTrip={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
const dbs:DatabaseSync[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();vi.useRealTimers();vi.restoreAllMocks();});
function instance(db:DatabaseSync):FareStore{
 const ctx={blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>fn(),storage:{sql:{exec:(sql:string,...args:(string|number)[])=>{
  const statement=db.prepare(sql),rows=/^(SELECT|PRAGMA)|RETURNING/.test(sql)?statement.all(...args):(statement.run(...args),[]);
  return {toArray:()=>rows};
 }}}};
 return new FareStore(ctx as unknown as DurableObjectState,{});
}
function setup(){vi.useFakeTimers();vi.setSystemTime(now);const db=new DatabaseSync(":memory:");dbs.push(db);return {db,store:instance(db)};}
const date=(offset:number)=>new Date(Date.UTC(2027,0,1+offset)).toISOString().slice(0,10);

describe("global selected Aegean demand queue",()=>{
 it("deduplicates both approved routes by exact dates and survives reconstruction",async()=>{
  const {db,store}=setup();
  expect(await store.enqueueAegean(trip)).toBe(true);expect(await store.enqueueAegean(trip)).toBe(true);
  const reverse={...trip,origin:"ATH",destination:"TLV"};await store.enqueueAegean(reverse);
  expect(await instance(db).pendingAegean()).toEqual([trip,reverse]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM aegean_pending").get()?.n).toBe(2);
 });

 it.each([
  {origin:"ATH",destination:"FCO"},{origin:"tlv"},{destination:"TLV"},
  {departDate:"2027-02-30"},{returnDate:"2027-06-01"},{returnDate:"2027-05-30"},
  {departDate:"2026-10-07"},{departDate:"2027-06-01?token=x"},
 ])("rejects unsupported or invalid trip %j without storage",async change=>{
  const {db,store}=setup(),invalid={...trip,...change};
  expect(await store.enqueueAegean(invalid)).toBe(false);
  expect(await store.claimAegean(invalid)).toBe(false);
  expect(await store.completeAegean(invalid,now.toISOString())).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS n FROM aegean_pending").get()?.n).toBe(0);
 });

 it("stores and returns only route and exact date fields, with no passenger or caller data",async()=>{
  const {db,store}=setup();
  await store.enqueueAegean({...trip,email:"private@example.com",password:"never-store",adults:5,sourceUrl:"https://evil.example"} as AegeanCalendarTrip);
  expect(await store.pendingAegean()).toEqual([trip]);
  const row=db.prepare("SELECT * FROM aegean_pending").get();
  expect(JSON.stringify(row)).not.toContain("private@example");expect(JSON.stringify(row)).not.toContain("never-store");
  expect(JSON.stringify(row)).not.toContain("evil.example");expect(row).not.toHaveProperty("adults");
 });

 it("retains at most 64 recent requests even when every request shares one clock millisecond",async()=>{
  const {db,store}=setup();
  for(let i=0;i<65;i++)await store.enqueueAegean({...trip,departDate:date(i),returnDate:date(i+4)});
  expect(db.prepare("SELECT COUNT(*) AS n FROM aegean_pending").get()?.n).toBe(64);
  expect(await store.claimAegean({...trip,departDate:date(0),returnDate:date(4)})).toBe(false);
  expect(await store.claimAegean({...trip,departDate:date(64),returnDate:date(68)})).toBe(true);
  expect(await store.pendingAegean(12)).toHaveLength(12);
 });

 it("renews duplicate activity and expires active requests at exactly thirty minutes",async()=>{
  const {db,store}=setup();await store.enqueueAegean(trip);
  vi.setSystemTime(new Date(now.getTime()+20*60_000));await store.enqueueAegean(trip);
  vi.setSystemTime(new Date(now.getTime()+AEGEAN_DEMAND_ACTIVE_MS));expect(await store.pendingAegean()).toEqual([trip]);
  vi.setSystemTime(new Date(now.getTime()+50*60_000));expect(await store.pendingAegean()).toEqual([]);
  expect(await store.claimAegean(trip)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS n FROM aegean_pending").get()?.n).toBe(1); // Polling never mutates storage.
  await store.enqueueAegean({...trip,returnDate:"2027-06-06"});
  expect(db.prepare("SELECT COUNT(*) AS n FROM aegean_pending").get()?.n).toBe(1);
 });

 it("keeps pending polling read-only and atomically claims one attempt per cooldown",async()=>{
  const {db,store}=setup();await store.enqueueAegean(trip);
  const original=db.prepare("SELECT * FROM aegean_pending").get();
  expect(await store.pendingAegean()).toEqual([trip]);expect(await store.pendingAegean()).toEqual([trip]);
  expect(db.prepare("SELECT * FROM aegean_pending").get()).toEqual(original);
  const claims=await Promise.all(Array.from({length:5},()=>store.claimAegean(trip)));
  expect(claims.filter(Boolean)).toHaveLength(1);expect(await store.pendingAegean()).toEqual([]);
  await store.enqueueAegean(trip); // Repeated user demand cannot bypass attempt backoff.
  vi.setSystemTime(new Date(now.getTime()+AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS-1));
  expect(await store.claimAegean(trip)).toBe(false);expect(await store.pendingAegean()).toEqual([]);
  vi.setSystemTime(new Date(now.getTime()+AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS));
  expect(await store.pendingAegean()).toEqual([trip]);expect(await instance(db).claimAegean(trip)).toBe(true);
 });

 it.each([0,-1,13,100,1.5,NaN,Infinity])("rejects unsafe polling limit %s",async limit=>{
  const {store}=setup();await store.enqueueAegean(trip);expect(await store.pendingAegean(limit)).toEqual([]);
 });

 it("acknowledges only an existing exact trip and preserves original completion freshness",async()=>{
  const {db,store}=setup();await store.enqueueAegean(trip);await store.claimAegean(trip);
  expect(await store.completeAegean({...trip,returnDate:"2027-06-06"},now.toISOString())).toBe(false);
  const capture=new Date(now.getTime()-60_000).toISOString();
  expect(await store.completeAegean(trip,capture)).toBe(true);expect(await store.pendingAegean()).toEqual([]);
  expect(db.prepare("SELECT completed_at FROM aegean_pending").get()?.completed_at).toBe(Date.parse(capture));
  expect(await store.enqueueAegean(trip)).toBe(false);
  vi.setSystemTime(new Date(Date.parse(capture)+600_000));
  expect(await store.enqueueAegean(trip)).toBe(true);expect(await store.pendingAegean()).toEqual([trip]);
 });

 it.each(["2026-10-08T12:00:00.001Z","2026-10-08T11:50:00.000Z","2026-10-08T12:00:00Z","2026-10-08T14:00:00.000+02:00","2026-10-08T12:00:00","garbage"]) ("refuses invalid, noncanonical, future or stale capture %s",async capture=>{
  const {store}=setup();await store.enqueueAegean(trip);
  expect(await store.completeAegean(trip,capture)).toBe(false);expect(await store.pendingAegean()).toEqual([trip]);
 });
});

describe("on-demand queue coordination",()=>{
 function namespace(collect:ReturnType<typeof vi.fn>,queue:Record<string,unknown>){
  return {getByName:vi.fn((name:string)=>name===AEGEAN_DEMAND_OBJECT?queue:{collectAegean:collect})} as unknown as FareStoreNamespace;
 }
 it("enqueues the exact supported trip before a failed direct collection for external polling",async()=>{
  setup();const order:string[]=[];
  const enqueueAegean=vi.fn(async()=>{order.push("enqueue");return true;}),collect=vi.fn(async()=>{order.push("collect");return null;});
  const ns=namespace(collect,{enqueueAegean});
  expect(await getOrCollectAegean(ns,{...trip,email:"not-forwarded"} as AegeanCalendarTrip)).toBeNull();
  expect(order).toEqual(["enqueue","collect"]);expect(enqueueAegean).toHaveBeenCalledWith(trip);expect(collect).toHaveBeenCalledWith(trip);
 });

 it("keeps active requests visibly pending through claim cooldown and clears them only after acknowledgement",async()=>{
  const {store}=setup();
  expect(await store.enqueueAegean(trip)).toBe(true);
  expect(await store.hasPendingAegean(trip)).toBe(true);
  expect(await store.claimAegean(trip)).toBe(true);
  vi.advanceTimersByTime(30_000);
  expect(await store.pendingAegean()).toEqual([]);
  expect(await store.hasPendingAegean(trip)).toBe(true);
  const checkedAt=new Date(now.getTime()+30_000).toISOString();
  expect(await store.completeAegean(trip,checkedAt)).toBe(true);
  expect(await store.hasPendingAegean(trip)).toBe(false);
 });

 it("reports pending only after actual queue acceptance when no valid fare was returned",async()=>{
  setup();
  for(const accepted of [true,false]){
   const onPending=vi.fn(),collect=vi.fn().mockRejectedValue(Error("upstream failure"));
   expect(await getOrCollectAegean(namespace(collect,{enqueueAegean:vi.fn(async()=>accepted)}),trip,onPending)).toBeNull();
   expect(onPending).toHaveBeenCalledTimes(accepted?1:0);
  }
 });

 it("acknowledges a valid successfully collected snapshot with its original capture",async()=>{
  setup();const checkedAt=new Date(now.getTime()-1000).toISOString();
  const fare={...trip,amount:232.37,currency:"EUR",outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(trip),checkedAt,pricing:"published_advertisement",carrier:null};
  const enqueueAegean=vi.fn(async()=>true),completeAegean=vi.fn(async()=>true),collect=vi.fn(async()=>fare);
  expect(await getOrCollectAegean(namespace(collect,{enqueueAegean,completeAegean}),trip)).toEqual(fare);
  expect(completeAegean).toHaveBeenCalledWith(trip,checkedAt);
 });

 it("does not complete malformed results and isolates queue failures from direct collection",async()=>{
  setup();const enqueueAegean=vi.fn().mockRejectedValue(Error("queue unavailable")),completeAegean=vi.fn();
  const collect=vi.fn(async()=>({checkedAt:now.toISOString()}));
  expect(await getOrCollectAegean(namespace(collect,{enqueueAegean,completeAegean}),trip)).toBeNull();
  expect(collect).toHaveBeenCalledOnce();expect(completeAegean).not.toHaveBeenCalled();
 });

 it("does not enqueue rendered-only, past or invalid trips and supports old optional RPC mocks",async()=>{
  setup();const enqueueAegean=vi.fn(),collect=vi.fn(async()=>null),ns=namespace(collect,{enqueueAegean});
  for(const selected of [{...trip,origin:"ATH",destination:"FCO"},{...trip,departDate:"2026-10-07"},{...trip,returnDate:"2027-02-30"}])expect(await getOrCollectAegean(ns,selected)).toBeNull();
  expect(enqueueAegean).not.toHaveBeenCalled();expect(collect).toHaveBeenCalledTimes(2);
  expect(await getOrCollectAegean(namespace(collect,{}),trip)).toBeNull();expect(collect).toHaveBeenCalledTimes(3);
 });
});
