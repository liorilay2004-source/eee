import {aegeanCalendarUrl,type AegeanCalendarTrip} from "./aegean-lowfare";
import {validateAegeanCalendar} from "./aegean-calendar-cache";
import {cacheRequest} from "./public-fare-cache";
import type {FareStoreNamespace} from "./shared-fare-cache";
import {aegeanHttpCalendarUrl} from "./aegean-http-calendar";

/** One global queue, separate from the per-calendar snapshot objects and browser allowance. */
export const AEGEAN_DEMAND_OBJECT="aegean-selected-trips:v1";

/** Storage-only status; no collection, enqueueing, mutation, browser or airline request. */
export async function hasPendingAegean(namespace:FareStoreNamespace|undefined,trip:AegeanCalendarTrip):Promise<boolean>{
 try{
  const selected={origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate};
  aegeanHttpCalendarUrl(selected);
  if(selected.departDate<new Date().toISOString().slice(0,10))return false;
  return await namespace?.getByName(AEGEAN_DEMAND_OBJECT).hasPendingAegean?.(selected)===true;
 }catch{return false;}
}

export async function getOrCollectAegean(namespace:FareStoreNamespace,trip:AegeanCalendarTrip,onPending?:()=>void){
 const selected={origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate};
 let queued=false;
 try {
  const key=aegeanCalendarUrl(selected);
  let publicHttp=false;
  try{aegeanHttpCalendarUrl(selected);publicHttp=selected.departDate>=new Date().toISOString().slice(0,10);}catch{/* Other routes retain the existing rendered path. */}
  if(publicHttp)try{queued=await namespace.getByName(AEGEAN_DEMAND_OBJECT).enqueueAegean?.(selected)===true;}catch{/* Demand storage cannot block the direct attempt. */}
  const fare=await namespace.getByName(cacheRequest(key).url).collectAegean(selected);
  const valid=validateAegeanCalendar(fare,selected,new Date());
  if(publicHttp&&valid)try{await namespace.getByName(AEGEAN_DEMAND_OBJECT).completeAegean?.(selected,valid.checkedAt);}catch{/* The snapshot stays usable if queue acknowledgement fails. */}
  if(queued&&!valid)onPending?.();
  return valid;
 }catch{if(queued)onPending?.();return null;}
}
