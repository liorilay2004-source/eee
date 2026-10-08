import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fareRecords} from './fare-records.mjs';
import {publishPageObservation} from './publish-page-observation.mjs';

const providers={
 royal_air_maroc:{airline:'AT',catalog:'royal-air-maroc',raw:'eco',formatted:['Economy','Économique']},
 china_airlines:{airline:'CI',catalog:'china-airlines',raw:'經濟艙 基本',formatted:['Economy']},
 korean_air:{airline:'KE',catalog:'korean',raw:'Y',formatted:['Economy Class']},
};
for(const config of Object.values(providers))config.pages=JSON.parse(await readFile(new URL(`../worker/src/${config.catalog}-published-catalog.json`,import.meta.url),'utf8'));
const realDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function additionalPublishedPages(provider){
 const config=providers[provider];if(!config)throw new Error('Unsupported public provider');
 const pages=[...new Set(config.pages.map(row=>row.sourceUrl))];
 if(!pages.length||pages.length>20)throw new Error('Unsupported publication coverage');
 return pages;
}
/** Counts only exact observed cash-economy records; the Worker parses the raw records independently. */
export function normalizeAdditionalAdvertisements(records,{provider,page,checkedAt}){
 const config=providers[provider];
 if(!config||!additionalPublishedPages(provider).includes(page)||!Array.isArray(records)||records.length>500
  ||typeof checkedAt!=='string'||!Number.isFinite(Date.parse(checkedAt))||new Date(checkedAt).toISOString()!==checkedAt)throw new Error('Invalid public observation');
 const seen=new Set(),fares=[];
 for(const row of records){
  if(!row||row.__typename!=='Fare'||row.travelClass!==config.raw||row.farenetTravelClass!=='ECONOMY'
   ||!config.formatted.includes(row.formattedTravelClass)||!(row.promoCode===''||row.promoCode===null)
   ||!(row.redemption===null||row.redemption===false)||!realDate(row.departureDate)||row.departureDate<checkedAt.slice(0,10)
   ||typeof row.totalPrice!=='number'||!Number.isFinite(row.totalPrice)||row.totalPrice<=0||row.totalPrice>1e9
   ||!/^[A-Z]{3}$/.test(row.currencyCode??'')||!config.pages.some(p=>p.sourceUrl===page&&p.origin===row.originAirportCode&&p.destination===row.destinationAirportCode))continue;
  const oneWay=row.flightType==='ONE_WAY'&&(row.returnDate==null||row.returnDate==='');
  const roundTrip=row.flightType==='ROUND_TRIP'&&realDate(row.returnDate)&&row.returnDate>row.departureDate;
  if(!oneWay&&!roundTrip)continue;
  const fare={airline:config.airline,origin:row.originAirportCode,destination:row.destinationAirportCode,
   departDate:row.departureDate,returnDate:roundTrip?row.returnDate:null,structure:oneWay?'oneway':'roundtrip',
   amount:row.totalPrice,currency:row.currencyCode,sourceUrl:page,checkedAt,pricing:'published_advertisement',operator:null,checkoutVerified:false};
  const identity=JSON.stringify([fare.origin,fare.destination,fare.departDate,fare.returnDate,fare.amount,fare.currency]);
  if(!seen.has(identity)){seen.add(identity);fares.push(fare);}
 }
 return fares;
}
export async function collectAdditionalPublishedPages({provider,key,outputDirectory='.',fetchFn=fetch,now=()=>new Date()}){
 if(key&&!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid collector configuration');
 const pages=additionalPublishedPages(provider),results=[];
 const safeFetch=async(url,options)=>{try{return await fetchFn(url,{...options,redirect:'manual'});}catch{throw new Error('Collector request failed');}};
 await mkdir(outputDirectory,{recursive:true});
 const checkpoint=()=>writeFile(resolve(outputDirectory,`${provider}-published-observations.json`),JSON.stringify(results,null,2));
 for(const page of pages){
  const checkedAt=now().toISOString();let observation={page,checkedAt};
  try{
   const response=await safeFetch(page,{signal:AbortSignal.timeout(15000),headers:{Accept:'text/html'}});
   if(response.status!==200||!response.body)throw new Error(`Official page HTTP ${response.status}`);
   const reader=response.body.getReader(),chunks=[];let bytes=0;
   try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2_000_000)throw new Error('Official page size limit');chunks.push(part.value);}}finally{await reader.cancel();}
   const records=fareRecords(Buffer.concat(chunks).toString('utf8'));
   if(!records.length)throw new Error('No explicit published Fare records');
   const fares=normalizeAdditionalAdvertisements(records,{provider,page,checkedAt});
   observation={...observation,bytes,records,fares};results.push(observation);await checkpoint();
   if(key&&!fares.length)throw new Error('No validated cash economy fares');
   if(key)observation.publication=await publishPageObservation({airline:providers[provider].airline,page,checkedAt,records,expectedFares:fares.length},key,safeFetch);
  }catch(error){
   observation.error=error.message;if(!results.includes(observation))results.push(observation);await checkpoint();
   if(error.fatal)throw error;
  }
  await checkpoint();
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const rows=await collectAdditionalPublishedPages({provider:process.env.PUBLIC_PAGE_PROVIDER,key:process.env.COLLECTOR_KEY,outputDirectory:process.env.PUBLIC_PAGE_OUTPUT_DIRECTORY??'.'});
  console.log(JSON.stringify({pages:rows.length,publishedPages:rows.filter(r=>r.publication).length,publishedFares:rows.reduce((n,r)=>n+(r.publication?.published??0),0),pageErrors:rows.filter(r=>r.error).length}));
  if(rows.some(r=>r.error))process.exitCode=1;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
