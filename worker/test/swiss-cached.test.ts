import {it,expect,vi} from 'vitest';
import {parseSwissAdvertisements} from '../src/swiss-advertisements';
import {createSwissCachedSource} from '../src/sources/swiss-cached';
import type {PublicFareCache} from '../src/public-fare-cache';
const now=new Date('2026-10-08T04:15:00Z');
const fares=parseSwissAdvertisements([{text:'from 358 CHF',url:'/aircore/deeplink/redirect/en/ch/ZRH/TLV/01.06.2027/15.06.2027/RT'}],now);
const q={origin:'ZRH',destination:'TLV',departDate:'2027-06-01',returnDate:'2027-06-15',party:{adults:1,children:0,infants:0}};
const cache=(rows:unknown[])=>({get:async()=>({fares:rows,expires:now.getTime()+1000}),put:async()=>{}}) as PublicFareCache;
it('returns original CHF only for the observed trip without airline calls',async()=>{
 const source=createSwissCachedSource(now,cache(fares));
 expect(await source.quote(q)).toMatchObject([{source:'swiss',priceAmount:358,priceCurrency:'CHF',outbound:{airlines:[],stops:null}}]);
 expect(await source.quote({...q,returnDate:'2027-06-16'})).toEqual([]);
 expect(await source.quote({...q,origin:'TLV',destination:'ZRH'})).toEqual([]);
 expect(await source.quote({...q,party:{...q.party,adults:2}})).toEqual([]);
 expect(source.callCount()).toBe(0);
});
it('rejects malformed prices, stale timestamps and foreign links',async()=>{
 for(const change of [{amount:'358'},{currency:'EUR'},{amount:358.5},{checkedAt:'2026-10-01T00:00:00Z'},{bookingUrl:'https://evil.example/'}])
 expect(await createSwissCachedSource(now,cache([{...fares[0],...change}])).quote(q)).toEqual([]);
});
it('memoizes the monthly primary-key storage fallback',async()=>{
 const first=vi.fn(async()=>({fares_json:JSON.stringify(fares),checked_at:now.toISOString()}));
 const bind=vi.fn(()=>({first}));const db={prepare:()=>({bind})} as unknown as D1Database;
 const source=createSwissCachedSource(now,undefined,db);
 expect(await source.quote(q)).toHaveLength(1);
 expect(await source.quote({...q,returnDate:'2027-06-16'})).toEqual([]);
 expect(bind).toHaveBeenCalledWith('swiss','ZRH','TLV','2027-06');expect(first).toHaveBeenCalledTimes(1);
});