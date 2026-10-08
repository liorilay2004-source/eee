import {collectorAccessStatus} from "./collector-access";
import {AEGEAN_DEMAND_OBJECT} from "./aegean-on-demand";
import {aegeanHttpCalendarUrl} from "./aegean-http-calendar";
import type {AegeanCalendarTrip} from "./aegean-lowfare";
import type {Env} from "./types";

const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
/** No public queue inventory, passenger information, caller URLs or D1 access. */
export async function handleAegeanDemand(request:Request,env:Env):Promise<Response>{
 if(!["GET","POST"].includes(request.method))return reply(405,{error:"method_not_allowed"});
 const denied=await collectorAccessStatus(request,env);
 if(denied)return reply(denied,{error:denied===401?"unauthorized":"collector_unavailable"});
 if(!env.PUBLIC_FARES)return reply(503,{error:"storage_unavailable"});
 const url=new URL(request.url);
 if(url.search)return reply(400,{error:"invalid_query"});
 if(request.method==="GET"){
  try{
   const queue=env.PUBLIC_FARES.getByName(AEGEAN_DEMAND_OBJECT);
   if(!queue.pendingAegean)return reply(503,{error:"storage_unavailable"});
   return reply(200,{trips:await queue.pendingAegean(12)});
  }catch{return reply(503,{error:"storage_unavailable"});}
 }
 if(!(request.headers.get("Content-Type")??"").startsWith("application/json")||!request.body)return reply(400,{error:"invalid_payload"});
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>4096){await reader.cancel();return reply(413,{error:"payload_too_large"});}chunks.push(chunk.value);}}finally{reader.releaseLock();}
 const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 let trip:AegeanCalendarTrip;
 try{
  const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(data));
  if(!raw?.trip||typeof raw.trip!=="object"||Array.isArray(raw.trip))throw Error();
  const selected=raw.trip;
  trip={origin:selected.origin,destination:selected.destination,departDate:selected.departDate,returnDate:selected.returnDate};
  aegeanHttpCalendarUrl(trip);
 }catch{return reply(400,{error:"invalid_trip"});}
 try{
  const queue=env.PUBLIC_FARES.getByName(AEGEAN_DEMAND_OBJECT);
  if(!queue.claimAegean)return reply(503,{error:"storage_unavailable"});
  return reply(200,{claimed:await queue.claimAegean(trip)});
 }catch{return reply(503,{error:"storage_unavailable"});}
}
