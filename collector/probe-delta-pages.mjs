import {writeFile} from 'node:fs/promises';
import {deltaObservations} from './delta-observations.mjs';
const pages=[
 'https://www.delta.com/us/en/travel-planning-center/find-your-destination/flying-from-new-york',
 'https://www.delta.com/us/en/travel-planning-center/find-your-destination/flying-from-los-angeles',
];
async function bounded(url,max){
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json,text/html'}});
 if(response.status!==200)throw new Error(`HTTP ${response.status}`);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max){await reader.cancel();throw new Error('Response too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
const results=[];
for(const [index,page] of pages.entries()){
 try{
  const html=await bounded(page,200000),matched=html.match(/<flight-deals\b[^>]*endpointurl="([^"]+)"/i);
  if(!matched)throw new Error('Official endpoint absent');
  const endpoint=new URL(matched[1].replaceAll('&amp;','&'));
  if(endpoint.protocol!=='https:'||endpoint.hostname!=='delta-api.xcheck.co'||endpoint.pathname!=='/v2/croutes'||endpoint.username||endpoint.password||endpoint.port||endpoint.hash)throw new Error('Unapproved endpoint');
  const checkedAt=new Date().toISOString();const data=JSON.parse(await bounded(endpoint.href,8000000));
  const observations=deltaObservations(data,checkedAt);
  await writeFile(`delta-upstream-${index}.json`,JSON.stringify(data));
  results.push({page,endpoint:endpoint.href,checkedAt,observations});
  console.log(JSON.stringify({page,observations:observations.length,locations:[...new Set(observations.map(o=>o.origin))]}));
 }catch(error){results.push({page,error:error.message});process.exitCode=1;console.log(JSON.stringify({page,error:error.message}));}
 await writeFile('delta-page-observations.json',JSON.stringify(results,null,2));
}
