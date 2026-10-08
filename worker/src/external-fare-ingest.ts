import {keyMatches} from "./access";
import {parseLhgAdvertisements} from "./brussels-advertisements";
import {EXTERNAL_FARE_PAGES} from "./external-fare-catalog";
import {parseRyanairCalendar,ryanairCalendarUrl} from "./sources/ryanair-direct";
import {parseAirSerbiaCalendar} from "./airserbia-calendar";
import {airSerbiaCalendarUrl} from "./sources/airserbia-direct";
import {EXTERNAL_PUBLISHED_PAGES} from "./external-published-catalog";
import {parsePublishedFares} from "./sources/published-fares";
import {parseIberiaFares} from "./iberia-fares";
import {cacheRequest,createPublicFareCache} from "./public-fare-cache";
import type {Env} from "./types";
const TTL=600000;
const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
/** Machine-only ingestion: authentication precedes body reads; never fetch caller URLs or write D1. */
export async function ingestPublicFares(request:Request,env:Env,now=new Date()):Promise<Response>{
 if(request.method!=="POST")return reply(405,{error:"method_not_allowed"});
 if(!env.COLLECTOR_KEY||!/^[a-f0-9]{64}$/.test(env.COLLECTOR_KEY))return reply(503,{error:"collector_unavailable"});
 const given=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization")??"")?.[1];
 if(!given||!await keyMatches(given,env.COLLECTOR_KEY))return reply(401,{error:"unauthorized"});
 if(!env.PUBLIC_FARES)return reply(503,{error:"storage_unavailable"});
 if(!(request.headers.get("Content-Type")??"").startsWith("application/json"))return reply(415,{error:"unsupported_media_type"});
 if(!request.body)return reply(400,{error:"invalid_payload"});
 const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>128000){await reader.cancel();return reply(413,{error:"payload_too_large"});}chunks.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let raw:unknown;try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes));}catch{return reply(400,{error:"invalid_payload"});}
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return reply(400,{error:"invalid_payload"});
 const v=raw as Record<string,unknown>,entry=EXTERNAL_FARE_PAGES.find(p=>p.source===v.source&&p.page===v.page);
 const at=typeof v.checkedAt==="string"?Date.parse(v.checkedAt):NaN,age=now.getTime()-at;
 if(v.source==="published_page"){
  const page=EXTERNAL_PUBLISHED_PAGES.find(p=>p.airline===v.airline&&p.sourceUrl===v.page);
  if(!page)return reply(400,{error:"unapproved_page"});
  if(!Number.isFinite(age)||age<0||age>120000)return reply(400,{error:"invalid_observation_time"});
  if(page.airline==="IB"?typeof v.html!=="string"||v.html.length>120000:!Array.isArray(v.records)||v.records.length>500)return reply(400,{error:"invalid_records"});
  let fares;
  try{if(page.airline==="IB")fares=parseIberiaFares(v.html as string,new Date(at));else{const data=JSON.stringify(v.records).replace(/</g,"\\u003c");fares=parsePublishedFares(`<script id="__NEXT_DATA__">${data}</script>`,{...page,now:new Date(at)});}}catch{return reply(400,{error:"invalid_page_records"});}
  if(!fares.length)return reply(422,{error:"no_valid_prices"});
  try{await env.PUBLIC_FARES.getByName(cacheRequest(page.sourceUrl).url).write(page.sourceUrl,JSON.stringify({storedAt:at,expires:at+TTL,fares}));}catch{return reply(503,{error:"storage_unavailable"});}
  return reply(200,{source:v.source,airline:page.airline,fares:fares.length,checkedAt:new Date(at).toISOString()});
 }
 if(v.source==="ryanair"||v.source==="air_serbia"){
  if(!Number.isFinite(age)||age<0||age>120000||typeof v.origin!=="string"||typeof v.destination!=="string"||typeof v.month!=="string"||!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.month))return reply(400,{error:"invalid_payload"});
  let page:string,fares:unknown[];
  try{
   page=v.source==="ryanair"?ryanairCalendarUrl(v.origin,v.destination,v.month):airSerbiaCalendarUrl(v.origin,v.destination,`${v.month}-01`);
   if(page!==v.page)return reply(400,{error:"invalid_payload"});
   fares=v.source==="ryanair"?parseRyanairCalendar(v.body,v.origin,v.destination,v.month,new Date(at)):parseAirSerbiaCalendar(v.body,{origin:v.origin,destination:v.destination,year:Number(v.month.slice(0,4)),month:Number(v.month.slice(5)),now:new Date(at)});
  }catch{return reply(400,{error:"invalid_payload"});}
  if(!fares.length||fares.length>31)return reply(422,{error:"no_valid_prices"});
  try{await env.PUBLIC_FARES.getByName(cacheRequest(page).url).write(page,JSON.stringify({storedAt:at,expires:at+TTL,fares}));}catch{return reply(503,{error:"storage_unavailable"});}
  return reply(200,{source:v.source,fares:fares.length,checkedAt:new Date(at).toISOString()});
 }
 if(!entry||!Number.isFinite(age)||age<0||age>120000||!Array.isArray(v.anchors)||v.anchors.length>500)return reply(400,{error:"invalid_payload"});
 const anchors:{text:string;url:string}[]=[];
 for(const item of v.anchors){if(!item||typeof item!=="object"||typeof item.text!=="string"||item.text.length>2000||typeof item.url!=="string"||item.url.length>1000)return reply(400,{error:"invalid_payload"});anchors.push({text:item.text,url:item.url});}
 const fares=parseLhgAdvertisements(anchors,entry,new Date(at),{origin:entry.site,market:entry.market,currency:entry.currency});
 if(!fares.length)return reply(422,{error:"no_valid_prices"});
 try{await env.PUBLIC_FARES.getByName(cacheRequest(entry.page).url).write(entry.page,JSON.stringify({storedAt:at,expires:at+TTL,fares}));}catch{return reply(503,{error:"storage_unavailable"});}
 return reply(200,{source:entry.source,fares:fares.length,checkedAt:new Date(at).toISOString()});
}
/** External updates bypass regional snapshots so a fresh shared write is immediately visible. */
export function externalLhgCache(env:Env,now:Date){
 if(env.EXTERNAL_LHG_COLLECTOR!=="true"||!env.PUBLIC_FARES)return undefined;
 return createPublicFareCache({async match(request){const url=typeof request==="string"?request:request instanceof URL?request.href:request.url;const key=decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);const body=await env.PUBLIC_FARES!.getByName(url).read(key);return body===null?undefined:new Response(body);},async put(){throw new Error("Read-only collector cache");}},now);
}
