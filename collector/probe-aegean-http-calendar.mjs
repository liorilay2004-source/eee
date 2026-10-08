import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {aegeanHttpCalendarUrl,fetchAegeanHttpCalendarSnapshot,parseAegeanHttpCalendar} from './aegean-http-calendar.mjs';

const DEFAULT_TRIPS=[{origin:'TLV',destination:'ATH',departDate:'2027-06-01',returnDate:'2027-06-05'}];

/** Publish verbatim contextual round-trip data; malformed/empty schemas never clear an offer. */
export async function publishAegeanHttpCalendar(snapshot,key,fetchFn=fetch){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw Error('Invalid collector configuration');
 const fare=parseAegeanHttpCalendar(snapshot?.records,snapshot?.trip,snapshot?.checkedAt);
 if(!fare||snapshot.page!==aegeanHttpCalendarUrl(snapshot.trip))throw Error('No validated selected Aegean calendar price');
 const body=JSON.stringify({source:'aegean_http_calendar',trip:snapshot.trip,checkedAt:snapshot.checkedAt,records:snapshot.records});
 if(Buffer.byteLength(body)>128000)throw Error('Aegean calendar ingestion size limit');
 const response=await fetchFn('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Object.assign(Error(`Ingestion HTTP ${response.status}`),{fatal:[401,403].includes(response.status)});
 const result=await response.json();
 if(result.fares!==1||result.checkedAt!==snapshot.checkedAt)throw Error('Aegean calendar ingestion receipt mismatch');
 return {published:1,checkedAt:result.checkedAt};
}

export async function collectAegeanHttpCalendar({trips=DEFAULT_TRIPS,key,outputDirectory='.',fetchFn=fetch,now=()=>new Date(),log=console.log,claim}){
 if(!Array.isArray(trips)||!trips.length||trips.length>12)throw Error('Invalid Aegean calendar trip selection');
 const selected=new Set();
 for(const trip of trips){const url=aegeanHttpCalendarUrl(trip);if(selected.has(url))throw Error('Duplicate Aegean calendar trip');selected.add(url);}
 if(key&&!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid collector configuration');
 await mkdir(outputDirectory,{recursive:true});
 const results=[],output=resolve(outputDirectory,'aegean-http-calendar-observations.json');
 const checkpoint=()=>writeFile(output,JSON.stringify(results,null,2));
 for(const trip of trips){const checkedAt=now().toISOString();let snapshot;
  try{
   if(claim&&!await claim(trip)){results.push({trip,checkedAt,skipped:'claim_declined'});await checkpoint();continue;}
   snapshot=await fetchAegeanHttpCalendarSnapshot(trip,checkedAt,fetchFn);
   if(!snapshot.fare)throw Error('No validated selected Aegean calendar price');
   if(key)snapshot.publication=await publishAegeanHttpCalendar(snapshot,key,fetchFn);
   results.push(snapshot);log(JSON.stringify({origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate,checkedAt,...snapshot.publication}));
  }catch(error){
   results.push({...snapshot,trip,checkedAt,error:error.message});await checkpoint();
   if(error.fatal)throw error;
  }
  await checkpoint();
 }
 return results;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const trips=process.env.AEGEAN_HTTP_TRIPS?JSON.parse(process.env.AEGEAN_HTTP_TRIPS):DEFAULT_TRIPS;
 const results=await collectAegeanHttpCalendar({trips,key:process.env.COLLECTOR_KEY,outputDirectory:process.env.AEGEAN_HTTP_OUTPUT_DIRECTORY??'.'});
 if(results.some(row=>row.error))process.exitCode=1;
}
