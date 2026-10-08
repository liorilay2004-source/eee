import {readFile,writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
import {observedPairs} from './observed-pairs.mjs';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';

const inventory=JSON.parse(await readFile(new URL('./kenya-observed-pages.json',import.meta.url),'utf8'));
const offset=Number(process.env.KENYA_OFFSET??0),limit=Number(process.env.KENYA_LIMIT??20);
if(!Number.isInteger(offset)||offset<0||offset>inventory.length||!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Invalid batch');
const results=[];
for(const row of inventory.slice(offset,offset+limit)){
 const checkedAt=new Date().toISOString();
 try{
  const url=new URL(row.url),parent=new URL(row.observedOn);
  if(url.origin!==parent.origin||url.protocol!=='https:'||url.hostname!=='www.kenya-airways.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/en_[a-z]{2}\/flights-(from|to)-[a-z-]+\/?$/.test(url.pathname))throw new Error('Invalid observed page');
  let response;let target=url;
  for(let hop=0;hop<4;hop++){
   response=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(10000)});
   if(![301,302,307,308].includes(response.status))break;
   const location=response.headers.get('location');if(!location)throw new Error('Missing redirect');
   const next=new URL(location,target);
   if(next.origin!==url.origin||next.username||next.password||next.port||next.search||next.hash||!/^\/en_[a-z]{2}\/flights-(from|to)-[a-z-]+\/?$/.test(next.pathname))throw new Error('Unapproved redirect');
   target=next;
  }
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const html=Buffer.concat(chunks).toString('utf8'),records=fareRecords(html);
  const fares=observedPairs(records).flatMap(pair=>parsePublishedFares(html,{...pair,airline:'KQ',sourceUrl:target.href,now:new Date(checkedAt)}));
  const observation={...row,finalUrl:target.href,checkedAt,records,fares};results.push(observation);
  console.log(JSON.stringify({page:row.url,records:records.length,fares:fares.length,...observation.publication}));
 }catch(error){results.push({...row,checkedAt,error:error.message});process.exitCode=1;if(error.fatal){await writeFile('kenya-page-observations.json',JSON.stringify(results,null,2));throw error;}}
 await writeFile('kenya-page-observations.json',JSON.stringify(results,null,2));
}
