import {readFile,writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
import {observedPairs} from './observed-pairs.mjs';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
import {publishPageObservation} from './publish-page-observation.mjs';
const approved=JSON.parse(await readFile(new URL('../worker/src/airastana-published-catalog.json',import.meta.url),'utf8'));
const inventory=JSON.parse(await readFile(new URL('./airastana-observed-pages.json',import.meta.url),'utf8'));
const offset=Number(process.env.AIRASTANA_OFFSET??0),limit=Number(process.env.AIRASTANA_LIMIT??20);
if(!Number.isInteger(offset)||offset<0||offset>inventory.length||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Invalid batch');
const results=[];
for(const row of inventory.slice(offset,offset+limit)){
 const checkedAt=new Date().toISOString();
 try{
  const url=new URL(row.url),parent=new URL(row.observedOn);
  if(url.origin!==parent.origin||url.protocol!=='https:'||url.hostname!=='bestfares.airastana.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/en-kz\/flights-from-[a-z-]+$/.test(url.pathname))throw new Error('Invalid observed page');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const html=Buffer.concat(chunks).toString('utf8'),records=fareRecords(html);
  const fares=observedPairs(records).flatMap(pair=>parsePublishedFares(html,{...pair,airline:'KC',sourceUrl:url.href,now:new Date(checkedAt)}));
  const observation={...row,checkedAt,records,fares};results.push(observation);
  if(process.env.COLLECTOR_KEY){
   const configs=approved.filter(config=>config.sourceUrl===url.href);
   if(!configs.length)throw Object.assign(new Error('Unapproved publication page'),{fatal:true});
   const parsed=configs.flatMap(config=>parsePublishedFares(html,{...config,now:new Date(checkedAt)}));
   const expectedFares=new Set(parsed.map(f=>JSON.stringify(f))).size;
   observation.publication=await publishPageObservation({airline:'KC',page:url.href,checkedAt,records,expectedFares},process.env.COLLECTOR_KEY);
  }
  console.log(JSON.stringify({page:row.url,records:records.length,fares:fares.length,...observation.publication}));
 }catch(error){results.push({...row,checkedAt,error:error.message});process.exitCode=1;if(error.fatal){await writeFile('airastana-page-observations.json',JSON.stringify(results,null,2));throw error;}}
 await writeFile('airastana-page-observations.json',JSON.stringify(results,null,2));
}
