import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {singaporeObservations,SINGAPORE_PAGE} from './singapore-observations.mjs';
const endpoint='https://www.singaporeair.com/homepage/get-flight-offers';
const records=[],checkedAt=new Date().toISOString();let complete=false;
try{
 for(let page=1;page<=20;page++){
  const body={originAirportCode:'SIN',destinationAirportCode:'TYO',tripType:'R',duration:7,cabinClass:['Y'],page,pageSize:48};
  const response=await fetch(endpoint,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',Origin:'https://www.singaporeair.com','x-client-uuid':randomUUID()},body:JSON.stringify(body)});
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1000000){await reader.cancel();throw new Error('Response too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(data.data)||data.data.length>48||data.currentPage!==page||typeof data.hasNextPage!=='boolean')throw new Error('Invalid fare response');
  if(records.length+data.data.length>1000)throw new Error('Observation limit exceeded');
  records.push(...data.data);console.log(JSON.stringify({page,rows:data.data.length,totalFiltered:data.totalFiltered,hasNext:data.hasNextPage}));
  await writeFile('singapore-upstream-rows.json',JSON.stringify({page:SINGAPORE_PAGE,endpoint,checkedAt,records}));
  if(!data.hasNextPage){complete=true;break;}
 }
 if(!complete)throw new Error('Pagination exceeds bounded collection');
 const fares=singaporeObservations(records,checkedAt);
 let published=null;
 if(process.env.COLLECTOR_KEY){
  if(!/^[a-f0-9]{64}$/.test(process.env.COLLECTOR_KEY))throw new Error('Invalid collector configuration');
  const keys=['origin','destination','departureDate','returnDate','fare','currency','cabinClass'];
  const payload=JSON.stringify({source:'singapore',page:SINGAPORE_PAGE,checkedAt,records:records.map(row=>Object.fromEntries(keys.map(key=>[key,row[key]])))});
  if(Buffer.byteLength(payload)>128000)throw new Error('Ingest payload too large');
  const response=await fetch('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.COLLECTOR_KEY}`},body:payload,signal:AbortSignal.timeout(15000)});
  if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(`Ingestion HTTP ${response.status}: ${typeof result.error==='string'&&/^[a-z_]+$/.test(result.error)?result.error:'unknown'}`);}
  published=await response.json();if(published.fares!==fares.length)throw new Error('Ingestion count mismatch');
  console.log(JSON.stringify({publishedFares:published.fares,checkedAt:published.checkedAt}));
 }

 await writeFile('singapore-observations.json',JSON.stringify({page:SINGAPORE_PAGE,checkedAt,complete,published,fares},null,2));
 console.log(JSON.stringify({complete,observations:fares.length,juneJuly2027:fares.filter(f=>/^2027-(06|07)-/.test(f.departDate)).length}));
}catch(error){await writeFile('singapore-observations.json',JSON.stringify({page:SINGAPORE_PAGE,checkedAt,complete,error:error.message,fares:singaporeObservations(records,checkedAt)},null,2));throw error;}
