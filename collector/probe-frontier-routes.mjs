import {readFile,writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
const pages=JSON.parse(await readFile(new URL('./frontier-discovered-routes.json',import.meta.url),'utf8'));
if(!Array.isArray(pages)||pages.length>50)throw new Error('Invalid route inventory');
const results=[],started=Date.now();
const allowed=url=>url.protocol==='https:'&&url.hostname==='flights.flyfrontier.com'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&/^\/(?:en\/)?flights-from-[a-z-]+-to-[a-z-]+\/?$/.test(url.pathname);
for(const page of pages){
 if(Date.now()-started>240000){results.push({page:page.url,error:'collection_deadline'});continue;}
 const checkedAt=new Date().toISOString();let url=new URL(page.url);const redirects=[];
 try{
  if(!allowed(url))throw new Error('Unapproved route');
  let response;
  for(let redirect=0;redirect<=3;redirect++){
   response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5000)});
   if(![301,302,303,307,308].includes(response.status))break;
   if(redirect===3)throw new Error('Redirect limit');
   const next=new URL(response.headers.get('location')??'',url);
   if(!allowed(next)||next.href===url.href)throw new Error('Unapproved redirect');
   redirects.push({from:url.href,to:next.href,status:response.status});url=next;
   await response.body?.cancel();
  }
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const html=Buffer.concat(chunks).toString('utf8'),records=fareRecords(html);
  const origins=[...new Set(records.map(r=>r.originAirportCode).filter(v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)))];
  if(origins.length>20)throw new Error('Origin limit');
  const fares=origins.flatMap(origin=>parsePublishedFares(html,{airline:'F9',origin,destination:'XXX',allDestinations:true,sourceUrl:url.href,now:new Date(checkedAt)}));
  results.push({page:page.url,finalUrl:url.href,redirects,checkedAt,records,fares});
  console.log(JSON.stringify({page:page.url,publicFares:fares.length,pairs:[...new Set(fares.map(f=>f.origin+'-'+f.destination))]}));
 }catch(error){results.push({page:page.url,finalUrl:url.href,redirects,checkedAt,error:error.message});console.log(JSON.stringify({page:page.url,error:error.message}));}
 await writeFile('frontier-route-observations.json',JSON.stringify(results,null,2));
}
await writeFile('frontier-route-observations.json',JSON.stringify(results,null,2));
console.log(JSON.stringify({pages:results.length,readable:results.filter(r=>!r.error).length,publicFares:results.flatMap(r=>r.fares??[]).length}));
