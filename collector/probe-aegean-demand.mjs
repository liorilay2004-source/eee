import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {aegeanHttpCalendarUrl} from './aegean-http-calendar.mjs';
import {collectAegeanHttpCalendar} from './probe-aegean-http-calendar.mjs';
export const AEGEAN_DEMAND_ENDPOINT='https://eee-api.liorilay2004.workers.dev/api/internal/aegean-demand';
const OBSERVATIONS='aegean-http-calendar-observations.json';
const SUMMARY='aegean-demand-summary.json';

async function demandRequest(key,fetchFn,body){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw Error('Invalid collector configuration');
 let response;
 try{response=await fetchFn(AEGEAN_DEMAND_ENDPOINT,{method:body?'POST':'GET',redirect:'manual',headers:{Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}catch{throw Error('Demand request failed');}
 if(response.status!==200)throw Object.assign(Error(`Demand HTTP ${response.status}`),{fatal:[401,403].includes(response.status)});
 if(!response.body)throw Error('Missing demand response');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>10000)throw Error('Demand response size limit');chunks.push(part.value);}}catch{throw Error('Invalid or oversized demand response');}finally{try{await reader.cancel();}catch{}}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Error('Invalid demand JSON');}
}

function summary(queuedTrips,rows,status){
 return {queuedTrips,publishedTrips:rows.filter(row=>row.publication?.published===1&&row.publication.checkedAt===row.checkedAt).length,
  acceptedFares:rows.reduce((sum,row)=>sum+(row.publication?.published===1&&row.publication.checkedAt===row.checkedAt?1:0),0),
  skippedTrips:rows.filter(row=>row.skipped==='claim_declined').length,tripErrors:rows.filter(row=>typeof row.error==='string').length,status};
}

/** The API supplies only aggregated route/dates; we never accept an upstream URL from it. */
export async function collectAegeanDemand({key,fetchFn=fetch,outputDirectory='.',now=()=>new Date(),log=console.log}){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw Error('Invalid collector configuration');
 await mkdir(outputDirectory,{recursive:true});
 const observations=resolve(outputDirectory,OBSERVATIONS),summaryPath=resolve(outputDirectory,SUMMARY);
 let queuedTrips=0;
 await writeFile(observations,'[]');await writeFile(summaryPath,JSON.stringify(summary(0,[],'running'),null,2));
 try{
  const raw=await demandRequest(key,fetchFn);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.trips)||raw.trips.length>12)throw Error('Invalid demand inventory');
  const trips=raw.trips.map(value=>({origin:value?.origin,destination:value?.destination,departDate:value?.departDate,returnDate:value?.returnDate}));
  const ids=trips.map(aegeanHttpCalendarUrl);if(new Set(ids).size!==ids.length)throw Error('Duplicate demand trip');
  const today=now().toISOString().slice(0,10);if(trips.some(trip=>trip.departDate<today))throw Error('Past demand trip');
  queuedTrips=trips.length;await writeFile(summaryPath,JSON.stringify(summary(queuedTrips,[],'running'),null,2));
  if(!trips.length){await writeFile(summaryPath,JSON.stringify(summary(0,[],'idle'),null,2));return [];}
  // A transport failure must not put credential-bearing exception text in observations or console output.
  const safeFetch=async(input,options)=>{try{return await fetchFn(input,{...options,redirect:'manual'});}catch{throw Error('Collector request failed');}};
  const results=await collectAegeanHttpCalendar({trips,key,fetchFn:safeFetch,outputDirectory,now,log,claim:async trip=>{
   const receipt=await demandRequest(key,fetchFn,{trip});
   if(!receipt||typeof receipt.claimed!=='boolean')throw Error('Invalid demand claim receipt');
   return receipt.claimed;
  }});
  const hasErrors=results.some(row=>row.error),hasPublished=results.some(row=>row.publication?.published===1);
  await writeFile(summaryPath,JSON.stringify(summary(queuedTrips,results,hasErrors?(hasPublished?'partial':'failed'):hasPublished?'succeeded':'idle'),null,2));
  return results;
 }catch(error){
  let rows=[];try{const text=await readFile(observations,'utf8');if(Buffer.byteLength(text)<=2000000){const value=JSON.parse(text);if(Array.isArray(value)&&value.length<=12)rows=value;}}catch{}
  await writeFile(summaryPath,JSON.stringify(summary(queuedTrips,rows,rows.some(row=>row.publication?.published===1)?'partial':'failed'),null,2));
  throw error;
 }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const results=await collectAegeanDemand({key:process.env.COLLECTOR_KEY,outputDirectory:process.env.AEGEAN_HTTP_OUTPUT_DIRECTORY??'.'});
  if(results.some(row=>row.error))process.exitCode=1;
 }catch{console.error('Aegean demand collection could not complete; inspect the bounded observations and summary.');process.exitCode=1;}
}
