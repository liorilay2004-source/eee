import {it,expect,vi} from 'vitest';
import {parseAustrianAdvertisements} from '../src/austrian-advertisements';
import {createAustrianCachedSource} from '../src/sources/austrian-cached';
import type {PublicFareCache} from '../src/public-fare-cache';
const now=new Date('2026-10-08T04:15:00Z');
const fares=parseAustrianAdvertisements([{text:'from 252 EUR',url:'/aircore/deeplink/redirect/en/at/VIE/TLV/05.06.2027/19.06.2027/RT'}],now);
const q={origin:'VIE',destination:'TLV',departDate:'2027-06-05',returnDate:'2027-06-19',party:{adults:1,children:0,infants:0}};
const cache=(rows:unknown[])=>({get:async()=>({fares:rows,expires:now.getTime()+1000}),put:async()=>{}}) as PublicFareCache;
it('returns original EUR only for the observed trip without airline calls',async()=>{
 const source=createAustrianCachedSource(now,cache(fares));
 expect(await source.quote(q)).toMatchObject([{source:'austrian',priceAmount:252,priceCurrency:'EUR',outbound:{airlines:[],stops:null}}]);
 expect(await source.quote({...q,returnDate:'2027-06-20'})).toEqual([]);
 expect(await source.quote({...q,origin:'TLV',destination:'VIE'})).toEqual([]);
 expect(await source.quote({...q,party:{...q.party,adults:2}})).toEqual([]);
 expect(source.callCount()).toBe(0);
});
it('rejects malformed prices, stale timestamps and foreign links',async()=>{
 for(const change of [{amount:'252'},{currency:'CHF'},{amount:252.5},{checkedAt:'2026-10-01T00:00:00Z'},{bookingUrl:'https://evil.example/'}])
 expect(await createAustrianCachedSource(now,cache([{...fares[0],...change}])).quote(q)).toEqual([]);
});
it('memoizes the monthly primary-key storage fallback',async()=>{
 const first=vi.fn(async()=>({fares_json:JSON.stringify(fares),checked_at:now.toISOString()}));
 const bind=vi.fn(()=>({first}));const db={prepare:()=>({bind})} as unknown as D1Database;
 const source=createAustrianCachedSource(now,undefined,db);
 expect(await source.quote(q)).toHaveLength(1);
 expect(await source.quote({...q,returnDate:'2027-06-20'})).toEqual([]);
 expect(bind).toHaveBeenCalledWith('austrian','VIE','TLV','2027-06');expect(first).toHaveBeenCalledTimes(1);
});