import * as renderer from "../src/aegean-lowfare-rendered";
import * as httpCalendar from "../src/aegean-http-calendar";
import {aegeanCalendarUrl} from "../src/aegean-lowfare";
import {afterEach,it,expect,vi} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {FareStore} from "../src/fare-store";
import {createSharedFareCache,type FareStoreNamespace} from "../src/shared-fare-cache";
import {TURKISH_ATHENS_PAGE} from "../src/turkish-rendered";
const now=new Date("2026-10-08T05:30:00Z");
const key=TURKISH_ATHENS_PAGE;
const payload=(at=now.getTime(),expires=at+3600000)=>JSON.stringify({storedAt:at,expires,fares:[{amount:7237.73,currency:"TRY",checkedAt:now.toISOString()}]});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function instance(db:DatabaseSync,env:Record<string,unknown>={}):FareStore {
 const ctx={blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>fn(),storage:{sql:{exec:(sql:string,...args:(string|number)[])=>{
  const statement=db.prepare(sql);
  const rows=/^(SELECT|INSERT.*RETURNING)/.test(sql)?statement.all(...args):(statement.run(...args),[]);
  return {toArray:()=>rows};
 }}}};
 return new FareStore(ctx as unknown as DurableObjectState,env);
}
it("retains the single latest snapshot across object reconstruction, without appending history",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const db=new DatabaseSync(":memory:");
 await instance(db).write(key,payload());
 const restored=instance(db);expect(await restored.read(key)).toBe(payload());
 await restored.write(key,payload(now.getTime()-1000));
 expect(await restored.read(key)).toBe(payload());
 expect(db.prepare("SELECT COUNT(*) AS n FROM snapshot").get()?.n).toBe(1);
 vi.setSystemTime(new Date(now.getTime()+3600000));expect(await restored.read(key)).toBeNull();db.close();
});
it("rejects unsafe keys, future/expired/excess lifetime, malformed and oversized payloads",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);const db=new DatabaseSync(":memory:"),store=instance(db);
 for(const body of [payload(now.getTime()+1),payload(now.getTime(),now.getTime()),payload(now.getTime(),now.getTime()+3600001),"not json","x".repeat(500001)])await expect(store.write(key,body)).rejects.toThrow();
 await expect(store.write(key+"?token=x",payload())).rejects.toThrow();
 expect(db.prepare("SELECT COUNT(*) AS n FROM snapshot").get()?.n).toBe(0);db.close();
});
it("shares a snapshot between independent regional caches without extending its expiry",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const objects=new Map<string,FareStore>(),dbs:DatabaseSync[]=[];
 const namespace:FareStoreNamespace={getByName(name){if(!objects.has(name)){const db=new DatabaseSync(":memory:");dbs.push(db);objects.set(name,instance(db));}return objects.get(name)!;}};
 const edge=()=>({match:async()=>undefined,put:async()=>{}}) as unknown as Cache;
 const first=createSharedFareCache(namespace,edge(),now,3600000);
 await first.put(key,[{amount:7237.73,currency:"TRY"}]);
 const later=new Date(now.getTime()+30000);vi.setSystemTime(later);
 const other=createSharedFareCache(namespace,edge(),later,3600000);
 expect(await other.get(key)).toEqual({fares:[{amount:7237.73,currency:"TRY"}],expires:now.getTime()+3600000});
 expect(objects.size).toBe(1);
 vi.setSystemTime(new Date(now.getTime()+3600000));
 expect(await createSharedFareCache(namespace,edge(),new Date(),3600000).get(key)).toBeNull();
 for(const db of dbs)db.close();
});
it("keeps regional data usable when shared storage fails, and rejects unknown keys before RPC",async()=>{
 const rows=new Map<string,Response>(),getByName=vi.fn(()=>{throw Error("unavailable");});
 const edge={match:async(q:Request)=>rows.get(q.url)?.clone(),put:async(q:Request,r:Response)=>{rows.set(q.url,r.clone());}} as unknown as Cache;
 const cache=createSharedFareCache({getByName},edge,now,3600000);
 await cache.put(key,[{amount:1}]);expect((await cache.get(key))?.fares).toEqual([{amount:1}]);
 getByName.mockClear();expect(await cache.get("https://evil.example/x")).toBeNull();expect(getByName).not.toHaveBeenCalled();
});

it("atomically reserves no more than eight Aegean browser attempts in a day",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);const db=new DatabaseSync(":memory:"),store=instance(db);
 const claims=await Promise.all(Array.from({length:12},()=>store.reserveAegean()));
 expect(claims.filter(Boolean)).toHaveLength(8);
 expect(await instance(db).reserveAegean()).toBe(false);
 vi.setSystemTime(new Date(now.getTime()+86400000));expect(await store.reserveAegean()).toBe(true);db.close();
});
it("coalesces rendered exact-date collection and retains its result without D1",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const trip={origin:"ATH",destination:"FCO",departDate:"2027-06-01",returnDate:"2027-06-05"};
 const fare={...trip,amount:232.37,currency:"EUR" as const,outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(trip),checkedAt:now.toISOString(),pricing:"published_advertisement" as const,carrier:null};
 const load=vi.spyOn(renderer,"loadRenderedAegeanCalendar").mockResolvedValue(fare);
 const objects=new Map<string,FareStore>(),dbs:DatabaseSync[]=[];
 const ns:FareStoreNamespace={getByName(name){if(!objects.has(name)){const db=new DatabaseSync(":memory:");dbs.push(db);objects.set(name,instance(db,{BROWSER:{quickAction:vi.fn()},PUBLIC_FARES:ns}));}return objects.get(name)!;}};
 const store=ns.getByName("trip");
 expect(await Promise.all([store.collectAegean(trip),store.collectAegean(trip)])).toEqual([fare,fare]);
 expect(load).toHaveBeenCalledTimes(1);
 expect(await store.collectAegean(trip)).toEqual(fare);expect(load).toHaveBeenCalledTimes(1);
 for(const db of dbs)db.close();
});
it("failed renders consume quota and cannot repeat immediately",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const load=vi.spyOn(renderer,"loadRenderedAegeanCalendar").mockRejectedValue(Error("unavailable"));
 const db=new DatabaseSync(":memory:"),budgetDb=new DatabaseSync(":memory:"),budget=instance(budgetDb);
 const ns={getByName:()=>budget};
 const store=instance(db,{BROWSER:{quickAction:vi.fn()},PUBLIC_FARES:ns});
 const trip={origin:"ATH",destination:"FCO",departDate:"2027-06-01",returnDate:"2027-06-05"};
 expect(await store.collectAegean(trip)).toBeNull();expect(await store.collectAegean(trip)).toBeNull();
 expect(load).toHaveBeenCalledTimes(1);expect(budgetDb.prepare("SELECT used FROM allowance").get()?.used).toBe(1);
 db.close();budgetDb.close();
});

it("collects the observed HTTP route without Browser, quota reservations or D1 and preserves capture age",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const trip={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
 const fare={...trip,amount:232.37,currency:"EUR" as const,outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(trip),checkedAt:now.toISOString(),pricing:"published_advertisement" as const,carrier:null,outboundUpdatedAt:"2026-10-07T00:00:00.000Z",inboundUpdatedAt:"2026-10-07T00:00:00.000Z",vendorUpdated:{outbound:'"/Date(1791331200000)/"',inbound:'"/Date(1791331200000)/"'}};
 const load=vi.spyOn(httpCalendar,"loadHttpAegeanCalendar").mockImplementation(async()=>{vi.setSystemTime(new Date(now.getTime()+10000));return fare;});
 const render=vi.spyOn(renderer,"loadRenderedAegeanCalendar");
 const db=new DatabaseSync(":memory:"),store=instance(db);
 expect(await Promise.all([store.collectAegean(trip),store.collectAegean(trip)])).toEqual([fare,fare]);
 expect(load).toHaveBeenCalledOnce();expect(render).not.toHaveBeenCalled();
 expect(JSON.parse((await store.read(aegeanCalendarUrl(trip)))!)).toEqual({storedAt:now.getTime(),expires:now.getTime()+600000,fares:[fare]});
 expect(await store.collectAegean(trip)).toEqual(fare);expect(load).toHaveBeenCalledOnce();
 vi.setSystemTime(new Date(now.getTime()+600000));expect(await store.read(aegeanCalendarUrl(trip))).toBeNull();db.close();
});

it("backs off failed public HTTP without consuming browser allowance or replacing an expired snapshot",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const load=vi.spyOn(httpCalendar,"loadHttpAegeanCalendar").mockRejectedValue(Error("unavailable"));
 const render=vi.spyOn(renderer,"loadRenderedAegeanCalendar"),getByName=vi.fn();
 const db=new DatabaseSync(":memory:"),store=instance(db,{BROWSER:{quickAction:vi.fn()},PUBLIC_FARES:{getByName}});
 const trip={origin:"ATH",destination:"TLV",departDate:"2027-06-01",returnDate:"2027-06-05"};
 expect(await store.collectAegean(trip)).toBeNull();expect(await store.collectAegean(trip)).toBeNull();
 expect(load).toHaveBeenCalledOnce();expect(render).not.toHaveBeenCalled();expect(getByName).not.toHaveBeenCalled();
 expect(db.prepare("SELECT COUNT(*) AS n FROM snapshot").get()?.n).toBe(0);
 vi.setSystemTime(new Date(now.getTime()+300000));await store.collectAegean(trip);expect(load).toHaveBeenCalledTimes(2);db.close();
});
