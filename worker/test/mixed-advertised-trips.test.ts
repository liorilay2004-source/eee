import {expect, it} from 'vitest';
import {mixedAdvertisedTrips} from '../src/mixed-advertised-trips';
import type {FlydubaiAdvertisement} from '../../collector/flydubai-fares.mjs';
import type {FxRates} from '../src/types';

const now = new Date('2026-10-08T10:00:00Z');
const q = {origin: 'DXB', destination: 'ASM', departDate: '2026-11-01', returnDate: '2026-11-05',
  party: {adults: 1, children: 0, infants: 0}};
const fx: FxRates = {date: '2026-10-08', source: 'bank_of_israel+open.er-api.com', ratesToIls: {ILS: 1, USD: 3, AED: .8}};
const out: FlydubaiAdvertisement = {origin: 'DXB', destination: 'ASM', departDate: q.departDate,
  returnDate: null, amount: 840, currency: 'AED', structure: 'oneway',
  sourceUrl: 'https://www.flydubai.com/en-ae/flights-to-asmara/', checkedAt: '2026-10-08T09:58:00Z', pricing: 'published_advertisement'};
const back: FlydubaiAdvertisement = {...out, origin: 'ASM', destination: 'DXB', departDate: q.returnDate,
  amount: 200, currency: 'USD', sourceUrl: 'https://www.flydubai.com/en-ae/flights-from-asmara-to-dubai/',
  checkedAt: '2026-10-08T09:57:00Z'};

it('preserves separate AED and USD native tickets and derives a dated ILS comparison only', () => {
  const result = mixedAdvertisedTrips([out, back], q, fx, now);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({outbound: {amount: 840, currency: 'AED', sourceUrl: out.sourceUrl,
    checkedAt: out.checkedAt, operator: null, cabin: null, stops: null, departTime: null},
    inbound: {amount: 200, currency: 'USD', sourceUrl: back.sourceUrl, checkedAt: back.checkedAt,
      operator: null, cabin: null, stops: null, departTime: null},
    comparison: {amountIls: 1272, fxDate: fx.date, fxSource: fx.source, kind: 'conversion_estimate'},
    checkedAt: back.checkedAt, expiresAt: '2026-10-08T10:07:00.000Z', separateTickets: true,
    checkoutVerified: false, additionalFeesKnown: false});
  expect(result[0]).not.toHaveProperty('priceAmount'); expect(result[0]).not.toHaveProperty('priceCurrency');
  expect(out.amount).toBe(840); expect(back.currency).toBe('USD');
});

it('uses exact observed dates and one adult and never infers a return or sums identical currencies', () => {
  expect(mixedAdvertisedTrips([out], q, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, {...back, currency: 'AED'}], q, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, back], {...q, returnDate: '2026-11-06'}, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, back], {...q, departDate: '2026-11-02'}, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, back], {...q, departDate: '2026-02-30'}, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, back], {...q, returnDate: q.departDate}, fx, now)).toEqual([]);
  for (const party of [{adults: 2, children: 0, infants: 0}, {adults: 1, children: 1, infants: 0}, {adults: 1, children: 0, infants: 1}]) {
    expect(mixedAdvertisedTrips([out, back], {...q, party}, fx, now)).toEqual([]);
  }
  expect(mixedAdvertisedTrips([out, back], {...q, adults: 2}, fx, now)).toEqual([]);
});

it('requires both native captures under ten minutes and never renews them with newer FX or repeated comparisons', () => {
  for (const checkedAt of ['invalid', '2026-10-08T10:00:01Z', '2026-10-08T09:50:00Z']) {
    expect(mixedAdvertisedTrips([{...out, checkedAt}, back], q, fx, now)).toEqual([]);
    expect(mixedAdvertisedTrips([out, {...back, checkedAt}], q, fx, now)).toEqual([]);
  }
  expect(mixedAdvertisedTrips([out, back], q, fx, new Date('2026-10-08T10:06:59.999Z'))[0]?.checkedAt).toBe(back.checkedAt);
  expect(mixedAdvertisedTrips([out, back], q, fx, new Date('2026-10-08T10:07:00Z'))).toEqual([]);
  const changed = mixedAdvertisedTrips([out, back], q, {...fx, ratesToIls: {...fx.ratesToIls, AED: .9}}, now)[0]!;
  expect(changed.comparison.amountIls).toBe(1356);
  expect(changed.outbound.amount).toBe(840); expect(changed.inbound.amount).toBe(200);
  expect(changed.expiresAt).toBe('2026-10-08T10:07:00.000Z');
});

it('rejects unapproved source links or pairs, round trips, malformed native prices and unknown currencies', () => {
  for (const invalid of [{...out, sourceUrl: 'https://evil.test'}, {...out, sourceUrl: `${out.sourceUrl}?key=secret`},
    {...out, origin: 'TLV'}, {...out, amount: -1}, {...out, amount: Infinity}, {...out, amount: 10_000_001},
    {...out, currency: 'AED '}, {...out, currency: 'EUR'},
    {...out, structure: 'roundtrip' as const, returnDate: q.returnDate}, {...out, returnDate: q.returnDate},
  ]) expect(mixedAdvertisedTrips([invalid, back], q, fx, now)).toEqual([]);
});

it('rejects unusable, future, over-seven-day or falsely current FX and never fills missing conversion rates', () => {
  for (const invalid of [{...fx, date: '2026-10-09'}, {...fx, date: '2026-09-30', source: 'bank_of_israel:stale'},
    {...fx, date: '2026-10-07'}, {...fx, date: '2026-02-30'}, {...fx, ratesToIls: {ILS: 1, USD: 3}},
    {...fx, ratesToIls: {...fx.ratesToIls, AED: 0}}, {...fx, ratesToIls: {...fx.ratesToIls, USD: Infinity}},
  ]) expect(mixedAdvertisedTrips([out, back], q, invalid, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, back], q, {...fx, date: '2026-10-01', source: 'open.er-api.com:stale'}, now)[0]?.comparison.fxDate)
    .toBe('2026-10-01');
  expect(mixedAdvertisedTrips([{...out, amount: .0001}, {...back, amount: .0001}], q, fx, now)).toEqual([]);
});

it('bounds original rows to five hundred, deduplicates identical observations and ranks at most twenty complete pairs', () => {
  expect(mixedAdvertisedTrips(Array(501).fill(out), q, fx, now)).toEqual([]);
  expect(mixedAdvertisedTrips([out, out, back, back], q, fx, now)).toHaveLength(1);
  const outs = Array.from({length: 25}, (_, i) => ({...out, amount: 1000 + i}));
  const backs = Array.from({length: 25}, (_, i) => ({...back, amount: 200 + i}));
  const result = mixedAdvertisedTrips([...outs, ...backs], q, fx, now);
  const all = outs.flatMap(o => backs.map(b => o.amount * .8 + b.amount * 3)).sort((a, b) => a - b).slice(0, 20);
  expect(result).toHaveLength(20);
  expect(result.map(trip => trip.comparison.amountIls)).toEqual(all.map(value => Number(value.toFixed(2))));
});
