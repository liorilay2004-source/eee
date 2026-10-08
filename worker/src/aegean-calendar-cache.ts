import {aegeanCalendarUrl,type AegeanCalendarFare,type AegeanCalendarTrip} from "./aegean-lowfare";
import {loadRenderedAegeanCalendar} from "./aegean-lowfare-rendered";
import type {PublicFareCache} from "./public-fare-cache";
import type {Env} from "./types";

export const AEGEAN_CALENDAR_MAX_AGE_MS=6*3600000;
export async function collectAegeanCalendar(browser:NonNullable<Env["BROWSER"]>,trip:AegeanCalendarTrip,now:Date,cache:PublicFareCache,db?:D1Database) {
  const fare=await loadRenderedAegeanCalendar(browser,trip,now);
  if(fare){await cache.put(aegeanCalendarUrl(trip),[fare]);
    if(db)try{await saveAegeanCalendar(db,fare,now);}catch{/* A storage outage does not discard a verified public fare. */}
  }
  return fare;
}

/** One selected round trip only; never combine context-dependent calendar rows. */
export async function readAegeanCalendar(cache:PublicFareCache|undefined,trip:AegeanCalendarTrip,now:Date,db?:D1Database):Promise<AegeanCalendarFare|null> {
  let key:string;try{key=aegeanCalendarUrl(trip);}catch{return null;}
  const stored=await cache?.get<AegeanCalendarFare>(key);
  if(stored?.fares.length===1)return validateAegeanCalendar(stored.fares[0],trip,now);
  if(!db)return null;
  try{
    const row=await db.prepare("SELECT fare_json,checked_at FROM public_trip_snapshots WHERE source=? AND origin=? AND destination=? AND depart_date=? AND return_date=?")
      .bind("aegean",trip.origin,trip.destination,trip.departDate,trip.returnDate).first<{fare_json:string;checked_at:string}>();
    if(!row||typeof row.fare_json!=="string"||new TextEncoder().encode(row.fare_json).byteLength>4000)return null;
    const raw=JSON.parse(row.fare_json);if(raw?.checkedAt!==row.checked_at)return null;
    return validateAegeanCalendar(raw,trip,now);
  }catch{return null;}
}

export function validateAegeanCalendar(raw:unknown,trip:AegeanCalendarTrip,now:Date):AegeanCalendarFare|null {
  let key:string;try{key=aegeanCalendarUrl(trip);}catch{return null;}
  if(!raw||typeof raw!=="object")return null;
  const fare=raw as AegeanCalendarFare;
  const age=now.getTime()-Date.parse(fare.checkedAt);
  if(!Number.isFinite(age)||age<0||age>=AEGEAN_CALENDAR_MAX_AGE_MS||trip.departDate<now.toISOString().slice(0,10)||fare.bookingUrl!==key||fare.currency!=="EUR"||fare.carrier!==null||fare.pricing!=="published_advertisement")return null;
  if(["origin","destination","departDate","returnDate"].some(k=>fare[k as keyof AegeanCalendarTrip]!==trip[k as keyof AegeanCalendarTrip]))return null;
  if(![fare.amount,fare.outboundAmount,fare.inboundAmount].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>0&&n<=100000))return null;
  if(Math.round(fare.amount*100)!==Math.round(fare.outboundAmount*100)+Math.round(fare.inboundAmount*100))return null;
  return fare;
}

export async function saveAegeanCalendar(db:D1Database,fare:AegeanCalendarFare,now:Date):Promise<void> {
  if(!validateAegeanCalendar(fare,fare,now)||fare.checkedAt!==now.toISOString())throw new Error("Invalid Aegean trip snapshot");
  const json=JSON.stringify(fare);if(new TextEncoder().encode(json).byteLength>4000)throw new Error("Trip snapshot too large");
  await db.prepare("INSERT INTO public_trip_snapshots (source,origin,destination,depart_date,return_date,fare_json,checked_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,origin,destination,depart_date,return_date) DO UPDATE SET fare_json=excluded.fare_json,checked_at=excluded.checked_at")
    .bind("aegean",fare.origin,fare.destination,fare.departDate,fare.returnDate,json,fare.checkedAt).run();
}
