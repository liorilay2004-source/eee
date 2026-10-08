import {writeFile} from 'node:fs/promises';
import {fareRecords} from './fare-records.mjs';
// Official URLs observed in search results and verified directly. No inferred operator.
const pages=['https://www.hawaiianairlines.com/es-us/en/flights-from-honolulu-to-los-angeles','https://asha.hawaiianairlines.com/en/flights-from-honolulu-to-los-angeles'];
const observations=[];
for(const page of pages){
 const fetchedAt=new Date().toISOString();
 try{
  const response=await fetch(page,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.status!==200)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)throw new Error('Page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
  const html=Buffer.concat(chunks).toString('utf8');
  const records=fareRecords(html);
  observations.push({page,fetchedAt,records,checkoutVerified:false,operatorVerified:false});
  console.log(JSON.stringify({page,records:records.length,bytes}));
 }catch(error){observations.push({page,fetchedAt,error:error.message});process.exitCode=1;}
 await writeFile('hawaiian-page-observations.json',JSON.stringify(observations,null,2));
}
