import {expect, it, vi} from 'vitest';
import type {FlydubaiAdvertisement} from '../../collector/flydubai-fares.mjs';
import type {PublicFareCache} from '../src/public-fare-cache';
import {createFlydubaiCachedSource} from '../src/sources/flydubai-cached';

const outPage = 'https://www.flydubai.com/en-ae/flights-to-tbilisi/';
const backPage = 'https://www.flydubai.com/en-ae/flights-from-tbilisi/';
vi.mock('../src/flydubai-published-catalog.json', () => ({default: [
  {origin: 'DXB', destination: 'TBS', sourceUrl: 'https://www.flydubai.com/en-ae/flights-to-tbilisi/'},
  {origin: 'TBS', destination: 'DXB', sourceUrl: 'https://www.flydubai.com/en-ae/flights-from-tbilisi/'},
]}));
const now = new Date('2026-10-08T10:00:00Z');
const q = {origin: 'DXB', destination: 'TBS', departDate: '2026-11-01', returnDate: '2026-11-05',
  party: {adults: 1, children: 0, infants: 0}};
const fare: FlydubaiAdvertisement = {origin: 'DXB', destination: 'TBS', departDate: q.departDate,
  returnDate: q.returnDate, amount: 1732, currency: 'AED', structure: 'roundtrip',
  checkedAt: '2026-10-08T09:58:00Z', sourceUrl: outPage, pricing: 'published_advertisement'};
function makeCache(rows: FlydubaiAdvertisement[], expires = now.getTime() + 600_000) {
  const get = vi.fn(async (page: string) => ({fares: rows.filter(f => f.sourceUrl === page), expires}));
  return {cache: {get: get as PublicFareCache['get'], put: vi.fn()} satisfies PublicFareCache, get};
}

it('reads exact round trips without upstream requests or invented flight details', async () => {
  const {cache, get} = makeCache([fare, fare]);
  const source = createFlydubaiCachedSource(now, cache);
  const offers = await source.quote(q);
  expect(offers).toHaveLength(1);
  expect(offers[0]).toMatchObject({source: 'flydubai', priceAmount: 1732, priceCurrency: 'AED',
    ticketStructure: 'roundtrip', checkedAt: fare.checkedAt, deeplink: outPage, verifyLink: null,
    outbound: {airlines: [], stops: null, departTime: null, arriveTime: null, durationMin: null},
    inbound: {airlines: [], stops: null, departTime: null, arriveTime: null, durationMin: null},
    includes: {}, totalIls: null, tags: ['published_advertisement', 'operator_unknown', 'cabin_unknown']});
  expect(offers[0]?.returnDeeplink).toBeUndefined();
  expect(source.callCount()).toBe(0); expect(source.nextQuoteRequests!()).toBe(0);
  expect(source.oneWays).toBeUndefined();
  await source.quote(q);
  expect(get).toHaveBeenCalledTimes(2);
  expect(await source.quote({...q, returnDate: '2026-11-06'})).toEqual([]);
  expect(await source.quote({...q, departDate: '2026-11-02'})).toEqual([]);
});

it('combines only two explicit same-currency one ways and preserves both links and oldest capture', async () => {
  const out = {...fare, structure: 'oneway' as const, returnDate: null, amount: 840};
  const back = {...out, origin: 'TBS', destination: 'DXB', departDate: q.returnDate, amount: 492.12,
    sourceUrl: backPage, checkedAt: '2026-10-08T09:57:00Z'};
  const source = createFlydubaiCachedSource(now, makeCache([out, back]).cache);
  expect(await source.quote(q)).toMatchObject([{ticketStructure: 'split', priceAmount: 1332.12,
    priceCurrency: 'AED', deeplink: outPage, returnDeeplink: backPage, checkedAt: back.checkedAt}]);
  expect(await createFlydubaiCachedSource(now, makeCache([out]).cache).quote(q)).toEqual([]);
  expect(await createFlydubaiCachedSource(now, makeCache([out, {...back, currency: 'USD'}]).cache).quote(q)).toEqual([]);
  expect(await createFlydubaiCachedSource(now, makeCache([out, {...back, departDate: '2026-11-06'}]).cache).quote(q)).toEqual([]);
});

it('rejects unsupported parties, malformed query dates and unrelated routes before reading storage', async () => {
  const {cache, get} = makeCache([fare]);
  const source = createFlydubaiCachedSource(now, cache);
  for (const party of [{adults: 2, children: 0, infants: 0}, {adults: 1, children: 1, infants: 0},
    {adults: 1, children: 0, infants: 1}]) expect(await source.quote({...q, party})).toEqual([]);
  expect(await source.quote({...q, adults: 2})).toEqual([]);
  expect(await source.quote({...q, returnDate: q.departDate})).toEqual([]);
  expect(await source.quote({...q, departDate: '2026-02-30'})).toEqual([]);
  expect(await source.quote({...q, origin: 'TLV'})).toEqual([]);
  expect(get).not.toHaveBeenCalled();
});

it('rejects expired, future, unapproved, malformed and non-advertisement cached rows', async () => {
  const bad = [{...fare, checkedAt: '2026-10-08T09:50:00Z'}, {...fare, checkedAt: '2026-10-08T10:00:01Z'},
    {...fare, checkedAt: 'invalid'}, {...fare, amount: -1}, {...fare, currency: 'aed'},
    {...fare, returnDate: q.departDate}, {...fare, departDate: '2026-02-30'},
    {...fare, origin: 'TLV'}, {...fare, pricing: 'headline'}, {...fare, structure: 'oneway'}] as FlydubaiAdvertisement[];
  expect(await createFlydubaiCachedSource(now, makeCache(bad).cache).quote(q)).toEqual([]);
  expect(await createFlydubaiCachedSource(now, makeCache([fare], now.getTime()).cache).quote(q)).toEqual([]);
  expect(await createFlydubaiCachedSource(now).quote(q)).toEqual([]);
  expect(await createFlydubaiCachedSource(now, {get: vi.fn().mockRejectedValue(Error('unavailable')), put: vi.fn()}).quote(q)).toEqual([]);
});

it('validates stored offers against current explicit snapshots and invalidates removed or changed prices', async () => {
  const source = createFlydubaiCachedSource(now, makeCache([fare]).cache);
  const offer = (await source.quote(q))[0]!;
  expect(await source.validatesStoredOffer!(offer)).toBe(true);
  expect(await source.validatesStoredOffer!({...offer, priceAmount: 1})).toBe(false);
  expect(await source.validatesStoredOffer!({...offer, ticketStructure: 'split'})).toBe(false);
  expect(await source.validatesStoredOffer!({...offer, deeplink: 'https://example.com'})).toBe(false);
  expect(await createFlydubaiCachedSource(now, makeCache([]).cache).validatesStoredOffer!(offer)).toBe(false);
  expect(await createFlydubaiCachedSource(now, makeCache([{...fare, amount: 1800}]).cache).validatesStoredOffer!(offer)).toBe(false);
});

it('returns at most twenty offers in native price order within each currency', async () => {
  const rows = Array.from({length: 25}, (_, i) => ({...fare, amount: 1000 + 25 - i}));
  const offers = await createFlydubaiCachedSource(now, makeCache(rows).cache).quote(q);
  expect(offers).toHaveLength(20);
  expect(offers.map(f => f.priceAmount)).toEqual(Array.from({length: 20}, (_, i) => 1001 + i));
});
