import { expect, it, vi } from 'vitest';
import { createRepo } from '../src/db';
import { computeSearchKey, runSearch } from '../src/pipeline';
import { createEvaCachedSource } from '../src/sources/eva-cached';
import type { FareQuoteSource } from '../src/quotes';
import type { PublicFareCache } from '../src/public-fare-cache';
import type { Offer, SearchRequest, TravelpayoutsClient } from '../src/types';
import { createTestD1 } from './helpers/d1';

const now = new Date('2026-10-08T12:00:00.000Z');
const page = 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo';
const request: SearchRequest = { origin: 'TPE', destination: 'NRT', windowStart: '2027-06-13', windowEnd: '2027-06-17',
  stayMin: 4, stayMax: 4, adults: 1, children: 0, infants: 0, cabin: 'economy', checkedBag: false,
  outHours: [12,17], retHours: [12,17], maxStops: null, nearbyAirports: false };
const leg = { departTime: '14:00', arriveTime: null, durationMin: 180, stops: 0, airlines: ['BR'] };
const tpOffer: Offer = { origin: request.origin, destination: request.destination, departDate: request.windowStart,
  returnDate: request.windowEnd, source: 'travelpayouts', priceAmount: 18_000, priceCurrency: 'TWD', ticketStructure: 'roundtrip',
  outbound: leg, inbound: leg, includes: {}, deeplink: 'https://www.aviasales.com/', verifyLink: null,
  checkedAt: new Date(now.getTime()-300_000).toISOString(), extrasAmountIls: 0, totalIls: null, tags: [] };
const observation = (amount: number, checkedAt: string) => ({ airline: 'BR', origin: request.origin, destination: request.destination,
  departDate: request.windowStart, returnDate: request.windowEnd, amount, currency: 'TWD', structure: 'roundtrip',
  sourceUrl: page, checkedAt, pricing: 'published_advertisement', upstreamPriceAge: {value:7,unit:'hours'} });

async function setupSnapshot(currentAmount: number, currentAt = new Date(now.getTime()-90_000).toISOString(), retainOld = false) {
  const repo = createRepo(createTestD1());
  const oldAt = new Date(now.getTime()-120_000).toISOString();
  const oldRow = observation(17_000, oldAt);
  let rows = [oldRow];
  const cache = { get: vi.fn(async (url: string) => url === page ? {fares:rows,expires:Math.max(...rows.map(row=>Date.parse(row.checkedAt)))+600_000} : null),
    put: vi.fn() } as unknown as PublicFareCache;
  const query = { origin: request.origin, destination: request.destination, departDate: request.windowStart,
    returnDate: request.windowEnd, party: {adults:1,children:0,infants:0} };
  const [oldOffer] = await createEvaCachedSource(now, cache).quote(query);
  await repo.putCachedOffers(await computeSearchKey(request), [tpOffer], new Date(now.getTime()-300_000),
    {oneWayPairs:[],notes:[],quotes:[oldOffer!]});
  if (retainOld) await repo.savePrices([oldOffer!]);
  rows = [...(retainOld ? [oldRow] : []), observation(currentAmount, currentAt)];
  const source = createEvaCachedSource(now, cache);
  const tp = {configured:true,callCount:()=>0,roundTrips:vi.fn().mockRejectedValue(new Error('unexpected airline request')),
    oneWays:vi.fn().mockRejectedValue(new Error('unexpected airline request'))} as TravelpayoutsClient;
  const vendorQuote = vi.fn().mockRejectedValue(new Error('unexpected paid vendor request'));
  const vendor: FareQuoteSource = { name:'searchapi',configured:true,quota:{period:'monthly',cap:100,allowance:100},
    callCount:()=>0,nextQuoteRequests:()=>0,quote:vendorQuote };
  return {repo,cache,source,tp,vendor,vendorQuote,currentAt};
}

it('a nonempty Travelpayouts cache hit replaces changed public prices while preserving TP candidates and original capture', async () => {
  const context = await setupSnapshot(13_000);
  const result = await runSearch({repo:context.repo,tp:context.tp,now,
    fx:{date:'2026-10-08',source:'test',ratesToIls:{ILS:1,USD:3,TWD:0.1}},quoteSources:[context.source,context.vendor]},request);
  expect(result.meta.fromCache).toBe(true);
  const current = result.cards.find(card=>card.offer.source==='eva')!;
  expect(current.offer).toMatchObject({priceAmount:13_000,priceCurrency:'TWD',checkedAt:context.currentAt,
    upstreamPriceAge:{value:7,unit:'hours'},outbound:{airlines:[]},inbound:{airlines:[]}});
  expect(result.cards.some(card=>card.offer.source==='travelpayouts')).toBe(true);
  expect(result.cards.some(card=>card.offer.source==='eva'&&card.offer.priceAmount===17_000)).toBe(false);
  expect(context.tp.roundTrips).not.toHaveBeenCalled();expect(context.tp.oneWays).not.toHaveBeenCalled();
  expect(context.vendorQuote).not.toHaveBeenCalled();expect(context.source.callCount()).toBe(0);
  const hit = await context.repo.getCachedOffers(await computeSearchKey(request),6,now);
  expect(hit!.createdAt).toBe(tpOffer.checkedAt);
});

it('an expired public snapshot is not revived on a nonempty TP cache hit', async () => {
  const context = await setupSnapshot(13_000,new Date(now.getTime()-600_000).toISOString());
  const result = await runSearch({repo:context.repo,tp:context.tp,now,
    fx:{date:'2026-10-08',source:'test',ratesToIls:{ILS:1,USD:3,TWD:0.1}},quoteSources:[context.source,context.vendor]},request);
  expect(result.meta.fromCache).toBe(true);expect(result.cards.every(card=>card.offer.source!=='eva')).toBe(true);
  expect(result.cards.some(card=>card.offer.source==='travelpayouts')).toBe(true);
  expect(context.tp.roundTrips).not.toHaveBeenCalled();expect(context.vendorQuote).not.toHaveBeenCalled();
});

it('a still-valid stored public fare does not cover a newly added cheaper fare for the same pair', async () => {
  const context = await setupSnapshot(13_000, new Date(now.getTime()-90_000).toISOString(), true);
  const result = await runSearch({repo:context.repo,tp:context.tp,now,
    fx:{date:'2026-10-08',source:'test',ratesToIls:{ILS:1,USD:3,TWD:0.1}},quoteSources:[context.source,context.vendor]},request);
  expect(result.meta.fromCache).toBe(true);
  expect(result.cards.some(card=>card.offer.source==='eva'&&card.offer.priceAmount===13_000)).toBe(true);
  expect(result.cards.some(card=>card.offer.source==='travelpayouts')).toBe(true);
  expect(context.tp.roundTrips).not.toHaveBeenCalled();expect(context.tp.oneWays).not.toHaveBeenCalled();
  expect(context.vendorQuote).not.toHaveBeenCalled();expect(context.source.callCount()).toBe(0);
  const hit = await context.repo.getCachedOffers(await computeSearchKey(request),6,now);
  expect(hit!.createdAt).toBe(tpOffer.checkedAt);
});

it('a claimed cache-only reader with a nonzero request estimate is not called on a cache hit', async () => {
  const context = await setupSnapshot(13_000);
  const quote = vi.fn().mockRejectedValue(new Error('unexpected request'));
  const source: FareQuoteSource = {...context.vendor,cacheOnly:true,nextQuoteRequests:()=>1,quote};
  const result = await runSearch({repo:context.repo,tp:context.tp,now,
    fx:{date:'2026-10-08',source:'test',ratesToIls:{ILS:1,USD:3,TWD:0.1}},quoteSources:[source]},request);
  expect(result.meta.fromCache).toBe(true);expect(quote).not.toHaveBeenCalled();
});
