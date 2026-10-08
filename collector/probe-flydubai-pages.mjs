import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {normalizeFlydubaiFares} from './flydubai-fares.mjs';
import {approvedFlydubaiInventory,flydubaiPublicationSnapshot,publishFlydubaiObservation} from './publish-flydubai-observation.mjs';

export async function probeFlydubaiPages({inventory,approved=[],key,offset=0,limit=15,approvedOnly=false,fetchFn=fetch,now=()=>new Date(),checkpoint=async()=>{},log=console.log}){
 if(!Array.isArray(inventory)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw Error('Invalid batch');
 if(approvedOnly&&(!Array.isArray(approved)||!approved.length))throw Error('Invalid publication inventory');
 if(key&&!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid collector configuration');
 const selectedApproved=approved.length?approvedFlydubaiInventory(inventory,approved):[];
 const selection=approvedOnly?selectedApproved:inventory;
 if(approvedOnly&&!key)throw Error('Missing collector configuration');
 if(offset>selection.length)throw Error('Invalid batch');
 const approvedByPage=new Map(selectedApproved.map(item=>[item.url,item.approvedPairs]));
 async function get(url){
  const response=await fetchFn(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.status!==200)throw Error('HTTP '+response.status);
  if(!response.body)throw Error('Missing response body');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2000000)throw Error('Size limit');parts.push(part.value);}}finally{await reader.cancel();}
  return Buffer.concat(parts).toString('utf8');
 }
 const results=[];let failed=false;
 for(const item of selection.slice(offset,offset+limit)){
  const pageCheckedAt=now().toISOString();
  try{
   const page=new URL(item.url),parent=new URL(item.observedOn);
   if(page.origin!==parent.origin||page.protocol!=='https:'||page.hostname!=='www.flydubai.com'||page.port||page.username||page.password||page.search||page.hash||!/^\/en-ae\/flights-(from|to)-[a-z-]+\/$/.test(page.pathname))throw Error('Unapproved page');
   const html=await get(page),raw=html.match(/<script[^>]+id=['"]__NEXT_DATA__['"][^>]*>([\s\S]*?)<\/script>/)?.[1];
   if(!raw)throw Error('No official page schema');
   const data=JSON.parse(raw)?.props?.pageProps?.Props?.Data;
   if(!Array.isArray(data))throw Error('No official page schema');
   const inlineContainer=data.find(entry=>entry?.seofarewithoutimage)?.seofarewithoutimage;
   const inline=inlineContainer?.data;
   if(inlineContainer&&!Array.isArray(inline))throw Error('Invalid inline price schema');
   const snapshotRecords=[];
   if(Array.isArray(inline)){
    if(inline.length>500)throw Error('Inline record limit');
    const pairs=[...new Map(inline.filter(row=>row&&/^[A-Z]{3}$/.test(row.origin)&&/^[A-Z]{3}$/.test(row.destination)).map(row=>[row.origin+':'+row.destination,{origin:row.origin,destination:row.destination}])).values()];
    const fares=pairs.flatMap(pair=>normalizeFlydubaiFares(inline,{...pair,sourceUrl:page.href,checkedAt:pageCheckedAt}));
    results.push({url:item.url,observedOn:item.observedOn,checkedAt:pageCheckedAt,records:inline,fares,format:'inline'});
    snapshotRecords.push(...inline);
    log(JSON.stringify({page:page.href,format:'inline',fares:fares.length}));
   }
   const monthly=data.find(entry=>entry?.seofaremonthlycardtabs)?.seofaremonthlycardtabs;
   const configs=monthly?.data??[];
   if(!Array.isArray(configs)||configs.length>20)throw Error('Invalid configurations');
   const coveredPairs=new Set();
   for(const config of configs){
    const params=config?.apiParams;
    if(!params||!/^[A-Z]{3}$/.test(params.org)||!/^[A-Z]{3}$/.test(params.dest)||params.org===params.dest)continue;
    if(Object.values(params).some(value=>!['string','number','boolean'].includes(typeof value)))throw Error('Invalid API parameters');
    const api=new URL('/en-ae/flights/api/lowfare/',page);
    api.search=new URLSearchParams({...params,journeytype:'OWRT'});
    const checkedAt=now().toISOString(),records=JSON.parse(await get(api));
    if(records!==null&&(!Array.isArray(records)||records.length>500))throw Error('Invalid API price schema');
    // An explicit upstream null for this validated official configuration means no ads.
    const rawRecords=records??[];
    const fares=normalizeFlydubaiFares(rawRecords,{origin:params.org,destination:params.dest,sourceUrl:page.href,checkedAt});
    coveredPairs.add(params.org+':'+params.dest);
    snapshotRecords.push(...rawRecords);
    results.push({url:item.url,observedOn:item.observedOn,checkedAt,apiParams:params,records,fares});
    log(JSON.stringify({page:page.href,origin:params.org,destination:params.dest,fares:fares.length}));
   }
   const pairs=approvedByPage.get(page.href);
   if(!Array.isArray(inline)&&coveredPairs.size===0){
    results.push({url:item.url,observedOn:item.observedOn,reason:'no_monthly_price_configuration',fares:[]});
    if(key&&pairs)throw Error('No explicit price schema; publication skipped');
   }else if(key&&pairs){
    if(!Array.isArray(inline)&&pairs.some(pair=>!coveredPairs.has(pair.origin+':'+pair.destination)))throw Error('Incomplete approved configuration coverage; publication skipped');
    const records=[...new Map(snapshotRecords.map(record=>[JSON.stringify(record),record])).values()];
    const snapshot=flydubaiPublicationSnapshot({page:page.href,checkedAt:pageCheckedAt,records},pairs);
    const publication=await publishFlydubaiObservation(snapshot,key,fetchFn);
    // One complete original snapshot per page prevents pair uploads from erasing each other.
    const observation={url:item.url,observedOn:item.observedOn,checkedAt:pageCheckedAt,records,format:'published_page',publication};
    results.push(observation);log(JSON.stringify({page:page.href,...publication}));
   }
  }catch(error){
   failed=true;results.push({url:item.url,observedOn:item.observedOn,checkedAt:pageCheckedAt,error:error.message});
   if(error.fatal){await checkpoint(results);throw error;}
  }
  await checkpoint(results);
 }
 return {results,failed};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const inventory=JSON.parse(await readFile(new URL('./flydubai-observed-pages.json',import.meta.url),'utf8'));
 const approvedOnly=process.env.FLYDUBAI_PUBLISH_APPROVED==='true';
 const approved=process.env.COLLECTOR_KEY||approvedOnly?JSON.parse(await readFile(new URL('../worker/src/flydubai-published-catalog.json',import.meta.url),'utf8')):[];
 const output=process.env.FLYDUBAI_OUTPUT??'flydubai-page-observations.json';
 const result=await probeFlydubaiPages({inventory,approved,key:process.env.COLLECTOR_KEY,approvedOnly,offset:Number(process.env.FLYDUBAI_OFFSET??0),limit:Number(process.env.FLYDUBAI_LIMIT??15),checkpoint:rows=>writeFile(output,JSON.stringify(rows,null,2))});
 if(result.failed)process.exitCode=1;
}
