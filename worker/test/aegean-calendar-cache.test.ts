import {it,expect} from "vitest";
import {readAegeanCalendar} from "../src/aegean-calendar-cache";
import {aegeanCalendarUrl} from "../src/aegean-lowfare";
import {createPublicFareCache} from "../src/public-fare-cache";
const now=new Date("2026-10-08T04:30:00Z");
const trip={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05"};
const fare={...trip,amount:232.37,currency:"EUR",outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(trip),checkedAt:now.toISOString(),pricing:"published_advertisement",carrier:null};
function cache(){const map=new Map<string,Response>();return createPublicFareCache({async match(r){return map.get(typeof r==="string"?r:r instanceof URL?r.href:r.url)?.clone();},async put(r,response){map.set(typeof r==="string"?r:r instanceof URL?r.href:r.url,response.clone());}},now);}
it("stores and reads only the selected exact round trip",async()=>{const c=cache();await c.put(fare.bookingUrl,[fare]);expect(await readAegeanCalendar(c,trip,now)).toEqual(fare);expect(await readAegeanCalendar(c,{...trip,returnDate:"2027-06-06"},now)).toBeNull();});
it("rejects inconsistent component amounts",async()=>{const c=cache();await c.put(fare.bookingUrl,[{...fare,amount:200}]);expect(await readAegeanCalendar(c,trip,now)).toBeNull();});
it("rejects stale snapshots and unexpected query parameters",async()=>{const c=cache();await c.put(fare.bookingUrl,[fare]);expect(await readAegeanCalendar(c,trip,new Date(now.getTime()+6*3600000))).toBeNull();await c.put(fare.bookingUrl+"&extra=1",[fare]);expect(await c.get(fare.bookingUrl+"&extra=1")).toBeNull();});
