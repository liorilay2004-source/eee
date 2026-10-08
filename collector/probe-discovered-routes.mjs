import {readFile,writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
import {observedPairs} from './observed-pairs.mjs';
const observed=JSON.parse(await readFile(new URL('./discovered-route-pages.json',import.meta.url),'utf8'));
const airline=process.env.PROBE_AIRLINE??'AC';
const targets=observed.filter(row=>row.airline===airline);
if(!targets.length||targets.length>100)throw new Error('Invalid observed airline selection');
const results=[];
for(const target of targets){const checkedAt=new Date();try{
 const url=new URL(target.url),parent=new URL(target.observedOn);
 if(url.origin!==parent.origin||url.protocol!=='https:'||url.search||url.hash||url.username||url.password)throw new Error('Invalid observed URL');
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(response.status!==200)throw new Error(`HTTP ${response.status}`);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>(airline==='AA'?3000000:2000000)){await reader.cancel();throw new Error('Response too large');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
 const html=Buffer.concat(chunks).toString('utf8'),records=fareRecords(html);
 const fares=observedPairs(records).flatMap(pair=>parsePublishedFares(html,{...pair,airline,sourceUrl:url.href,now:checkedAt}));
 results.push({...target,checkedAt:checkedAt.toISOString(),fares});console.log(JSON.stringify({airline,url:url.href,fares:fares.length}));
}catch(error){results.push({...target,error:error.message});console.log(JSON.stringify({airline,url:target.url,error:error.message}));}
await writeFile('discovered-route-prices.json',JSON.stringify(results,null,2));}
await writeFile('discovered-route-prices.json',JSON.stringify(results,null,2));
