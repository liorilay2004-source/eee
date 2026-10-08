import {it,expect,vi} from 'vitest';
import {createHawaiianCachedSource} from '../src/sources/hawaiian-cached';
const now=new Date('2026-10-08T10:00:00Z'),q={origin:'HNL',destination:'LAX',departDate:'2027-01-27',returnDate:'2027-02-03',party:{adults:1,children:0,infants:0}};
const base={origin:'HNL',destination:'LAX',departDate:q.departDate,returnDate:q.returnDate,amount:340,currency:'USD',structure:'roundtrip',fetchedAt:now.toISOString(),operator:null,checkoutVerified:false,pricing:'published_advertisement'};
it('reads approved shared snapshots without inventing operator or flight details',async()=>{
 const get=vi.fn(async(page:string)=>({fares:[{...base,sourceUrl:page}],expires:now.getTime()+600000}));
 const source=createHawaiianCachedSource(now,{get:get as any,put:vi.fn()});
 const offers=await source.quote(q);
 expect(offers.length).toBeGreaterThan(0);
 expect(offers[0]).toMatchObject({source:'hawaiian',priceAmount:340,outbound:{airlines:[],stops:null,departTime:null},tags:['published_advertisement','operator_unknown']});
 expect(source.callCount()).toBe(0);expect(source.nextQuoteRequests!()).toBe(0);
 expect(await source.quote({...q,returnDate:'2027-02-04'})).toEqual([]);
 expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
});
it('rejects expired observations and tolerates missing shared storage',async()=>{
 const get=async(page:string)=>({fares:[{...base,sourceUrl:page}],expires:now.getTime()+1200000});
 expect(await createHawaiianCachedSource(new Date(now.getTime()+600000),{get:get as any,put:vi.fn()}).quote(q)).toEqual([]);
 expect(await createHawaiianCachedSource(now,{get:vi.fn().mockRejectedValue(new Error('unavailable')),put:vi.fn()}).quote(q)).toEqual([]);
});
