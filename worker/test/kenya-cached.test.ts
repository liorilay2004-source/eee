import {it,expect,vi} from 'vitest';import {createKenyaCachedSource} from '../src/sources/kenya-cached';
const now=new Date('2026-10-08T10:00:00Z'),q={origin:'LHR',destination:'NBO',departDate:'2026-12-04',returnDate:'2026-12-06',party:{adults:1,children:0,infants:0}};
const fare={airline:'KQ',origin:'LHR',destination:'NBO',departDate:q.departDate,returnDate:q.returnDate,amount:584.99,currency:'GBP',structure:'roundtrip',checkedAt:now.toISOString(),pricing:'published_advertisement'};
it('matches exact dates in original GBP without upstream calls',async()=>{
 const get=vi.fn(async(page:string)=>({fares:[{...fare,sourceUrl:page}],expires:now.getTime()+600000}));const source=createKenyaCachedSource(now,{get:get as any,put:vi.fn()});
 const offers=await source.quote(q);expect(offers.length).toBeGreaterThan(0);expect(offers[0]).toMatchObject({source:'kenya',priceAmount:584.99,priceCurrency:'GBP',outbound:{stops:null,departTime:null}});expect(source.callCount()).toBe(0);expect(source.nextQuoteRequests!()).toBe(0);
 expect(await source.quote({...q,returnDate:'2026-12-07'})).toEqual([]);expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
 const offer=offers[0]!;expect(await source.validatesStoredOffer!(offer)).toBe(true);expect(await source.validatesStoredOffer!({...offer,priceAmount:1})).toBe(false);
});
it('rejects expired observations and missing storage',async()=>{
 const get=async(page:string)=>({fares:[{...fare,sourceUrl:page}],expires:now.getTime()+1200000});expect(await createKenyaCachedSource(new Date(now.getTime()+600000),{get:get as any,put:vi.fn()}).quote(q)).toEqual([]);
 expect(await createKenyaCachedSource(now,{get:vi.fn().mockRejectedValue(new Error('unavailable')),put:vi.fn()}).quote(q)).toEqual([]);
});
