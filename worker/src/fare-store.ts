import {DurableObject} from "cloudflare:workers";
import {cacheRequest,publicFareMaximumAge,publicFareMaximumRows} from "./public-fare-cache";
import {aegeanCalendarUrl,type AegeanCalendarTrip,type AegeanCalendarFare} from "./aegean-lowfare";
import {AEGEAN_CALENDAR_MAX_AGE_MS,validateAegeanCalendar} from "./aegean-calendar-cache";
import {loadRenderedAegeanCalendar} from "./aegean-lowfare-rendered";
import {loadHttpAegeanCalendar} from "./aegean-http-calendar";
import type {Env} from "./types";
/** One bounded snapshot per official page/calendar. No search logs, credentials or passengers. */
export class FareStore extends DurableObject<Record<string,unknown>> {
 private collection:Promise<AegeanCalendarFare|null>|null=null;
 constructor(ctx:DurableObjectState,env:Record<string,unknown>){
  super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL, payload TEXT NOT NULL, stored_at INTEGER NOT NULL, expires INTEGER NOT NULL)");
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS allowance (day TEXT PRIMARY KEY, used INTEGER NOT NULL)");
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS collection_state (id INTEGER PRIMARY KEY CHECK(id=1), attempted_at INTEGER NOT NULL)");
  });
 }
 /** A separate daily coordination object reserves BEFORE any browser request, even failed ones. */
 async reserveAegean():Promise<boolean>{
  const day=new Date().toISOString().slice(0,10);
  return this.ctx.storage.sql.exec("INSERT INTO allowance(day,used) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<8 RETURNING used",day).toArray().length===1;
 }
 async collectAegean(input:AegeanCalendarTrip):Promise<AegeanCalendarFare|null>{
  const trip={origin:input.origin,destination:input.destination,departDate:input.departDate,returnDate:input.returnDate};
  const key=aegeanCalendarUrl(trip),now=new Date();
  if(trip.departDate<now.toISOString().slice(0,10))return null;
  if(this.collection)return this.collection;
  const bindings=this.env as Pick<Env,"BROWSER"|"PUBLIC_FARES">;
  const publicHttp=(trip.origin==="TLV"&&trip.destination==="ATH")||(trip.origin==="ATH"&&trip.destination==="TLV");
  if(!publicHttp&&(!bindings.BROWSER||!bindings.PUBLIC_FARES))return null;
  this.collection=(async()=>{
   const stored=await this.read(key);
   if(stored){const fare=validateAegeanCalendar(JSON.parse(stored).fares?.[0],trip,now);if(fare)return fare;}
   const prior=this.ctx.storage.sql.exec<{attempted_at:number}>("SELECT attempted_at FROM collection_state WHERE id=1").toArray()[0];
   if(prior&&now.getTime()-prior.attempted_at<300000)return null;
   this.ctx.storage.sql.exec("INSERT INTO collection_state(id,attempted_at) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at",now.getTime());
   try {
    // Observed public HTTP routes never reserve or fall back to Browser Rendering.
    if(!publicHttp){
     const allowed=await bindings.PUBLIC_FARES!.getByName("aegean-browser-budget:"+now.toISOString().slice(0,10)).reserveAegean();
     if(!allowed)return null;
    }
    const collected=publicHttp?await loadHttpAegeanCalendar(trip,now):await loadRenderedAegeanCalendar(bindings.BROWSER!,trip,now);
    const fare=validateAegeanCalendar(collected,trip,new Date());
    if(!fare)return null;
    const captured=Date.parse(fare.checkedAt);
    await this.write(key,JSON.stringify({storedAt:captured,expires:captured+AEGEAN_CALENDAR_MAX_AGE_MS,fares:[fare]}));
    return fare;
   }catch{return null;}
  })();
  try{return await this.collection;}finally{this.collection=null;}
 }
 async read(key:string):Promise<string|null>{
  cacheRequest(key);
  const rows=this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM snapshot WHERE id=1 AND source_key=? AND expires>?",key,Date.now()).toArray();
  return rows[0]?.payload??null;
 }
 async write(key:string,payload:string):Promise<void>{
  cacheRequest(key);
  if(typeof payload!=="string"||new TextEncoder().encode(payload).byteLength>500000)throw new Error("Invalid public fare snapshot");
  const data=JSON.parse(payload),now=Date.now();
  if(!Number.isFinite(data.storedAt)||data.storedAt>now||!Number.isFinite(data.expires)||data.expires<=now||data.expires>data.storedAt+publicFareMaximumAge(key)||!Array.isArray(data.fares)||data.fares.length>publicFareMaximumRows(key))throw new Error("Invalid public fare lifetime");
  const previous=this.ctx.storage.sql.exec<{stored_at:number}>("SELECT stored_at FROM snapshot WHERE id=1").toArray()[0];
  if(previous&&previous.stored_at>data.storedAt)return;
  this.ctx.storage.sql.exec("INSERT INTO snapshot (id,source_key,payload,stored_at,expires) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,payload=excluded.payload,stored_at=excluded.stored_at,expires=excluded.expires",key,payload,data.storedAt,data.expires);
 }
}
