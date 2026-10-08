import {readFile,writeFile} from 'node:fs/promises';
import {normalizeFlydubaiFares} from './flydubai-fares.mjs';
const inventory=JSON.parse(await readFile(new URL('./flydubai-observed-pages.json',import.meta.url),'utf8'));
const offset=Number(process.env.FLYDUBAI_OFFSET??0),limit=Number(process.env.FLYDUBAI_LIMIT??15);
if(!Number.isInteger(offset)||offset<0||offset>inventory.length||!Number.isInteger(limit)||limit<1||limit>20)throw Error('Invalid batch');
async function get(url){const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error('HTTP '+r.status);const reader=r.body.getReader(),parts=[];let size=0;try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>2000000)throw Error('Size limit');parts.push(p.value)}}finally{await reader.cancel()}return Buffer.concat(parts).toString('utf8')}
const results=[];
for(const item of inventory.slice(offset,offset+limit)){
 try{const page=new URL(item.url),parent=new URL(item.observedOn);if(page.origin!==parent.origin||page.protocol!=='https:'||page.hostname!=='www.flydubai.com'||page.port||page.username||page.password||page.search||page.hash||!/^\/en-ae\/flights-(from|to)-[a-z-]+\/$/.test(page.pathname))throw Error('Unapproved page');
 const html=await get(page),raw=html.match(/<script[^>]+id=['"]__NEXT_DATA__['"][^>]*>([\s\S]*?)<\/script>/)?.[1];if(!raw)throw Error('No official page schema');
 const props=JSON.parse(raw)?.props?.pageProps?.Props;const configs=props?.Data?.find(d=>d.seofaremonthlycardtabs)?.seofaremonthlycardtabs?.data??[];
 if(!Array.isArray(configs)||configs.length>20)throw Error('Invalid configurations');
 if(configs.length===0)results.push({...item,reason:'no_monthly_price_configuration',fares:[]});
 for(const config of configs){const p=config.apiParams;if(!p||!/^[A-Z]{3}$/.test(p.org)||!/^[A-Z]{3}$/.test(p.dest))continue;const api=new URL('/en-ae/flights/api/lowfare/',page);api.search=new URLSearchParams({...p,journeytype:'OWRT'});const checkedAt=new Date().toISOString(),records=JSON.parse(await get(api));const fares=records===null?[]:normalizeFlydubaiFares(records,{origin:p.org,destination:p.dest,sourceUrl:page.href,checkedAt});results.push({...item,checkedAt,apiParams:p,records,fares});console.log(JSON.stringify({page:page.href,origin:p.org,destination:p.dest,fares:fares.length}));}
 }catch(e){results.push({...item,error:e.message});process.exitCode=1;}
 await writeFile(process.env.FLYDUBAI_OUTPUT??'flydubai-page-observations.json',JSON.stringify(results,null,2));
}
