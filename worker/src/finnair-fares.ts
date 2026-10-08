import type {PublishedFare} from "./sources/published-fares";
export const FINNAIR_PAGE="https://www.finnair.com/en/flights/from/hel/flights-from-Helsinki";
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const date=(v:unknown):v is string=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
/** Official serialized public price records, never execute embedded page scripts. */
export function parseFinnairFares(html:string,now:Date):PublishedFare[]{
 if(html.length>4_000_000)throw new Error("Official page too large");
 const match=/<script[^>]*id=["']fcom-ux-state["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
 if(!match)return [];
 const queue:unknown[]=[JSON.parse(match[1]!)];const results:PublishedFare[]=[];const seen=new Set<string>();let visited=0;
 while(queue.length){
  if(++visited>200000)throw new Error("Published data too complex");
  const v=queue.pop();if(!record(v)&&!Array.isArray(v))continue;
  if(record(v)&&v.from==="HEL"&&typeof v.to==="string"&&/^[A-Z]{3}$/.test(v.to)&&!["HEL","XTP","XTZ"].includes(v.to)&&date(v.fromDate)&&date(v.toDate)&&v.toDate>v.fromDate&&v.fromDate>=now.toISOString().slice(0,10)&&v.currency==="EUR"&&Array.isArray(v.travelClassPrices)){
   for(const p of v.travelClassPrices){
    if(!record(p)||p.travelClass!=="Economy"||typeof p.price!=="number"||!Number.isFinite(p.price)||p.price<=0)continue;
    const key=JSON.stringify([v.to,v.fromDate,v.toDate,p.price]);if(seen.has(key))continue;seen.add(key);
    if(results.length>=20000)throw new Error("Too many published fares");
    results.push({airline:"AY",origin:"HEL",destination:v.to,departDate:v.fromDate,returnDate:v.toDate,amount:p.price,currency:"EUR",structure:"roundtrip",sourceUrl:FINNAIR_PAGE,checkedAt:now.toISOString(),pricing:"published_advertisement"});
   }
  }
  queue.push(...Object.values(v));
 }
 return results;
}


