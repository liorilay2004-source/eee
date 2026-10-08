import { it, expect, vi } from 'vitest';
import { createEvaCachedSource } from '../src/sources/eva-cached';
import type { PublicFareCache } from '../src/public-fare-cache';
// A test-only reverse pair exercises explicit two-ticket pairing; production catalogs remain observed-only.
vi.mock('../src/eva-published-catalog.json', async (importOriginal) => {
  const original = await importOriginal<{default: Array<{airline:string;origin:string;destination:string;sourceUrl:string;collector:string}>}>();
  const page = original.default.find(row => row.sourceUrl === 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo' && row.origin === 'TPE' && row.destination === 'NRT')!;
  return { default: [...original.default, { ...page, origin: 'NRT', destination: 'TPE' }] };
});
const now = new Date('2026-10-08T12:00:00.000Z');
const q = { origin: 'TPE', destination: 'NRT', departDate: '2027-06-13', returnDate: '2027-06-17', party: {adults:1,children:0,infants:0} };
const page = 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo';
const base = {airline:'BR',origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,
  amount:100,currency:'TWD',structure:'roundtrip',sourceUrl:page,checkedAt:now.toISOString(),pricing:'published_advertisement',
  upstreamPriceAge:{value:1,unit:'days'}};
const cache = (fares: object[], expires = now.getTime()+600_000) => ({get:vi.fn(async (url:string) => url === page ? {fares,expires} : null),put:vi.fn()}) as unknown as PublicFareCache;

it('reads native currency and exact dates without inventing an operator, schedule, or upstream calls', async () => {
  const store = cache([base]); const source = createEvaCachedSource(now,store);
  const offers = await source.quote(q);
  expect(offers).toHaveLength(1); expect(offers[0]).toMatchObject({source:'eva',priceAmount:100,priceCurrency:'TWD',
    ticketStructure:'roundtrip',checkedAt:now.toISOString(),upstreamPriceAge:{value:1,unit:'days'},
    outbound:{airlines:[],departTime:null,arriveTime:null,durationMin:null,stops:null},inbound:{airlines:[]},
    totalIls:null,tags:['published_advertisement','operator_unknown']});
  expect(source.callCount()).toBe(0); expect(source.nextQuoteRequests!()).toBe(0); expect(source.oneWays).toBeUndefined();
  const firstReadCount = vi.mocked(store.get).mock.calls.length;
  await source.quote(q); expect(store.get).toHaveBeenCalledTimes(firstReadCount);
  expect(await source.quote({...q,returnDate:'2027-06-18'})).toEqual([]);
  expect(await source.quote({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
  expect(await source.quote({...q,party:{adults:1,children:1,infants:0}})).toEqual([]);
  expect(await source.quote({...q,adults:2})).toEqual([]);
  expect(await source.validatesStoredOffer!(offers[0]!)).toBe(true);
  expect(await source.validatesStoredOffer!({...offers[0]!,priceAmount:1})).toBe(false);
  expect(await source.validatesStoredOffer!({...offers[0]!,outbound:{...offers[0]!.outbound,airlines:['BR']}})).toBe(false);
});
it('pairs only two explicit one-way prices in the same currency and preserves the older original capture', async () => {
  const outward={...base,structure:'oneway',returnDate:null,amount:30};
  const inward={...outward,origin:q.destination,destination:q.origin,departDate:q.returnDate,amount:40,
    checkedAt:new Date(now.getTime()-120000).toISOString()};
  const offers=await createEvaCachedSource(now,cache([outward,inward])).quote(q);
  expect(offers).toHaveLength(1);expect(offers[0]).toMatchObject({priceAmount:70,priceCurrency:'TWD',ticketStructure:'split',
    checkedAt:inward.checkedAt,deeplink:page,returnDeeplink:page,outbound:{airlines:[]},inbound:{airlines:[]}});
  expect(offers[0]!.upstreamPriceAge).toBeUndefined();
  expect(await createEvaCachedSource(now,cache([outward])).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now,cache([outward,{...inward,currency:'EUR'}])).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now,cache([outward,{...inward,departDate:'2027-06-18'}])).quote(q)).toEqual([]);
});
it('rejects expired, future, malformed, or foreign snapshots and tolerates missing storage', async () => {
  for (const patch of [{checkedAt:new Date(now.getTime()-600000).toISOString()}, {checkedAt:new Date(now.getTime()+1).toISOString()},
    {sourceUrl:'https://wrong.example/'}, {airline:'XX'}, {amount:NaN}, {currency:'USD?'}]) {
    expect(await createEvaCachedSource(now,cache([{...base,...patch}])).quote(q)).toEqual([]);
  }
  expect(await createEvaCachedSource(now,cache([base],now.getTime())).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now,cache([base],NaN)).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now,{get:vi.fn().mockRejectedValue(new Error('unavailable')),put:vi.fn()}).quote(q)).toEqual([]);
  expect(await createEvaCachedSource(now,cache([base])).quote({...q,departDate:'2027-02-30'})).toEqual([]);
});
