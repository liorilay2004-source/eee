import pages from '../kenya-published-catalog.json';
import type {PublicFareCache} from '../public-fare-cache';
import type {FareQuoteSource,QuoteQuery} from '../quotes';
import type {PublishedFare} from './published-fares';
import {matchPublishedTrip} from './published-source';
export function createKenyaCachedSource(now:Date,cache?:PublicFareCache):FareQuoteSource{
 const pending=new Map<string,Promise<PublishedFare[]>>();
 async function fares(q:QuoteQuery):Promise<PublishedFare[]>{
  if(q.party.adults!==1||q.party.children||q.party.infants||(q.adults??1)!==1||q.returnDate<=q.departDate)return [];
  const urls=[...new Set(pages.filter(p=>p.origin===q.origin&&p.destination===q.destination||p.origin===q.destination&&p.destination===q.origin).map(p=>p.sourceUrl))];
  const results=await Promise.allSettled(urls.map(page=>{
   if(!pending.has(page))pending.set(page,(async()=>{const stored=await cache?.get<PublishedFare>(page);if(!stored||stored.expires<=now.getTime())return [];return stored.fares.filter(f=>{const age=now.getTime()-Date.parse(f.checkedAt);return f.airline==='KQ'&&f.sourceUrl===page&&Number.isFinite(age)&&age>=0&&age<600000;});})());
   return pending.get(page)!;
  }));
  return [...new Map(results.flatMap(r=>r.status==='fulfilled'?r.value:[]).map(f=>[JSON.stringify(f),f])).values()];
 }
 async function quote(q:QuoteQuery){return matchPublishedTrip(await fares(q),q,{airline:'KQ',source:'kenya'});}
 return {name:'kenya',configured:true, cacheOnly: true,quota:{period:'monthly',cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,quote,
  async validatesStoredOffer(offer){const current=await quote({origin:offer.origin,destination:offer.destination,departDate:offer.departDate,returnDate:offer.returnDate,party:{adults:1,children:0,infants:0}});return current.some(f=>f.priceAmount===offer.priceAmount&&f.priceCurrency===offer.priceCurrency&&f.checkedAt===offer.checkedAt&&f.deeplink===offer.deeplink&&f.returnDeeplink===offer.returnDeeplink);}
 };
}
