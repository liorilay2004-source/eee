import {writeFile} from 'node:fs/promises';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
import {fareRecords} from './fare-records.mjs';
import {EXTERNAL_PUBLISHED_PAGES as pages} from '../worker/src/external-published-catalog.ts';
const results=[];
for(const page of pages){const now=new Date();try{
 const response=await fetch(page.sourceUrl,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(response.status!==200)throw new Error(`HTTP ${response.status}`);
 const reader=response.body.getReader();const chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2000000){await reader.cancel();throw new Error('Response too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const html=Buffer.concat(chunks).toString('utf8');
 const fares=parsePublishedFares(html,{...page,now});
 if(process.env.COLLECTOR_KEY){
  if(!/^[a-f0-9]{64}$/.test(process.env.COLLECTOR_KEY))throw new Error('Invalid collector configuration');
  const payload=JSON.stringify({source:'published_page',airline:page.airline,page:page.sourceUrl,checkedAt:now.toISOString(),records:fareRecords(html)});
  if(Buffer.byteLength(payload)>128000)throw new Error('Ingest payload too large');
  const published=await fetch('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.COLLECTOR_KEY}`},body:payload,signal:AbortSignal.timeout(15000)});
  if(!published.ok){const rejected=await published.json().catch(()=>({}));throw new Error(`Ingestion HTTP ${published.status}: ${typeof rejected.error==='string'&&/^[a-z_]+$/.test(rejected.error)?rejected.error:'unknown'}`);}
  const result=await published.json();console.log(JSON.stringify({airline:page.airline,publishedFares:result.fares,checkedAt:result.checkedAt}));
 }
 const result={airline:page.airline,page:page.sourceUrl,checkedAt:now.toISOString(),fares};results.push(result);
 console.log(JSON.stringify({airline:page.airline,status:200,fares:fares.length,bytes:size}));
}catch(error){results.push({airline:page.airline,error:error.message});console.log(JSON.stringify({airline:page.airline,error:error.message}));process.exitCode=1;}}
await writeFile('public-page-probe.json',JSON.stringify(results,null,2));
