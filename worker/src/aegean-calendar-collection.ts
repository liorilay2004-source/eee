import {aegeanCalendarUrl,type AegeanCalendarTrip} from "./aegean-lowfare";
import {collectAegeanCalendar,readAegeanCalendar} from "./aegean-calendar-cache";
import type {PublicFareCache} from "./public-fare-cache";
import type {Env} from "./types";

/** At most one browser job per scheduled invocation, using recent exact-date demand. */
export async function collectRecentAegeanCalendar(env:Env,now:Date,cache:PublicFareCache):Promise<{collected:number;skipped:boolean}> {
  if(!env.BROWSER||env.AEGEAN_PUBLISHED_ENABLED!=="true")return {collected:0,skipped:true};
  let rows:DemandRow[];
  try{
    const result=await env.DB.prepare("SELECT window_start,window_end,stay_min,stay_max,pax_json FROM searches WHERE origin=? AND destination=? AND created_at>=? ORDER BY created_at DESC LIMIT 12")
      .bind("TLV","ATH",new Date(now.getTime()-86400000).toISOString()).all<DemandRow>();
    rows=result.results;
  }catch{return {collected:0,skipped:true};}
  const seen=new Set<string>();
  for(const row of rows){
    const trip=aegeanDemandTrip(row,now);if(!trip)continue;
    const key=aegeanCalendarUrl(trip);if(seen.has(key))continue;seen.add(key);
    if(await readAegeanCalendar(cache,trip,now,env.DB))continue;
    const fare=await collectAegeanCalendar(env.BROWSER,trip,now,cache,env.DB);
    return {collected:fare?1:0,skipped:false};
  }
  return {collected:0,skipped:true};
}
interface DemandRow {window_start:string;window_end:string;stay_min:number;stay_max:number;pax_json:string}
export function aegeanDemandTrip(row:DemandRow,now:Date):AegeanCalendarTrip|null {
  const trip={origin:"TLV",destination:"ATH",departDate:row.window_start,returnDate:row.window_end};
  try{
    aegeanCalendarUrl(trip);
    if(trip.departDate<now.toISOString().slice(0,10)||row.pax_json.length>1000)return null;
    const party=JSON.parse(row.pax_json);
    if(party.adults!==1||party.children!==0||party.infants!==0)return null;
    const nights=(Date.parse(trip.returnDate)-Date.parse(trip.departDate))/86400000;
    if(row.stay_min!==nights||row.stay_max!==nights)return null;
    return trip;
  }catch{return null;}
}
