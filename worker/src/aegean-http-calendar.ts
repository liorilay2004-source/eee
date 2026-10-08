import {fetchAegeanHttpCalendarSnapshot,type AegeanHttpCalendarFare} from '../../collector/aegean-http-calendar.mjs';
import type {AegeanCalendarTrip} from './aegean-lowfare';
export {aegeanHttpCalendarUrl,parseAegeanHttpCalendar} from '../../collector/aegean-http-calendar.mjs';
export type {AegeanHttpCalendarFare,AegeanHttpSnapshot} from '../../collector/aegean-http-calendar.mjs';

/** Exact selected round trip, with public HTTP and original source update dates. */
export async function loadHttpAegeanCalendar(trip:AegeanCalendarTrip,now:Date,fetchFn:typeof fetch=fetch):Promise<AegeanHttpCalendarFare|null>{
 return (await fetchAegeanHttpCalendarSnapshot(trip,now.toISOString(),fetchFn)).fare;
}
