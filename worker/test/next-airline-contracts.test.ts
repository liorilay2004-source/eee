import {describe,expect,it} from 'vitest';
import {createRepo} from '../src/db';
import {fareFreshness,UNSTATED_AGE_QUOTE_SOURCES} from '../src/freshness';
import {QUOTE_SOURCE_NAMES,describeQuoteError,isPublishedSource,isQuoteSource} from '../src/quotes';
import {SOURCE_REGISTRY} from '../src/source-registry';
import {EXTERNAL_PUBLISHED_PAGES} from '../src/external-published-catalog';
import {BACKGROUND_FARE_TTL_MS,cacheRequest,createPublicFareCache} from '../src/public-fare-cache';
import {createRoyalAirMarocCachedSource} from '../src/sources/royal-air-maroc-cached';
import {createChinaAirlinesCachedSource} from '../src/sources/china-airlines-cached';
import {createKoreanCachedSource} from '../src/sources/korean-cached';
import type {Offer,SourceName} from '../src/types';
import {createTestD1} from './helpers/d1';

const now=new Date('2026-10-08T12:30:00.000Z');
const checkedAt=new Date(now.getTime()-120000).toISOString();
const cases=[
 {source:'royal_air_maroc',registry:'royal_air_maroc',airline:'AT',label:'Royal Air Maroc',factory:createRoyalAirMarocCachedSource,origin:'CMN',destination:'BCN',amount:159.8,currency:'EUR',page:'https://www.royalairmaroc.com/fr/vols-au-depart-de-casablanca'},
 {source:'china_airlines',registry:'china_airlines',airline:'CI',label:'China Airlines',factory:createChinaAirlinesCachedSource,origin:'TPE',destination:'NRT',amount:16274,currency:'TWD',page:'https://flights.china-airlines.com/en-tw/flights-from-taipei-to-tokyo'},
 {source:'korean_air',registry:'korean',airline:'KE',label:'Korean Air',factory:createKoreanCachedSource,origin:'LAX',destination:'ICN',amount:1865.19,currency:'USD',page:'https://www.koreanair.com/flights/en-us/flights-from-los-angeles-to-seoul'},
] as const;
const leg={departTime:null,arriveTime:null,stops:null,durationMin:null,airlines:[]};
function offer(c:typeof cases[number]):Offer{return {
 origin:c.origin,destination:c.destination,departDate:'2027-06-04',returnDate:'2027-06-11',priceAmount:c.amount,priceCurrency:c.currency,
 source:c.source,ticketStructure:'roundtrip',outbound:{...leg},inbound:{...leg},includes:{},deeplink:c.page,verifyLink:null,checkedAt,
 extrasAmountIls:0,totalIls:null,tags:['published_advertisement','operator_unknown'],
};}
describe.each(cases)('$source shared contracts',c=>{
 it('recognizes the quote source and preserves the stable registry identity without claiming live inventory',()=>{
  expect(QUOTE_SOURCE_NAMES).toContain(c.source);expect(isQuoteSource(c.source)).toBe(true);expect(isPublishedSource(c.source)).toBe(true);
  expect(UNSTATED_AGE_QUOTE_SOURCES).toContain(c.source);
  const registry=SOURCE_REGISTRY.find(row=>row.id===c.registry)!;
  expect(registry.name).toBe(c.label);expect(registry.status).toBe('manual-link');
  expect(registry.capabilities).toMatchObject({cachedPrice:true,livePrice:false,bookingLink:true,directBooking:true,combinations:false});
  expect(describeQuoteError(c.factory(now),new Error('private details'))).toBe(`${c.label}: unexpected error`);
  expect(EXTERNAL_PUBLISHED_PAGES).toContainEqual(expect.objectContaining({airline:c.airline,origin:c.origin,destination:c.destination,sourceUrl:c.page}));
 });
 it('round-trips native price and original capture through D1 without inventing an operator',async()=>{
  const repo=createRepo(createTestD1());await repo.savePrices([offer(c)]);
  const rows=await repo.loadRecentOffers(c.origin,c.destination,'2027-06-04','2027-06-11',1,now,[c.source],true);
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({source:c.source,priceAmount:c.amount,priceCurrency:c.currency,checkedAt,totalIls:null,outbound:{airlines:[]},inbound:{airlines:[]}});
 });
 it('keeps advertised fare age unknown and separates original vendor age from capture time',()=>{
  expect(fareFreshness(offer(c),now)).toMatchObject({fareAgeBasis:'unknown',freshness:'unknown',fareFoundAt:null,ageLabelKey:'quote_unknown_age',scanAgeMinutes:2});
  const freshness=fareFreshness({...offer(c),upstreamPriceAge:{value:1,unit:'days'}},now);
  expect(freshness.fareAgeBasis).toBe('unknown');expect(freshness.ageLabelHe).toContain('יום אחד');expect(freshness.ageLabelHe).toContain('אינו אימות מחיר');
 });
 it('caches only the observed exact page and never revives a fare beyond its original capture age',async()=>{
  const rows=new Map<string,Response>();const db={match:async(req:Request)=>rows.get(req.url)?.clone(),put:async(req:Request,response:Response)=>{rows.set(req.url,response.clone());}};
  const writer=createPublicFareCache(db as unknown as Cache,now,BACKGROUND_FARE_TTL_MS);
  const data=[{airline:c.airline,origin:c.origin,destination:c.destination,departDate:'2027-06-04',returnDate:'2027-06-11',amount:c.amount,currency:c.currency,structure:'roundtrip',sourceUrl:c.page,pricing:'published_advertisement',checkedAt}];
  await writer.put(c.page,data);
  expect(await writer.get(c.page)).toEqual({fares:data,expires:Date.parse(checkedAt)+600000});
  const q={origin:c.origin,destination:c.destination,departDate:'2027-06-04',returnDate:'2027-06-11',party:{adults:1,children:0,infants:0}};
  expect(await c.factory(now,writer).quote(q)).toHaveLength(1);
  for(const link of [c.page+'?tracking=1',c.page+'#top',c.page.replace('https://','https://user:pass@'),new URL('/en/flights-from-unobserved-to-unobserved',c.page).href]){
   expect(()=>cacheRequest(link)).toThrow();await writer.put(link,data);
  }
  expect(rows.size).toBe(1);
  const originalFareExpiry=new Date(Date.parse(checkedAt)+600000);
  const reader=createPublicFareCache(db as unknown as Cache,originalFareExpiry);
  expect(await reader.get(c.page)).toBeNull();
  expect(await c.factory(originalFareExpiry,reader).quote(q)).toEqual([]);
  expect(await createPublicFareCache(db as unknown as Cache,new Date(now.getTime()+600000)).get(c.page)).toBeNull();
 });
});
it('keeps the Korean registry id stable and rejects its registry id as a fare source',async()=>{
 expect(SOURCE_REGISTRY.filter(row=>row.name==='Korean Air').map(row=>row.id)).toEqual(['korean']);
 expect(isQuoteSource('korean' as SourceName)).toBe(false);
 const repo=createRepo(createTestD1());await repo.savePrices([{...offer(cases[2]),source:'korean' as SourceName}]);
 expect(await repo.loadRecentOffers('LAX','ICN','2027-06-04','2027-06-11',1,now)).toEqual([]);
});
it('retains both observed Taipei/Tokyo airport identities without manufacturing city-code fares',()=>{
 const pairs=EXTERNAL_PUBLISHED_PAGES.filter(page=>page.airline==='CI').map(page=>[page.origin,page.destination]);
 expect(pairs).toEqual([['TSA','HND'],['TPE','NRT']]);expect(pairs.flat()).not.toContain('TYO');
});
