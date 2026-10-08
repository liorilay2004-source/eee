import {aegeanCalendarUrl,type AegeanCalendarTrip} from "./aegean-lowfare";
import {validateAegeanCalendar} from "./aegean-calendar-cache";
import {cacheRequest} from "./public-fare-cache";
import type {FareStoreNamespace} from "./shared-fare-cache";
export async function getOrCollectAegean(namespace:FareStoreNamespace,trip:AegeanCalendarTrip){
 const selected={origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate};
 try {
  const key=aegeanCalendarUrl(selected);
  const fare=await namespace.getByName(cacheRequest(key).url).collectAegean(selected);
  return validateAegeanCalendar(fare,selected,new Date());
 }catch{return null;}
}
