import {normalizeFlydubaiFares} from './flydubai-fares.mjs';

const AIRPORT=/^[A-Z]{3}$/;
function validRawRecords(records){
 return Array.isArray(records)&&records.length<=500&&records.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&AIRPORT.test(row.origin)&&AIRPORT.test(row.destination)&&row.origin!==row.destination&&AIRPORT.test(row.currency)&&row.type==='OWRT'&&(('owAmount' in row&&'owDepartureDate' in row)||('amount' in row&&'departureDate' in row)));
}
function officialPage(value){
 if(typeof value!=='string')throw Error('Invalid official page');
 const page=new URL(value);
 if(page.href!==value||page.protocol!=='https:'||page.hostname!=='www.flydubai.com'||page.port||page.username||page.password||page.search||page.hash||!/^\/en-ae\/flights-(from|to)-[a-z-]+\/$/.test(page.pathname))throw Error('Invalid official page');
 return page;
}

/** Publication is selected from observed pages and approved actual airport pairs only. */
export function approvedFlydubaiInventory(inventory,catalog){
 if(!Array.isArray(inventory)||!inventory.length||inventory.length>1000||!Array.isArray(catalog)||!catalog.length||catalog.length>5000)throw Error('Invalid publication inventory');
 const observed=new Map();
 for(const item of inventory){
  const page=officialPage(item?.url),parent=officialPage(item?.observedOn);
  if(page.origin!==parent.origin||observed.has(page.href))throw Error('Invalid observed page');
  observed.set(page.href,item);
 }
 const approved=new Map(),identities=new Set();
 for(const config of catalog){
  const page=officialPage(config?.sourceUrl);
  if(!observed.has(page.href)||!AIRPORT.test(config?.origin)||!AIRPORT.test(config?.destination)||config.origin===config.destination)throw Error('Unobserved publication identity');
  const identity=[page.href,config.origin,config.destination].join(':');
  if(identities.has(identity))throw Error('Duplicate publication identity');
  identities.add(identity);
  if(!approved.has(page.href))approved.set(page.href,[]);
  approved.get(page.href).push({origin:config.origin,destination:config.destination,sourceUrl:page.href});
 }
 return [...observed.values()].filter(item=>approved.has(item.url)).map(item=>({...item,approvedPairs:approved.get(item.url)}));
}

/** Reparse unchanged raw records for every approved pair sharing the official page. */
export function flydubaiPublicationSnapshot(observation,approvedPairs){
 const page=officialPage(observation?.page);
 if(!Number.isFinite(Date.parse(observation?.checkedAt))||!validRawRecords(observation?.records)||!Array.isArray(approvedPairs)||!approvedPairs.length)throw Error('Invalid observation');
 const fares=[];
 for(const pair of approvedPairs){
  if(pair?.sourceUrl!==page.href||!AIRPORT.test(pair?.origin)||!AIRPORT.test(pair?.destination)||pair.origin===pair.destination)throw Error('Unapproved publication pair');
  fares.push(...normalizeFlydubaiFares(observation.records,{origin:pair.origin,destination:pair.destination,sourceUrl:page.href,checkedAt:observation.checkedAt}));
 }
 const first=approvedPairs[0];
 return {page:page.href,checkedAt:observation.checkedAt,records:observation.records,origin:first.origin,destination:first.destination,expectedFares:new Set(fares.map(fare=>JSON.stringify(fare))).size};
}

export async function publishFlydubaiObservation(observation,key,fetchFn=fetch){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw Error('Invalid collector configuration');
 officialPage(observation?.page);
 if(!Number.isFinite(Date.parse(observation?.checkedAt))||!validRawRecords(observation?.records)||!AIRPORT.test(observation?.origin)||!AIRPORT.test(observation?.destination)||observation.origin===observation.destination||!Number.isSafeInteger(observation?.expectedFares)||observation.expectedFares<0||observation.expectedFares>1000)throw Error('Invalid observation');
 const body=JSON.stringify({source:'flydubai_page',page:observation.page,checkedAt:observation.checkedAt,records:observation.records,origin:observation.origin,destination:observation.destination,clearIfNoPrices:true});
 if(Buffer.byteLength(body)>128000)throw Error('Payload size limit');
 const response=await fetchFn('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Object.assign(Error(`Ingestion HTTP ${response.status}`),{fatal:[401,403].includes(response.status)});
 const result=await response.json();
 if(result.fares!==observation.expectedFares||result.checkedAt!==observation.checkedAt)throw Error('Ingestion receipt mismatch');
 return {published:result.fares,checkedAt:result.checkedAt};
}
