import {FRONTIER_PUBLISHED_PAGES} from "../frontier-published-catalog";
import type {PublicFareCache} from "../public-fare-cache";
import type {FareQuoteSource,QuoteQuery} from "../quotes";
import type {PublishedFare} from "./published-fares";
import {matchPublishedTrip} from "./published-source";
/** Only observed, authenticated external snapshots; no upstream request during search. */
export function createFrontierCachedSource(now:Date,cache?:PublicFareCache):FareQuoteSource{
 const pending=new Map<string,Promise<PublishedFare[]>>();
 async function fares(q:QuoteQuery):Promise<PublishedFare[]>{
  if(q.party.adults!==1||q.party.children||q.party.infants||(q.adults!==undefined&&q.adults!==1)||q.returnDate<=q.departDate)return [];
  const pages=FRONTIER_PUBLISHED_PAGES.filter(p=>p.origin===q.origin&&p.destination===q.destination||p.origin===q.destination&&p.destination===q.origin);
  const results=await Promise.allSettled([...new Set(pages.map(p=>p.sourceUrl))].map(page=>{
   if(!pending.has(page))pending.set(page,(async()=>{
    const stored=await cache?.get<PublishedFare>(page);if(!stored||stored.expires<=now.getTime())return [];
    return stored.fares.filter(f=>{const age=now.getTime()-Date.parse(f.checkedAt);return f.airline==='F9'&&f.sourceUrl===page&&f.structure==='oneway'&&f.returnDate===null&&Number.isFinite(age)&&age>=0&&age<600000;});
   })());
   return pending.get(page)!;
  }));
  return [...new Map(results.flatMap(r=>r.status==='fulfilled'?r.value:[]).map(f=>[JSON.stringify(f),f])).values()];
 }
 return {name:'frontier',configured:true, cacheOnly: true,quota:{period:'monthly',cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
  async validatesStoredOffer(offer){
   const q={origin:offer.origin,destination:offer.destination,departDate:offer.departDate,returnDate:offer.returnDate,party:{adults:1,children:0,infants:0}};
   const current=matchPublishedTrip(await fares(q),q,{airline:'F9',source:'frontier'});
   return current.some(f=>f.priceAmount===offer.priceAmount&&f.priceCurrency===offer.priceCurrency&&f.checkedAt===offer.checkedAt&&f.deeplink===offer.deeplink&&f.returnDeeplink===offer.returnDeeplink);
  },
  async quote(q){return matchPublishedTrip(await fares(q),q,{airline:'F9',source:'frontier'});},
  async oneWays(q){return (await fares(q)).filter(f=>f.origin===q.origin&&f.destination===q.destination&&f.departDate===q.departDate||f.origin===q.destination&&f.destination===q.origin&&f.departDate===q.returnDate).map(f=>({source:'frontier' as const,airline:f.airline,origin:f.origin,destination:f.destination,date:f.departDate,amount:f.amount,currency:f.currency,checkedAt:f.checkedAt,bookingUrl:f.sourceUrl,leg:{departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[f.airline]}}));}
 };
}
