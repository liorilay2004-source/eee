import {frontierBatch} from './frontier-batch.mjs';
import {FRONTIER_PUBLISHED_PAGES} from '../worker/src/frontier-published-catalog.ts';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
import {fareRecords} from './fare-records.mjs';
import {writeFile} from 'node:fs/promises';
import {publishPages} from './publish-pages.mjs';
const batch=process.env.FRONTIER_BATCH==='true'?frontierBatch([...new Set(FRONTIER_PUBLISHED_PAGES.map(p=>p.sourceUrl))].sort().map(url=>({url})),Number(process.env.FRONTIER_OFFSET??0),Number(process.env.FRONTIER_LIMIT??10)).map(p=>p.url):null;
const pages=batch??(process.env.FRONTIER_PAGE?[process.env.FRONTIER_PAGE]:['https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix','https://flights.flyfrontier.com/en/flights-from-phoenix-to-denver']);
if(!/^[a-f0-9]{64}$/.test(process.env.COLLECTOR_KEY??''))throw new Error('Invalid collector configuration');
const receipts=await publishPages(pages,async(page)=>{
const configs=FRONTIER_PUBLISHED_PAGES.filter(p=>p.sourceUrl===page);
if(!configs.length)throw Object.assign(new Error('Invalid collector configuration'),{fatal:true});
const checkedAt=new Date().toISOString();
const response=await fetch(page,{redirect:'manual',signal:AbortSignal.timeout(15000)});
if(response.status!==200)throw new Error(`Official page HTTP ${response.status}`);
const reader=response.body.getReader(),chunks=[];let size=0;
try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
const html=Buffer.concat(chunks).toString('utf8'),records=fareRecords(html);
const fares=configs.flatMap(config=>parsePublishedFares(html,{...config,now:new Date(checkedAt)}));
const payload=JSON.stringify({source:'published_page',airline:'F9',page,checkedAt,records,clearIfNoPrices:true});
if(Buffer.byteLength(payload)>128000)throw new Error('Payload size limit');
const published=await fetch('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.COLLECTOR_KEY}`},body:payload,signal:AbortSignal.timeout(15000)});
if(!published.ok)throw Object.assign(new Error(`Ingestion HTTP ${published.status}`),{fatal:[401,403].includes(published.status)});
const result=await published.json();if(result.fares!==fares.length)throw new Error('Ingestion count mismatch');
const receipt={page,fares:result.fares,checkedAt:result.checkedAt,expiresAfterSeconds:600,prices:fares.map(f=>({origin:f.origin,destination:f.destination,departDate:f.departDate,amount:f.amount,currency:f.currency}))};
console.log(JSON.stringify(receipt));return receipt;
},async rows=>writeFile('frontier-publication-receipts.json',JSON.stringify(rows,null,2)));
console.log(JSON.stringify({attempted:receipts.length,published:receipts.filter(r=>r.ok).length,failed:receipts.filter(r=>!r.ok).length}));
if(receipts.some(r=>!r.ok))process.exitCode=1;
