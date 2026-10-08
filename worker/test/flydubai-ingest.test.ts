import {expect, it, vi} from 'vitest';
import {ingestPublicFares} from '../src/external-fare-ingest';
import {BACKGROUND_FARE_TTL_MS, cacheRequest, createPublicFareCache, publicFareMaximumAge} from '../src/public-fare-cache';
import pages from '../src/flydubai-published-catalog.json';
import type {Env} from '../src/types';

const now = new Date('2026-10-08T10:00:00Z');
const token = 'a'.repeat(64);
const page = 'https://www.flydubai.com/en-ae/flights-to-tbilisi/';
const row = {origin: 'DXB', destination: 'TBS', currency: 'AED', type: 'OWRT',
  departureDate: '2026-11-01', returnDate: '2026-11-05', amount: 1732,
  owDepartureDate: '2026-11-01', owAmount: '840.00'};
const payload = {source: 'flydubai_page', origin: 'DXB', destination: 'TBS', page,
  checkedAt: now.toISOString(), records: [row]};
function request(value: unknown = payload, key = token): Request {
  return new Request('https://example.test/api/internal/public-fares', {method: 'POST',
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
}
function environment() {
  const write = vi.fn().mockResolvedValue(undefined);
  const read = vi.fn().mockResolvedValue(null);
  const getByName = vi.fn(() => ({write, read}));
  return {write, read, getByName, value: {COLLECTOR_KEY: token, PUBLIC_FARES: {getByName}} as unknown as Env};
}
function storage() {
  const rows = new Map<string, Response>();
  return {rows, match: async (input: RequestInfo) => rows.get((input as Request).url)?.clone(),
    put: async (input: RequestInfo, response: Response) => {rows.set((input as Request).url, response.clone());}};
}

it('authenticates before reading flydubai payloads or accessing storage', async () => {
  const e = environment();
  const req = request(payload, 'b'.repeat(64));
  const readBody = vi.spyOn(req.body!, 'getReader');
  expect((await ingestPublicFares(req, e.value, now)).status).toBe(401);
  expect(readBody).not.toHaveBeenCalled(); expect(req.bodyUsed).toBe(false);
  expect(e.getByName).not.toHaveBeenCalled(); expect(e.write).not.toHaveBeenCalled();
  const missing = new Request(req.url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  expect((await ingestPublicFares(missing, e.value, now)).status).toBe(401);
  expect(missing.bodyUsed).toBe(false);
});

it('fails closed without collector or storage configuration and without consuming the body', async () => {
  for (const env of [{} as Env, {COLLECTOR_KEY: 'invalid'} as Env, {COLLECTOR_KEY: token} as Env]) {
    const req = request();
    expect((await ingestPublicFares(req, env, now)).status).toBe(503);
    expect(req.bodyUsed).toBe(false);
  }
  expect((await ingestPublicFares(new Request('https://example.test', {method: 'GET'}), environment().value, now)).status).toBe(405);
});

it('reparses duplicate raw rows into explicit OW and RT prices with original capture and native AED', async () => {
  const e = environment();
  const checkedAt = new Date(now.getTime() - 120_000).toISOString();
  const res = await ingestPublicFares(request({...payload, checkedAt, records: [row, row]}), e.value, now);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({source: 'flydubai_page', fares: 2, checkedAt});
  expect(e.getByName).toHaveBeenCalledWith(cacheRequest(page).url);
  expect(e.write).toHaveBeenCalledTimes(1);
  const [key, body] = e.write.mock.calls[0]!;
  expect(key).toBe(page);
  expect(JSON.parse(body)).toMatchObject({storedAt: now.getTime() - 120_000,
    expires: now.getTime() - 120_000 + 600_000, fares: [
      {origin: 'DXB', destination: 'TBS', amount: 840, currency: 'AED', structure: 'oneway',
        returnDate: null, checkedAt, pricing: 'published_advertisement'},
      {origin: 'DXB', destination: 'TBS', amount: 1732, currency: 'AED', structure: 'roundtrip',
        departDate: row.departureDate, returnDate: row.returnDate, checkedAt},
    ]});
  for (const fare of JSON.parse(body).fares) {
    expect(fare.sourceUrl).toBe(page);
    expect(fare).not.toHaveProperty('airline'); expect(fare).not.toHaveProperty('operator');
    expect(fare).not.toHaveProperty('cabin'); expect(fare).not.toHaveProperty('checkedBag');
  }
});

it.each([
  {...payload, page: 'https://www.flydubai.com/en-ae/flights-to-imaginary/'},
  {...payload, page: 'https://evil.test/en-ae/flights-to-tbilisi/'},
  {...payload, page: `${page}?token=secret`},
  {...payload, origin: 'TLV'}, {...payload, destination: 'DXB'},
])('rejects unapproved page and declared route identities', async value => {
  const e = environment();
  const response = await ingestPublicFares(request(value), e.value, now);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error: 'unapproved_page_route'});
  expect(e.write).not.toHaveBeenCalled();
});

it.each([
  'invalid', new Date(now.getTime() + 1).toISOString(), new Date(now.getTime() - 120_001).toISOString(), null,
])('rejects invalid, future or more-than-two-minute-old original captures', async checkedAt => {
  const e = environment();
  const response = await ingestPublicFares(request({...payload, checkedAt}), e.value, now);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error: 'invalid_observation_time'});
  expect(e.write).not.toHaveBeenCalled();
});

it('rejects malformed raw prices, routes, dates and row types instead of accepting normalized caller fares', async () => {
  const e = environment();
  const records = [null, {...row, origin: 'TLV'}, {...row, destination: 'MCT'}, {...row, type: 'RT'},
    {...row, currency: 'aed'}, {...row, owAmount: '840 AED', amount: -1},
    {...row, owDepartureDate: '2026-02-30', departureDate: '2026-02-30'},
    {origin: 'DXB', destination: 'TBS', amount: 840, currency: 'AED', structure: 'oneway', departDate: row.departureDate}];
  const response = await ingestPublicFares(request({...payload, records}), e.value, now);
  expect(response.status).toBe(422); expect(e.write).not.toHaveBeenCalled();
});

it('does not turn a same-day round-trip ad into a vacation or infer its missing return date', async () => {
  for (const returnDate of [row.departureDate, '2026-10-31', null, '2026-02-30']) {
    const e = environment();
    const invalid = {...row, returnDate, owAmount: null};
    expect((await ingestPublicFares(request({...payload, records: [invalid]}), e.value, now)).status).toBe(422);
    expect(e.write).not.toHaveBeenCalled();
  }
  const e = environment();
  expect((await ingestPublicFares(request({...payload, records: [{...row, returnDate: row.departureDate}]}), e.value, now)).status).toBe(200);
  expect(JSON.parse(e.write.mock.calls[0]![1]).fares).toMatchObject([{structure: 'oneway', amount: 840, returnDate: null}]);
});

it('clears disappeared prices only for explicit authenticated approved snapshots', async () => {
  const e = environment();
  expect((await ingestPublicFares(request({...payload, records: []}), e.value, now)).status).toBe(422);
  expect((await ingestPublicFares(request({...payload, records: [], clearIfNoPrices: 'true'}), e.value, now)).status).toBe(422);
  expect(e.write).not.toHaveBeenCalled();
  expect((await ingestPublicFares(request({...payload, records: [], clearIfNoPrices: true}), e.value, now)).status).toBe(200);
  expect(JSON.parse(e.write.mock.calls[0]![1])).toEqual({storedAt: now.getTime(), expires: now.getTime() + 600_000, fares: []});
  expect((await ingestPublicFares(request({...payload, origin: 'TLV', records: [], clearIfNoPrices: true}), e.value, now)).status).toBe(400);
  expect(e.write).toHaveBeenCalledTimes(1);
});

it('bounds record counts and payload bytes and reports storage write failure', async () => {
  const e = environment();
  expect((await ingestPublicFares(request({...payload, records: 'wrong'}), e.value, now)).status).toBe(400);
  expect((await ingestPublicFares(request({...payload, records: Array(501).fill(row)}), e.value, now)).status).toBe(400);
  expect((await ingestPublicFares(request({...payload, padding: 'x'.repeat(128_001)}), e.value, now)).status).toBe(413);
  expect(e.write).not.toHaveBeenCalled();
  e.write.mockRejectedValue(Error('unavailable'));
  expect((await ingestPublicFares(request(), e.value, now)).status).toBe(503);
});

it('admits every actual catalog page while rejecting altered URLs, credentials and unobserved pages', async () => {
  for (const p of pages) {
    expect(cacheRequest(p.sourceUrl).url).toBe(`https://eee-api.liorilay2004.workers.dev/__public_fares/v1/${encodeURIComponent(p.sourceUrl)}`);
    expect(publicFareMaximumAge(p.sourceUrl)).toBe(600_000);
  }
  for (const invalid of [`${page}?key=secret`, `${page}#fragment`, page.replace('https:', 'http:'),
    page.replace('www.flydubai.com', 'user:secret@www.flydubai.com'), page.replace('www.flydubai.com', 'www.flydubai.com:8443'),
    'https://www.flydubai.com/account/', 'https://www.flydubai.com/en-ae/flights-to-imaginary/']) {
    expect(() => cacheRequest(invalid)).toThrow();
  }
});

it('limits flydubai shared snapshots to ten minutes even under background TTL without renewing original captures', async () => {
  const db = storage();
  const fares = [{amount: 840, checkedAt: now.toISOString()}];
  await createPublicFareCache(db as unknown as Cache, now, BACKGROUND_FARE_TTL_MS).put(page, fares);
  const later = new Date(now.getTime() + 599_999);
  expect(await createPublicFareCache(db as unknown as Cache, later).get(page)).toEqual({fares, expires: now.getTime() + 600_000});
  expect(await createPublicFareCache(db as unknown as Cache, new Date(now.getTime() + 600_000)).get(page)).toBeNull();
  db.rows.set(cacheRequest(page).url, Response.json({storedAt: now.getTime(), expires: now.getTime() + BACKGROUND_FARE_TTL_MS, fares}));
  expect(await createPublicFareCache(db as unknown as Cache, now).get(page)).toBeNull();
});

it('preserves ingestion expiry measured from the original capture instead of arrival time', async () => {
  const e = environment();
  const original = new Date(now.getTime() - 120_000);
  expect((await ingestPublicFares(request({...payload, checkedAt: original.toISOString()}), e.value, now)).status).toBe(200);
  const body = e.write.mock.calls[0]![1];
  const db = storage();
  db.rows.set(cacheRequest(page).url, new Response(body));
  expect((await createPublicFareCache(db as unknown as Cache, now).get(page))?.expires).toBe(original.getTime() + 600_000);
  expect(await createPublicFareCache(db as unknown as Cache, new Date(original.getTime() + 600_000)).get(page)).toBeNull();
});
