import routes from '../hawaiian-route-catalog.json';
import type {HawaiianAdvertisement} from '../../../collector/hawaiian-fares.mjs';
import type {PublicFareCache} from '../public-fare-cache';
import type {FareQuoteSource,QuoteQuery} from '../quotes';
import type {Offer} from '../types';
/** Reads externally refreshed official advertisements. Never infers operator or flight details. */
export function createHawaiianCachedSource(now:Date,cache?:PublicFareCache):FareQuoteSource{
 const pending=new Map<string,Promise<HawaiianAdvertisement[]>>();
 async function fares(q:QuoteQuery){
  if(q.party.adults!==1||q.party.children||q.party.infants||(q.adults??1)!==1)return [];
  const pages=[...new Set(routes.filter(r=>r.origin===q.origin&&r.destination===q.destination||r.origin===q.destination&&r.destination===q.origin).map(r=>r.page))];
  const results=await Promise.allSettled(pages.map(page=>{
   if(!pending.has(page))pending.set(page,(async()=>{const stored=await cache?.get<HawaiianAdvertisement>(page);if(!stored||stored.expires<=now.getTime())return [];return stored.fares.filter(f=>f.sourceUrl===page&&Number.isFinite(Date.parse(f.fetchedAt))&&Date.parse(f.fetchedAt)<=now.getTime()&&now.getTime()-Date.parse(f.fetchedAt)<600000);})());
   return pending.get(page)!;
  }));
  return [...new Map(results.flatMap(r=>r.status==='fulfilled'?r.value:[]).map(f=>[JSON.stringify(f),f])).values()];
 }
 async function quote(q:QuoteQuery):Promise<Offer[]>{
  const rows=await fares(q),out=rows.filter(f=>f.origin===q.origin&&f.destination===q.destination&&f.departDate===q.departDate),back=rows.filter(f=>f.structure==='oneway'&&f.origin===q.destination&&f.destination===q.origin&&f.departDate===q.returnDate);
  const build=(f:HawaiianAdvertisement,b?:HawaiianAdvertisement):Offer=>({origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,source:'hawaiian',priceAmount:Math.round((f.amount+(b?.amount??0))*100)/100,priceCurrency:f.currency,ticketStructure:b?'split':'roundtrip',outbound:{departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]},inbound:{departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]},includes:{},deeplink:f.sourceUrl,...(b?{returnDeeplink:b.sourceUrl}:{}),verifyLink:null,checkedAt:b&&b.fetchedAt<f.fetchedAt?b.fetchedAt:f.fetchedAt,extrasAmountIls:0,totalIls:null,tags:['published_advertisement','operator_unknown']});
  const offers=out.filter(f=>f.structure==='roundtrip'&&f.returnDate===q.returnDate).map(f=>build(f));
  for(const f of out.filter(f=>f.structure==='oneway'))for(const b of back)if(f.currency===b.currency)offers.push(build(f,b));
  return offers;
 }
 return {name:'hawaiian',configured:true, cacheOnly: true,quota:{period:'monthly',cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,quote,
  async validatesStoredOffer(offer){const current=await quote({origin:offer.origin,destination:offer.destination,departDate:offer.departDate,returnDate:offer.returnDate,party:{adults:1,children:0,infants:0}});return current.some(f=>f.priceAmount===offer.priceAmount&&f.priceCurrency===offer.priceCurrency&&f.checkedAt===offer.checkedAt&&f.deeplink===offer.deeplink&&f.returnDeeplink===offer.returnDeeplink);}
 };
}
