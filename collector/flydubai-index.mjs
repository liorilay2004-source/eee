import {normalizeFlydubaiFares} from './flydubai-fares.mjs';
/** Fresh, reparsed original snapshots keyed by exact route/date; no capture renewal. */
export function flydubaiIndex(observations,now=new Date()){
 if(!Array.isArray(observations)||observations.length>3000||!Number.isFinite(now.getTime()))throw Error('Invalid snapshot');
 const latest=new Map();for(const row of observations){const at=Date.parse(row?.checkedAt);if(row?.error||!Number.isFinite(at)||at>now.getTime()||!row.url)continue;const key=row.url+':'+(row.apiParams?.org??'inline')+':'+(row.apiParams?.dest??'');if(!latest.has(key)||at>Date.parse(latest.get(key).checkedAt))latest.set(key,row);}
 const byDate=Object.create(null),roundTrips=Object.create(null);
 for(const row of latest.values()){
  if(now.getTime()-Date.parse(row.checkedAt)>=600000||row.records===null)continue;
  if(!Array.isArray(row.records)||row.records.length>500)continue;
  const pairs=row.apiParams?[{origin:row.apiParams.org,destination:row.apiParams.dest}]:[...new Map(row.records.filter(r=>r&&/^[A-Z]{3}$/.test(r.origin)&&/^[A-Z]{3}$/.test(r.destination)).map(r=>[r.origin+':'+r.destination,{origin:r.origin,destination:r.destination}])).values()];
  for(const pair of pairs){for(const fare of normalizeFlydubaiFares(row.records,{...pair,sourceUrl:row.url,checkedAt:row.checkedAt})){const key=[fare.origin,fare.destination,fare.departDate,...(fare.structure==='roundtrip'?[fare.returnDate]:[])].join(':');const target=fare.structure==='roundtrip'?roundTrips:byDate;(target[key]??=[]).push(fare);}}
 }return {byDate,roundTrips};
}
