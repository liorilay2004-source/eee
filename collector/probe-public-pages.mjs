import {writeFile} from 'node:fs/promises';
import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
const pages=[
 {airline:'AC',origin:'TLV',destination:'YYZ',sourceUrl:'https://www.aircanada.com/en-ca/flights-from-tel-aviv',allDestinations:true},
 {airline:'TP',origin:'TLV',destination:'LIS',sourceUrl:'https://www.flytap.com/en_il/flights-from-tel-aviv',allDestinations:true},
 {airline:'PR',origin:'MNL',destination:'BKK',sourceUrl:'https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok'},
 {airline:'EI',origin:'DUB',destination:'AMS',sourceUrl:'https://www.aerlingus.com/en-ie/flights-from-dublin',allDestinations:true},
 {airline:'VS',origin:'TLV',destination:'LHR',sourceUrl:'https://flights.virginatlantic.com/en-il/flights-from-tel-aviv',allDestinations:true},
 {airline:'NZ',origin:'LAX',destination:'AKL',sourceUrl:'https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles',allDestinations:true},
];
const results=[];
for(const page of pages){const now=new Date();try{
 const response=await fetch(page.sourceUrl,{redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(response.status!==200)throw new Error(`HTTP ${response.status}`);
 const reader=response.body.getReader();const chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2000000){await reader.cancel();throw new Error('Response too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const fares=parsePublishedFares(Buffer.concat(chunks).toString('utf8'),{...page,now});
 const result={airline:page.airline,page:page.sourceUrl,checkedAt:now.toISOString(),fares};results.push(result);
 console.log(JSON.stringify({airline:page.airline,status:200,fares:fares.length,bytes:size}));
}catch(error){results.push({airline:page.airline,error:error.message});console.log(JSON.stringify({airline:page.airline,error:error.message}));}}
await writeFile('public-page-probe.json',JSON.stringify(results,null,2));
