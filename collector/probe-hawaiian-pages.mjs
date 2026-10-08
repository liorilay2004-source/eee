import {readFile,writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
import {routeLinks} from './route-links.mjs';
import {hawaiianFares} from './hawaiian-fares.mjs';
import {publishHawaiianObservation} from './publish-hawaiian-observation.mjs';
// Official URLs observed in search results and verified directly. No inferred operator.
const inventory=JSON.parse(await readFile(new URL('./hawaiian-observed-pages.json',import.meta.url),'utf8'));
const offset=Number(process.env.HAWAIIAN_OFFSET??0),limit=Number(process.env.HAWAIIAN_LIMIT??20);
if(!Number.isInteger(offset)||offset<0||offset>inventory.length||!Number.isInteger(limit)||limit<1||limit>60)throw new Error('Invalid batch');
const pages=process.env.HAWAIIAN_ORIGINS==='true'?inventory.slice(offset,offset+limit).map(row=>{
 const url=new URL(row.url),parent=new URL(row.observedOn);
 if(url.origin!==parent.origin||url.hostname!=='asha.hawaiianairlines.com'||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/en\/flights-from-[a-z-]+$/.test(url.pathname))throw new Error('Invalid observed page');return url.href;
}):['https://www.hawaiianairlines.com/es-us/en/flights-from-honolulu-to-los-angeles','https://asha.hawaiianairlines.com/en/flights-from-honolulu-to-los-angeles'];
const observations=[];
for(const page of pages){
 const fetchedAt=new Date().toISOString();
 try{
  const response=await fetch(page,{redirect:'manual',signal:AbortSignal.timeout(5000)});
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const html=Buffer.concat(chunks).toString('utf8');
  const records=fareRecords(html);
  const discoveredPages=routeLinks(html,page);
  const observation={page,fetchedAt,records,discoveredPages,checkoutVerified:false,operatorVerified:false};
  if(new URL(page).hostname==='asha.hawaiianairlines.com')observation.fares=hawaiianFares(observation);
  observations.push(observation);
  if(process.env.COLLECTOR_KEY&&process.env.HAWAIIAN_ORIGINS==='true'){
   observation.publication=await publishHawaiianObservation(observation,process.env.COLLECTOR_KEY);
   console.log(JSON.stringify({page,...observation.publication}));
  }
  console.log(JSON.stringify({page,records:records.length,discoveredPages:discoveredPages.length,bytes}));
 }catch(error){observations.push({page,fetchedAt,error:error.message});process.exitCode=1;if(error.fatal){await writeFile('hawaiian-page-observations.json',JSON.stringify(observations,null,2));throw error;}}
 await writeFile('hawaiian-page-observations.json',JSON.stringify(observations,null,2));
}
