import {expect, it, vi} from 'vitest';
import {supplementExoticFx} from '../src/exotic-fx-supplement';
import {readFxCache, writeFxCache} from '../src/fx-cache';
import {FALLBACK_URL} from '../src/fx';
import type {FxRates} from '../src/types';

const now = new Date('2026-10-08T10:00:00Z');
const base: FxRates = {date: '2026-10-08', source: 'bank_of_israel', ratesToIls: {ILS: 1, USD: 3, EUR: 3.5}};
function payload(publishedAt = '2026-10-08T00:02:31Z') {
  const date = new Date(publishedAt);
  return {result: 'success', base_code: 'ILS', time_last_update_unix: date.getTime() / 1000,
    time_last_update_utc: date.toUTCString().replace('GMT', '+0000'),
    rates: {ILS: 1, USD: .325957, AED: 1.196501, TWD: 10.397027, GBP: .25}};
}
const fetcher = (value: unknown = payload()) => vi.fn(async () => Response.json(value)) as unknown as typeof fetch;
function storage() {
  const rows = new Map<string, Response>();
  return {rows, match: async (request: RequestInfo) => rows.get((request as Request).url)?.clone(),
    put: async (request: RequestInfo, response: Response) => {rows.set((request as Request).url, response.clone());}};
}

it('uses the documented ILS-base reciprocals without overwriting any primary rate or adding unrequested codes', async () => {
  const fetchFn = fetcher();
  const fx = await supplementExoticFx(base, ['AED'], fetchFn, now);
  expect(fx.ratesToIls).toEqual({...base.ratesToIls, AED: 1 / 1.196501});
  expect(fx).toMatchObject({date: '2026-10-08', source: 'bank_of_israel+open.er-api.com'});
  expect(base.ratesToIls).not.toHaveProperty('AED'); expect(fx.ratesToIls).not.toHaveProperty('GBP');
  expect(fetchFn).toHaveBeenCalledWith(FALLBACK_URL, expect.objectContaining({redirect: 'manual',
    headers: {accept: 'application/json'}, signal: expect.any(AbortSignal)}));
});

it('makes no request for unrelated or existing rates and coalesces different requested currencies within an hour', async () => {
  const fetchFn = fetcher();
  expect(await supplementExoticFx(base, [], fetchFn, now)).toBe(base);
  expect(await supplementExoticFx(base, ['USD', 'KZT', 'EUR'], fetchFn, now)).toBe(base);
  const existing = {...base, ratesToIls: {...base.ratesToIls, AED: .9, TWD: .09}};
  expect(await supplementExoticFx(existing, ['AED', 'TWD'], fetchFn, now)).toBe(existing);
  expect(fetchFn).not.toHaveBeenCalled();
  const [a, b] = await Promise.all([supplementExoticFx(base, ['AED'], fetchFn, now),
    supplementExoticFx(base, ['TWD'], fetchFn, now)]);
  expect(a.ratesToIls).toEqual({...base.ratesToIls, AED: 1 / 1.196501});
  expect(b.ratesToIls).toEqual({...base.ratesToIls, TWD: 1 / 10.397027});
  expect(fetchFn).toHaveBeenCalledTimes(1);
  await supplementExoticFx(base, ['AED'], fetchFn, new Date(now.getTime() + 3_600_000));
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('retains the oldest primary or provider publication date and marks earlier days stale', async () => {
  const olderProvider = await supplementExoticFx(base, ['AED'], fetcher(payload('2026-10-07T23:59:59Z')), now);
  expect(olderProvider).toMatchObject({date: '2026-10-07', source: 'bank_of_israel+open.er-api.com:stale'});
  const olderBase = {...base, date: '2026-10-06', source: 'bank_of_israel:stale'};
  expect(await supplementExoticFx(olderBase, ['TWD'], fetcher(), now))
    .toMatchObject({date: '2026-10-06', source: 'bank_of_israel+open.er-api.com:stale'});
  const ready = {...base, ratesToIls: {...base.ratesToIls, AED: 1.1}};
  const fx = await supplementExoticFx(ready, ['AED', 'TWD'], fetcher(), now);
  expect(fx.ratesToIls.AED).toBe(1.1); expect(fx.ratesToIls.TWD).toBe(1 / 10.397027);
});

it('rejects missing, disagreeing, non-UTC, impossible, future or older-than-seven-day publication timestamps', async () => {
  const good = payload();
  for (const invalid of [
    {...good, time_last_update_unix: undefined}, {...good, time_last_update_utc: undefined},
    {...good, time_last_update_unix: good.time_last_update_unix + 1},
    {...good, time_last_update_unix: String(good.time_last_update_unix)},
    {...good, time_last_update_utc: 'Thu, 08 Oct 2026 02:02:31 +0200'},
    {...good, time_last_update_utc: 'Fri, 30 Feb 2026 00:02:31 +0000'},
    payload('2026-10-08T10:00:01Z'), payload('2026-10-01T09:59:59Z'),
  ]) expect(await supplementExoticFx(base, ['AED'], fetcher(invalid), now)).toBe(base);
  expect((await supplementExoticFx(base, ['AED'], fetcher(payload('2026-10-01T10:00:00Z')), now)).ratesToIls.AED)
    .toBe(1 / 1.196501);
});

it('rejects wrong bases and non-positive, non-finite or coerced rates without inventing a pegged conversion', async () => {
  const good = payload();
  for (const invalid of [null, [], {...good, result: 'error'}, {...good, base_code: 'USD'},
    {...good, rates: {...good.rates, ILS: 2}}, {...good, rates: {...good.rates, USD: 0}},
    ...[0, -1, null, true, '1.196501', Number.MIN_VALUE].map(AED => ({...good, rates: {...good.rates, AED}})),
  ]) expect(await supplementExoticFx(base, ['AED'], fetcher(invalid), now)).toBe(base);
  const fx = await supplementExoticFx(base, ['AED', 'TWD'], fetcher({...good, rates: {...good.rates, AED: 0}}), now);
  expect(fx.ratesToIls).toEqual({...base.ratesToIls, TWD: 1 / 10.397027});
});

it('keeps primary rates after HTTP, redirect, JSON, network or oversized streaming payload failures', async () => {
  for (const fetchFn of [
    vi.fn(async () => new Response('', {status: 429})),
    vi.fn(async () => new Response('', {status: 302, headers: {location: 'https://evil.test'}})),
    vi.fn(async () => new Response('{bad json')),
    vi.fn(async () => new Response('x'.repeat(32_001))),
    vi.fn(async () => {throw Error('down');}),
  ]) expect(await supplementExoticFx(base, ['AED'], fetchFn as unknown as typeof fetch, now)).toBe(base);
  const cancel = vi.fn();
  const oversized = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(32_001));}, cancel});
  const fetchFn = vi.fn(async () => new Response(oversized)) as unknown as typeof fetch;
  expect(await supplementExoticFx(base, ['AED'], fetchFn, now)).toBe(base);
  expect(cancel).toHaveBeenCalled();
});

it('uses the separate exotic edge cache and retains the provider publication timestamp', async () => {
  const db = storage();
  const edge = db as unknown as Cache;
  await writeFxCache(edge, now, base);
  const fetchFn = fetcher();
  await supplementExoticFx(base, ['AED'], fetchFn, now, edge);
  const extra = await readFxCache(edge, now, 'exotic');
  expect(extra).toMatchObject({date: '2026-10-08', source: 'open.er-api.com', publishedAt: '2026-10-08T00:02:31.000Z'});
  expect(await readFxCache(edge, now)).toEqual(base);
  expect([...db.rows.keys()].some(key => key.includes('/exotic/'))).toBe(true);
  const unused = fetcher();
  // A different wrapper avoids the in-memory pending promise and proves the public cache hit.
  const other = {match: db.match, put: db.put} as unknown as Cache;
  expect((await supplementExoticFx(base, ['TWD'], unused, now, other)).ratesToIls.TWD).toBe(1 / 10.397027);
  expect(unused).not.toHaveBeenCalled();
});

it('rejects supplemental cached metadata without an original publication or exceeding seven days', async () => {
  for (const publishedAt of [undefined, '2026-10-08T10:00:01.000Z', '2026-10-01T09:59:59.000Z']) {
    const db = storage();
    const extra = {date: publishedAt?.slice(0, 10) ?? '2026-10-08', source: publishedAt?.startsWith('2026-10-01') ? 'open.er-api.com:stale' : 'open.er-api.com',
      ratesToIls: {ILS: 1, USD: 3, AED: .9}, publishedAt};
    await writeFxCache(db as unknown as Cache, now, extra, 'exotic');
    const fetchFn = fetcher();
    expect((await supplementExoticFx(base, ['AED'], fetchFn, now, db as unknown as Cache)).ratesToIls.AED).toBe(1 / 1.196501);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }
});

it('rechecks a coalesced publication when it crosses the seven-day boundary without a new fetch', async () => {
  const fetchFn = fetcher(payload('2026-10-01T10:00:00Z'));
  expect((await supplementExoticFx(base, ['AED'], fetchFn, now)).ratesToIls.AED).toBe(1 / 1.196501);
  expect(await supplementExoticFx(base, ['AED'], fetchFn, new Date(now.getTime() + 1))).toBe(base);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
