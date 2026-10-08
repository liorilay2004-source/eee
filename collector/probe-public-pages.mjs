import {writeFile} from 'node:fs/promises';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
import {fareRecords} from './fare-records.mjs';
import {parseIberiaFares} from '../worker/src/iberia-fares.ts';
import {parseFinnairFares} from '../worker/src/finnair-fares.ts';
import {EXTERNAL_PUBLISHED_PAGES} from '../worker/src/external-published-catalog.ts';
const candidateMode=process.env.PROBE_CANDIDATES==='true';
const pages=candidateMode?[
 {airline:'AA',origin:'LAX',destination:'MEX',sourceUrl:'https://www.aa.com/en-us/flights-from-los-angeles-to-mexico-city'},
 {airline:'KL',origin:'TLV',destination:'AMS',sourceUrl:'https://www.klm.co.il/en-il/flights-from-tel-aviv',allDestinations:true},
 {airline:'AM',origin:'LAX',destination:'MEX',sourceUrl:'https://www.aeromexico.com/en_us/flights-from-los-angeles',allDestinations:true},
 {airline:'CM',origin:'PTY',destination:'MCO',sourceUrl:'https://www.copaair.com/en/flights-from-panama-city',allDestinations:true},
 {airline:'FI',origin:'LHR',origins:['LHR','LGW'],destination:'KEF',sourceUrl:'https://www.icelandair.com/en-gb/flights/flights-from-london-to-iceland'},
 {airline:'TK',origin:'IST',destination:'ATH',sourceUrl:'https://www.turkishairlines.com/en/flights-from-istanbul-to-athens'},
 {airline:'IB',origin:'MAD',destination:'TLV',sourceUrl:'https://www.iberia.com/es/cheap-flights/Madrid-Tel-Aviv/'},
 {airline:'AY',origin:'HEL',destination:'ATH',sourceUrl:'https://www.finnair.com/en/flights/from/hel/flights-from-Helsinki'},
]:EXTERNAL_PUBLISHED_PAGES;
const results=[];
const selection=process.env.PROBE_AIRLINE;
if(selection&&(!candidateMode||!pages.some(page=>page.airline===selection)))throw new Error('Invalid candidate selection');
for(const page of pages.filter(page=>!selection||page.airline===selection)){const now=new Date();try{
 const response=await fetch(page.sourceUrl,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(response.status!==200)throw new Error(`HTTP ${response.status}`);
 const reader=response.body.getReader();const chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>(page.airline==='AY'?4000000:page.airline==='AA'?3000000:2000000)){await reader.cancel();throw new Error('Response too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const html=Buffer.concat(chunks).toString('utf8');
 const fares=page.airline==='IB'?parseIberiaFares(html,now):page.airline==='AY'?parseFinnairFares(html,now):parsePublishedFares(html,{...page,now});
 if(process.env.COLLECTOR_KEY&&!candidateMode){
  if(!/^[a-f0-9]{64}$/.test(process.env.COLLECTOR_KEY))throw new Error('Invalid collector configuration');
  const content=page.airline==='IB'?{html:[...html.replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<style\b[\s\S]*?<\/style>/gi,'').matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)].map(match=>match[0]).join('')}:{records:fareRecords(html)};
  const payload=JSON.stringify({source:'published_page',airline:page.airline,page:page.sourceUrl,checkedAt:now.toISOString(),...content});
  if(Buffer.byteLength(payload)>128000)throw new Error('Ingest payload too large');
  const published=await fetch('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.COLLECTOR_KEY}`},body:payload,signal:AbortSignal.timeout(15000)});
  if(!published.ok){const rejected=await published.json().catch(()=>({}));throw new Error(`Ingestion HTTP ${published.status}: ${typeof rejected.error==='string'&&/^[a-z_]+$/.test(rejected.error)?rejected.error:'unknown'}`);}
  const result=await published.json();console.log(JSON.stringify({airline:page.airline,publishedFares:result.fares,checkedAt:result.checkedAt}));
 }
 const result={airline:page.airline,page:page.sourceUrl,checkedAt:now.toISOString(),fares};results.push(result);
 console.log(JSON.stringify({airline:page.airline,status:200,fares:fares.length,bytes:size}));
}catch(error){results.push({airline:page.airline,error:error.message});console.log(JSON.stringify({airline:page.airline,error:error.message}));process.exitCode=1;}}
await writeFile('public-page-probe.json',JSON.stringify(results,null,2));
