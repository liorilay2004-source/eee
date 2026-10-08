import type {PublishedFare} from "./published-fares";
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export const SINGAPORE_PAGE='https://www.singaporeair.com/sg/en/plan-travel/destinations/flights-from-singapore-to-tokyo/';
/** Public cash fare-cache observations. No inferred times, bags or operator. */
export function singaporeObservations(rows:unknown,checkedAt:string):PublishedFare[]{
 if(!Array.isArray(rows)||rows.length>1000||!Number.isFinite(Date.parse(checkedAt)))throw new Error('Invalid Singapore observations');
 const today=checkedAt.slice(0,10),seen=new Set();
 return rows.flatMap(row=>{
  if(!row||row.origin!=='SIN'||!['HND','NRT'].includes(row.destination)||row.cabinClass!=='Y'||!date(row.departureDate)||!date(row.returnDate)||row.departureDate<today||row.returnDate<=row.departureDate||typeof row.fare!=='number'||!Number.isFinite(row.fare)||row.fare<=0||typeof row.currency!=='string'||!/^([A-Z]{3})$/.test(row.currency))return [];
  const fare:PublishedFare={airline:'SQ',origin:row.origin,destination:row.destination,departDate:row.departureDate,returnDate:row.returnDate,amount:row.fare,currency:row.currency,structure:'roundtrip',sourceUrl:SINGAPORE_PAGE,checkedAt,pricing:'published_advertisement'};
  const key=JSON.stringify(fare);if(seen.has(key))return [];seen.add(key);return [fare];
 });
}
