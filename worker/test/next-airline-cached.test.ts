import {describe,it,expect,vi} from 'vitest';
import {createRoyalAirMarocCachedSource} from '../src/sources/royal-air-maroc-cached';
import {createChinaAirlinesCachedSource} from '../src/sources/china-airlines-cached';
import {createKoreanCachedSource} from '../src/sources/korean-cached';
import type {PublicFareCache} from '../src/public-fare-cache';
// These reverse pairs are test-only. Production catalogs contain only actual observed airport/page identities.
vi.mock('../src/royal-air-maroc-published-catalog.json',async importOriginal=>{
 const original=await importOriginal<{default:Array<{origin:string;destination:string}>}>();
 const forward=original.default.find(row=>row.origin==='CMN'&&row.destination==='BCN')!;
 return {default:[...original.default,{...forward,origin:'BCN',destination:'CMN'}]};
});
vi.mock('../src/china-airlines-published-catalog.json',async importOriginal=>{
 const original=await importOriginal<{default:Array<{origin:string;destination:string}>}>();
 const forward=original.default.find(row=>row.origin==='TPE'&&row.destination==='NRT')!;
 return {default:[...original.default,{...forward,origin:'NRT',destination:'TPE'}]};
});
vi.mock('../src/korean-published-catalog.json',async importOriginal=>{
 const original=await importOriginal<{default:Array<{origin:string;destination:string}>}>();
 const forward=original.default.find(row=>row.origin==='LAX'&&row.destination==='ICN')!;
 return {default:[...original.default,{...forward,origin:'ICN',destination:'LAX'}]};
});
const now=new Date('2026-10-08T12:30:00.000Z'),checkedAt=new Date(now.getTime()-120000).toISOString();
const providers=[
 {name:'royal_air_maroc',code:'AT',factory:createRoyalAirMarocCachedSource,origin:'CMN',destination:'BCN',depart:'2026-12-05',back:'2026-12-07',amount:159.8,currency:'EUR',page:'https://www.royalairmaroc.com/fr/vols-au-depart-de-casablanca'},
 {name:'china_airlines',code:'CI',factory:createChinaAirlinesCachedSource,origin:'TPE',destination:'NRT',depart:'2027-06-04',back:'2027-06-11',amount:16274,currency:'TWD',page:'https://flights.china-airlines.com/en-tw/flights-from-taipei-to-tokyo'},
 {name:'korean_air',code:'KE',factory:createKoreanCachedSource,origin:'LAX',destination:'ICN',depart:'2027-08-17',back:'2027-08-24',amount:1865.19,currency:'USD',page:'https://www.koreanair.com/flights/en-us/flights-from-los-angeles-to-seoul'},
];
describe.each(providers)('$name cached public observations',provider=>{
 const q={origin:provider.origin,destination:provider.destination,departDate:provider.depart,returnDate:provider.back,party:{adults:1,children:0,infants:0}};
 const base={airline:provider.code,origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,
  amount:provider.amount,currency:provider.currency,structure:'roundtrip',sourceUrl:provider.page,checkedAt,pricing:'published_advertisement',upstreamPriceAge:{value:1,unit:'days'}};
 const cache=(fares:object[],expires=Date.parse(checkedAt)+600000)=>({get:vi.fn(async (page:string)=>page===provider.page?{fares,expires}:null),put:vi.fn()}) as unknown as PublicFareCache;
 it('returns exact native prices with original capture/age, empty operator, coalesced cache reads and zero upstream calls',async()=>{
  const store=cache([base]),source=provider.factory(now,store),offers=await source.quote(q);
  expect(offers).toHaveLength(1);expect(offers[0]).toMatchObject({source:provider.name,priceAmount:provider.amount,priceCurrency:provider.currency,
   checkedAt,upstreamPriceAge:{value:1,unit:'days'},ticketStructure:'roundtrip',totalIls:null,
   outbound:{airlines:[],departTime:null,arriveTime:null,durationMin:null,stops:null},inbound:{airlines:[]},tags:['published_advertisement','operator_unknown']});
  expect(source.cacheOnly).toBe(true);expect(source.callCount()).toBe(0);expect(source.nextQuoteRequests!()).toBe(0);expect(source.oneWays).toBeUndefined();
  const first=vi.mocked(store.get).mock.calls.length;await source.quote(q);expect(store.get).toHaveBeenCalledTimes(first);
  expect(await source.validatesStoredOffer!(offers[0]!)).toBe(true);
  expect(await source.validatesStoredOffer!({...offers[0]!,priceAmount:1})).toBe(false);
  expect(await source.validatesStoredOffer!({...offers[0]!,outbound:{...offers[0]!.outbound,airlines:[provider.code]}})).toBe(false);
  expect(await source.quote({...q,returnDate:'2027-09-01'})).toEqual([]);
  for(const party of [{adults:2,children:0,infants:0},{adults:1,children:1,infants:0},{adults:1,children:0,infants:1}])expect(await source.quote({...q,party})).toEqual([]);
  expect(await source.quote({...q,adults:2})).toEqual([]);
 });
 it('pairs only two explicit same-currency directions with the older capture and no invented operator',async()=>{
  const outward={...base,structure:'oneway',returnDate:null,amount:30};
  const inward={...outward,origin:q.destination,destination:q.origin,departDate:q.returnDate,amount:40,checkedAt:new Date(now.getTime()-180000).toISOString()};
  const [offer]=await provider.factory(now,cache([outward,inward])).quote(q);
  expect(offer).toMatchObject({priceAmount:70,priceCurrency:provider.currency,ticketStructure:'split',checkedAt:inward.checkedAt,
   deeplink:provider.page,returnDeeplink:provider.page,outbound:{airlines:[]},inbound:{airlines:[]}});expect(offer!.upstreamPriceAge).toBeUndefined();
  expect(await provider.factory(now,cache([outward])).quote(q)).toEqual([]);
  expect(await provider.factory(now,cache([outward,{...inward,currency:provider.currency==='EUR'?'USD':'EUR'}])).quote(q)).toEqual([]);
 });
 it('rejects expired/future/malformed/foreign data and tolerates missing storage',async()=>{
  for(const patch of [{checkedAt:new Date(now.getTime()-600000).toISOString()},{checkedAt:new Date(now.getTime()+1).toISOString()},
   {airline:'XX'},{sourceUrl:'https://wrong.example/'},{origin:'TYO'},{destination:'TYO'},{amount:NaN},{currency:'USD?'},{returnDate:q.departDate}]){
   expect(await provider.factory(now,cache([{...base,...patch}])).quote(q)).toEqual([]);
  }
  expect(await provider.factory(now,cache([base],now.getTime())).quote(q)).toEqual([]);
  expect(await provider.factory(now,cache([base],NaN)).quote(q)).toEqual([]);
  expect(await provider.factory(now).quote(q)).toEqual([]);
  expect(await provider.factory(now,{get:vi.fn().mockRejectedValue(Error('unavailable')),put:vi.fn()}).quote(q)).toEqual([]);
  expect(await provider.factory(now,cache([base])).quote({...q,departDate:'2027-02-30'})).toEqual([]);
 });
});
