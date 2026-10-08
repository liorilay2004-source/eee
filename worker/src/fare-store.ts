import {DurableObject} from "cloudflare:workers";
import {cacheRequest,publicFareMaximumAge,publicFareMaximumRows} from "./public-fare-cache";
import {aegeanCalendarUrl,type AegeanCalendarTrip,type AegeanCalendarFare} from "./aegean-lowfare";
import {AEGEAN_CALENDAR_MAX_AGE_MS,validateAegeanCalendar} from "./aegean-calendar-cache";
import {loadRenderedAegeanCalendar} from "./aegean-lowfare-rendered";
import {aegeanHttpCalendarUrl,loadHttpAegeanCalendar} from "./aegean-http-calendar";
import type {Env} from "./types";
export const AEGEAN_DEMAND_MAX_PENDING=64;
export const AEGEAN_DEMAND_ACTIVE_MS=30*60_000;
export const AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS=5*60_000;

/** Only the two observed public controller routes; extra caller fields never enter storage. */
function demandTrip(raw:unknown,now:Date):AegeanCalendarTrip|null {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const input=raw as Record<string,unknown>;
 if(["origin","destination","departDate","returnDate"].some(field=>typeof input[field]!=="string"))return null;
 const trip={origin:input.origin as string,destination:input.destination as string,departDate:input.departDate as string,returnDate:input.returnDate as string};
 try{aegeanHttpCalendarUrl(trip);}catch{return null;}
 return trip.departDate>=now.toISOString().slice(0,10)?trip:null;
}

/** One bounded snapshot per official page/calendar. No search logs, credentials or passengers. */
export class FareStore extends DurableObject<Record<string,unknown>> {
 private collection:Promise<AegeanCalendarFare|null>|null=null;
 constructor(ctx:DurableObjectState,env:Record<string,unknown>){
  super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL, payload TEXT NOT NULL, stored_at INTEGER NOT NULL, expires INTEGER NOT NULL)");
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS allowance (day TEXT PRIMARY KEY, used INTEGER NOT NULL)");
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS collection_state (id INTEGER PRIMARY KEY CHECK(id=1), attempted_at INTEGER NOT NULL)");
   ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS aegean_pending (source_key TEXT PRIMARY KEY, origin TEXT NOT NULL, destination TEXT NOT NULL, depart_date TEXT NOT NULL, return_date TEXT NOT NULL, requested_at INTEGER NOT NULL, requested_order INTEGER NOT NULL, expires INTEGER NOT NULL, attempted_at INTEGER, completed_at INTEGER)");
  });
 }
 /** New requests renew activity, while duplicate requests keep any outstanding attempt's cooldown. */
 async enqueueAegean(input:AegeanCalendarTrip):Promise<boolean>{
  const now=new Date(),trip=demandTrip(input,now);if(!trip)return false;
  const time=now.getTime(),key=aegeanCalendarUrl(trip);
  this.ctx.storage.sql.exec("DELETE FROM aegean_pending WHERE expires<=?",time);
  this.ctx.storage.sql.exec("INSERT INTO aegean_pending (source_key,origin,destination,depart_date,return_date,requested_at,requested_order,expires) VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(requested_order),0)+1 FROM aegean_pending),?) ON CONFLICT(source_key) DO UPDATE SET requested_at=excluded.requested_at,requested_order=excluded.requested_order,expires=excluded.expires,completed_at=CASE WHEN aegean_pending.completed_at>? THEN aegean_pending.completed_at ELSE NULL END",key,trip.origin,trip.destination,trip.departDate,trip.returnDate,time,time+AEGEAN_DEMAND_ACTIVE_MS,time-AEGEAN_CALENDAR_MAX_AGE_MS);
  // At most 64 rows, including fulfilled tombstones. Recent demand has priority over older requests.
  this.ctx.storage.sql.exec("DELETE FROM aegean_pending WHERE source_key IN (SELECT source_key FROM aegean_pending ORDER BY requested_order DESC LIMIT -1 OFFSET ?)",AEGEAN_DEMAND_MAX_PENDING);
  return this.ctx.storage.sql.exec("SELECT source_key FROM aegean_pending WHERE source_key=? AND completed_at IS NULL",key).toArray().length===1;
 }
 /** Read-only polling. A separate atomic claim records attempts before external collection. */
 async pendingAegean(limit=12):Promise<AegeanCalendarTrip[]>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>12)return [];
  const now=new Date(),time=now.getTime();
  const rows=this.ctx.storage.sql.exec<{origin:string;destination:string;depart_date:string;return_date:string}>("SELECT origin,destination,depart_date,return_date FROM aegean_pending WHERE requested_at<=? AND expires>? AND completed_at IS NULL AND (attempted_at IS NULL OR attempted_at<=?) ORDER BY requested_order ASC LIMIT ?",time,time,time-AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS,limit).toArray();
  return rows.flatMap(row=>{const trip=demandTrip({origin:row.origin,destination:row.destination,departDate:row.depart_date,returnDate:row.return_date},now);return trip?[trip]:[];});
 }
 /** Read-only exact status. Claim cooldown does not remove an unfinished request from the waiting UI. */
 async hasPendingAegean(input:AegeanCalendarTrip):Promise<boolean>{
  const now=new Date(),trip=demandTrip(input,now);if(!trip)return false;
  const time=now.getTime();
  return this.ctx.storage.sql.exec("SELECT source_key FROM aegean_pending WHERE source_key=? AND requested_at<=? AND expires>? AND completed_at IS NULL",aegeanCalendarUrl(trip),time,time).toArray().length===1;
 }
 async claimAegean(input:AegeanCalendarTrip):Promise<boolean>{
  const now=new Date(),trip=demandTrip(input,now);if(!trip)return false;
  const time=now.getTime();
  return this.ctx.storage.sql.exec("UPDATE aegean_pending SET attempted_at=? WHERE source_key=? AND requested_at<=? AND expires>? AND completed_at IS NULL AND (attempted_at IS NULL OR attempted_at<=?) RETURNING source_key",time,aegeanCalendarUrl(trip),time,time,time-AEGEAN_DEMAND_ATTEMPT_COOLDOWN_MS).toArray().length===1;
 }
 /** Acknowledges a stored exact-trip observation using its original capture, never the ingestion clock. */
 async completeAegean(input:AegeanCalendarTrip,checkedAt:string):Promise<boolean>{
  const now=new Date(),trip=demandTrip(input,now);if(!trip||typeof checkedAt!=="string")return false;
  const captured=Date.parse(checkedAt),age=now.getTime()-captured;
  if(!Number.isFinite(captured)||new Date(captured).toISOString()!==checkedAt||age<0||age>=AEGEAN_CALENDAR_MAX_AGE_MS)return false;
  return this.ctx.storage.sql.exec("UPDATE aegean_pending SET completed_at=? WHERE source_key=? AND expires>? AND (completed_at IS NULL OR completed_at<=?) RETURNING source_key",captured,aegeanCalendarUrl(trip),now.getTime(),captured).toArray().length===1;
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
