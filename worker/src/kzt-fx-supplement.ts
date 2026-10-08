import {NBK_RATES_URL,parseNbkKzt} from './nbk-fx';
import {readFxCache,writeFxCache} from './fx-cache';
import type {FxRates} from './types';
type Storage=Pick<Cache,'match'|'put'>;
const pending=new WeakMap<object,{hour:number;result:Promise<{date:string;rateToIls:number}|null>}>();
/** Add only the missing KZT rate, preserving every primary currency and its date. */
export async function supplementKztFx(base:FxRates,required:readonly string[],fetchFn:typeof fetch,now:Date,storage?:Storage):Promise<FxRates>{
 if(!required.includes('KZT')||(base.ratesToIls.KZT??0)>0)return base;
 const load=async()=>{
  const cached=await readFxCache(storage,now,'nbk');if(cached&&(cached.ratesToIls.KZT??0)>0)return {date:cached.date,rateToIls:cached.ratesToIls.KZT!};
  try{
   const response=await fetchFn(NBK_RATES_URL,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/xml'}});
   if(!response.ok||!response.body)return null;
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32000)return null;chunks.push(part.value);}}finally{await reader.cancel();}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   const rate=parseNbkKzt(new TextDecoder().decode(bytes),now);if(!rate)return null;
   await writeFxCache(storage,now,{date:rate.date,source:rate.date<now.toISOString().slice(0,10)?'nbk:stale':'nbk',ratesToIls:{ILS:1,USD:base.ratesToIls.USD!,KZT:rate.rateToIls}},'nbk');
   return rate;
  }catch{return null;}
 };
 const key=storage??fetchFn,hour=Math.floor(now.getTime()/3600000);
 if(pending.get(key)?.hour!==hour)pending.set(key,{hour,result:load()});
 const rate=await pending.get(key)!.result;if(!rate)return base;
 const date=base.date<rate.date?base.date:rate.date;
 return {...base,date,source:base.source.replace(/:stale$/,'')+'+nbk'+(date<now.toISOString().slice(0,10)?':stale':''),ratesToIls:{...base.ratesToIls,KZT:rate.rateToIls}};
}
