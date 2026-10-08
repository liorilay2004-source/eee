import {ECB_URL,ecbRatesDate,parseEcb} from "./fx";
import {readFxCache,writeFxCache} from "./fx-cache";
import type {FxRates} from "./types";
type Storage=Pick<Cache,"match"|"put">;
const pending=new WeakMap<object,{hour:number;result:Promise<FxRates|null>}>();
/** Supplement missing comparison currencies only; preserve all existing primary rates. */
export async function supplementFx(base:FxRates,required:readonly string[],fetchFn:typeof fetch,now:Date,storage?:Storage):Promise<FxRates> {
 if(required.every(code=>(base.ratesToIls[code]??0)>0))return base;
 const load=async():Promise<FxRates|null>=>{
  const cached=await readFxCache(storage,now,"ecb");if(cached)return cached;
  try {
   const response=await fetchFn(ECB_URL,{signal:AbortSignal.timeout(8000),headers:{accept:"application/xml"}});
   if(!response.ok||!response.body)return null;
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32000)return null;chunks.push(part.value);}}finally{await reader.cancel();}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
   const xml=new TextDecoder().decode(bytes),rates=parseEcb(xml),date=ecbRatesDate(xml);
   if(!rates||!date)return null;
   const days=(Date.parse(now.toISOString().slice(0,10))-Date.parse(date))/86400000;
   if(days<0||days>7)return null;
   const fx={date,source:days>0?"ecb:stale":"ecb",ratesToIls:{...rates,ILS:1}};
   await writeFxCache(storage,now,fx,"ecb");return fx;
  }catch{return null;}
 };
 const key=storage??fetchFn,hour=Math.floor(now.getTime()/3600000);
 if(pending.get(key)?.hour!==hour)pending.set(key,{hour,result:load()});
 const extra=await pending.get(key)!.result;if(!extra)return base;
 const missing=Object.fromEntries(Object.entries(extra.ratesToIls).filter(([code])=>base.ratesToIls[code]===undefined));
 if(!Object.keys(missing).length)return base;
 const date=base.date<extra.date?base.date:extra.date;
 const source=base.source.replace(/:stale$/,"")+"+ecb"+(date<now.toISOString().slice(0,10)?":stale":"");
 return {...base,date,source,ratesToIls:{...base.ratesToIls,...missing}};
}
