import { expect, it, vi } from 'vitest';
import { aegeanCalendarUrl, type AegeanCalendarFare, type AegeanCalendarTrip } from '../src/aegean-lowfare';
import { createRepo } from '../src/db';
import { computeSearchKey, runSearch } from '../src/pipeline';
import type { PublicFareCache } from '../src/public-fare-cache';
import type { FareQuoteSource } from '../src/quotes';
import { createAegeanPublishedSource } from '../src/sources/aegean-published';
import type { Offer, SearchRequest, TravelpayoutsClient } from '../src/types';
import { createTestD1 } from './helpers/d1';

const now = new Date('2026-10-08T12:00:00.000Z');
const trip: AegeanCalendarTrip = { origin: 'TLV', destination: 'ATH', departDate: '2027-06-01', returnDate: '2027-06-05' };
const request: SearchRequest = { origin: trip.origin, destination: trip.destination, windowStart: trip.departDate,
  windowEnd: trip.returnDate, stayMin: 4, stayMax: 4, adults: 1, children: 0, infants: 0, cabin: 'economy',
  checkedBag: false, outHours: [12, 17], retHours: [12, 17], maxStops: null, nearbyAirports: false };
const query = { ...trip, party: { adults: 1, children: 0, infants: 0 } };
const tpAt = new Date(now.getTime() - 300_000).toISOString();
const currentAt = new Date(now.getTime() - 90_000).toISOString();
const vendorUpdatedAt = '2026-10-07T00:00:00.000Z';
const leg = { departTime: '14:00', arriveTime: null, durationMin: 120, stops: 0, airlines: ['A3'] };
const tpOffer: Offer = { ...trip, source: 'travelpayouts', priceAmount: 400, priceCurrency: 'EUR',
  ticketStructure: 'roundtrip', outbound: leg, inbound: leg, includes: {}, deeplink: 'https://www.aviasales.com/',
  verifyLink: null, checkedAt: tpAt, extrasAmountIls: 0, totalIls: null, tags: [] };

function observation(amount: number, checkedAt = currentAt, selectedTrip = trip): AegeanCalendarFare {
  return { ...selectedTrip, amount, currency: 'EUR', outboundAmount: 104.63,
    inboundAmount: Math.round((amount - 104.63) * 100) / 100,
    bookingUrl: aegeanCalendarUrl(selectedTrip), checkedAt, pricing: 'published_advertisement', carrier: null,
    outboundUpdatedAt: vendorUpdatedAt, inboundUpdatedAt: vendorUpdatedAt };
}

type SnapshotOptions = { amount?: number | null; checkedAt?: string; selectedTrip?: AegeanCalendarTrip;
  seedOld?: boolean; throwCache?: boolean };

async function setup(options: SnapshotOptions = {}) {
  const repo = createRepo(createTestD1());
  const oldAt = new Date(now.getTime() - 120_000).toISOString();
  let rows: AegeanCalendarFare[] = [observation(240, oldAt)];
  let cacheThrows = false;
  const cache = { get: vi.fn(async (url: string) => {
    if (cacheThrows) throw new Error('cache unavailable');
    return rows.length > 0 && url === rows[0]!.bookingUrl
      ? { fares: rows, expires: Date.parse(rows[0]!.checkedAt) + 600_000 } : null;
  }), put: vi.fn() } as unknown as PublicFareCache;
  const fetchFn = vi.fn().mockRejectedValue(new Error('unexpected airline request'));
  const [oldOffer] = await createAegeanPublishedSource(now, fetchFn as typeof fetch, cache).quote(query);
  const seedOld = options.seedOld !== false;
  await repo.putCachedOffers(await computeSearchKey(request), [tpOffer], new Date(tpAt),
    { oneWayPairs: [], notes: [], quotes: seedOld ? [oldOffer!] : [] });
  if (seedOld) await repo.savePrices([oldOffer!]);
  rows = options.amount === null ? [] : [observation(options.amount ?? 232.37, options.checkedAt ?? currentAt,
    options.selectedTrip ?? trip)];
  cacheThrows = options.throwCache === true;
  const prepare = vi.fn(() => { throw new Error('unexpected Aegean D1 fallback'); });
  const onDemand = vi.fn().mockRejectedValue(new Error('unexpected Aegean on-demand request'));
  const source = createAegeanPublishedSource(now, fetchFn as typeof fetch, cache,
    { prepare } as unknown as D1Database, onDemand);
  const liveQuote = vi.spyOn(source, 'quote');
  const tp = { configured: true, callCount: () => 0,
    roundTrips: vi.fn().mockRejectedValue(new Error('unexpected Travelpayouts request')),
    oneWays: vi.fn().mockRejectedValue(new Error('unexpected Travelpayouts request')) } as TravelpayoutsClient;
  const vendorQuote = vi.fn().mockRejectedValue(new Error('unexpected paid vendor request'));
  const vendor: FareQuoteSource = { name: 'searchapi', configured: true,
    quota: { period: 'monthly', cap: 100, allowance: 100 }, callCount: () => 0,
    nextQuoteRequests: () => 0, quote: vendorQuote };
  return { repo, cache, fetchFn, prepare, onDemand, source, liveQuote, tp, vendor, vendorQuote };
}

async function search(context: Awaited<ReturnType<typeof setup>>) {
  return runSearch({ repo: context.repo, tp: context.tp, now,
    fx: { date: '2026-10-08', source: 'test', ratesToIls: { ILS: 1, USD: 3, EUR: 4 } },
    quoteSources: [context.source, context.vendor] }, request);
}

function expectNoUpstream(context: Awaited<ReturnType<typeof setup>>) {
  expect(context.fetchFn).not.toHaveBeenCalled();
  expect(context.onDemand).not.toHaveBeenCalled();
  expect(context.prepare).not.toHaveBeenCalled();
  expect(context.liveQuote).not.toHaveBeenCalled();
  expect(context.tp.roundTrips).not.toHaveBeenCalled();
  expect(context.tp.oneWays).not.toHaveBeenCalled();
  expect(context.vendorQuote).not.toHaveBeenCalled();
  expect(context.source.callCount()).toBe(0);
}

it.each([232.37, 300])('a TP cache hit reloads a changed hybrid Aegean snapshot at EUR %s', async (amount) => {
  const context = await setup({ amount });
  expect(context.source.cacheOnly).toBeUndefined();
  expect(context.source.nextQuoteRequests(query)).toBeGreaterThan(0);
  const result = await search(context);
  expect(result.meta.fromCache).toBe(true);
  const current = result.cards.find(card => card.offer.source === 'aegean')!;
  expect(current).toBeDefined();
  expect(current.offer).toMatchObject({ ...trip, priceAmount: amount, priceCurrency: 'EUR', checkedAt: currentAt,
    sourceUpdatedAt: vendorUpdatedAt, fareFoundAt: null, deeplink: aegeanCalendarUrl(trip),
    outbound: { departTime: null, stops: null, airlines: [] }, inbound: { departTime: null, stops: null, airlines: [] } });
  expect(current).toMatchObject({ scanAgeMinutes: 1, fareAgeBasis: 'unknown', fareAgeMinutes: null, freshness: 'unknown' });
  expect(current.ageLabelHe).toContain('07/10/2026');
  expect(result.cards.some(card => card.offer.source === 'aegean' && card.offer.priceAmount === 240)).toBe(false);
  expect(result.cards.some(card => card.offer.source === 'travelpayouts')).toBe(true);
  expect(result.meta.sources.find(source => source.name === 'aegean')).toMatchObject({ calls: 0, ok: true });
  expectNoUpstream(context);
  expect((await context.repo.getCachedOffers(await computeSearchKey(request), 6, now))!.createdAt).toBe(tpAt);
});

it('discovers a new Aegean selected-trip snapshot absent from the original TP cache', async () => {
  const context = await setup({ seedOld: false });
  const result = await search(context);
  expect(result.meta.fromCache).toBe(true);
  expect(result.cards.find(card => card.offer.source === 'aegean')?.offer).toMatchObject({ ...trip,
    priceAmount: 232.37, priceCurrency: 'EUR', checkedAt: currentAt });
  expectNoUpstream(context);
});

it.each([
  { title: 'missing', amount: null },
  { title: 'expired', checkedAt: new Date(now.getTime() - 600_000).toISOString() },
  { title: 'future capture', checkedAt: new Date(now.getTime() + 1).toISOString() },
  { title: 'different selected dates', selectedTrip: { ...trip, returnDate: '2027-06-06' } },
  { title: 'cache failure', throwCache: true },
])('does not revive an old Aegean offer after a $title snapshot on a TP cache hit', async (options) => {
  const context = await setup(options);
  const result = await search(context);
  expect(result.meta.fromCache).toBe(true);
  expect(result.cards.every(card => card.offer.source !== 'aegean')).toBe(true);
  expect(result.cards.some(card => card.offer.source === 'travelpayouts')).toBe(true);
  expectNoUpstream(context);
});

it('isolates the cached hook from the hybrid source request counter and live quote methods', async () => {
  const context = await setup();
  const counter = vi.spyOn(context.source, 'callCount').mockReturnValue(73);
  const result = await search(context);
  expect(result.cards.find(card => card.offer.source === 'aegean')?.offer).toMatchObject({
    priceAmount: 232.37, checkedAt: currentAt,
  });
  expect(result.meta.sources.find(source => source.name === 'aegean')).toMatchObject({ calls: 0 });
  expect(counter).not.toHaveBeenCalled();
  expect(context.liveQuote).not.toHaveBeenCalled();
  expect(context.onDemand).not.toHaveBeenCalled();
  expect(context.fetchFn).not.toHaveBeenCalled();
  expect(context.prepare).not.toHaveBeenCalled();
});
