import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectEvaBatch, evaCadence, observedEvaCatalog, selectEvaBatch } from './eva-batch.mjs';

const page = index => `https://flights.evaair.com/en-tw/flights-from-city-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
const inventory = Array.from({ length: 50 }, (_, index) => ({ url: page(index), observedOn: page(0) }));
const catalog = inventory.map(row => ({ airline: 'BR', origin: 'TPE', destination: 'NRT', sourceUrl: row.url, collector: 'eva' }));
const checkedAt = '2026-10-08T12:00:00.000Z';
const record = { __typename: 'Fare', travelClass: 'Economy Basic', farenetTravelClass: 'ECONOMY',
  formattedTravelClass: 'Economy', originAirportCode: 'TPE', destinationAirportCode: 'NRT',
  departureDate: '2029-06-01', returnDate: '2029-06-05', flightType: 'ROUND_TRIP', currencyCode: 'TWD',
  totalPrice: 13000, formattedTotalPrice: 'TWD 13,000', priceLastSeen: { value: '7', unit: 'hours' },
  redemption: false, promoCode: '' };
const html = records => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: records } })}</script>`;

async function proofDirectory(run) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'eva-batch-proof-'));
  try { return await run(outputDirectory); }
  finally {
    assert.ok(resolve(outputDirectory).startsWith(resolve(join(tmpdir(), 'eva-batch-proof-'))));
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

test('three circular batches cover all fifty pages and later pages are never starved', () => {
  let cursor = 0;
  const counts = new Map(inventory.map(row => [row.url, 0]));
  for (let run = 0; run < 15; run++) {
    const batch = selectEvaBatch(inventory, catalog, { cursor, limit: 20 });
    assert.equal(batch.pages.length, 20);
    assert.equal(new Set(batch.pages.map(row => row.url)).size, 20);
    for (const row of batch.pages) counts.set(row.url, counts.get(row.url) + 1);
    if (run === 2) assert.ok([...counts.values()].every(count => count > 0));
    cursor = batch.nextCursor;
  }
  assert.deepEqual(new Set(counts.values()), new Set([6]));
  assert.equal(cursor, 0);
});

test('a full refresh selects exactly all approved pages, without unobserved or duplicate links', () => {
  assert.equal(selectEvaBatch(inventory, catalog, { cursor: 100, limit: 50 }).pages.length, 50);
  assert.equal(selectEvaBatch(inventory, catalog.slice(0, 2), { limit: 20 }).pages.length, 2);
  assert.throws(() => selectEvaBatch(inventory, [{ ...catalog[0], sourceUrl: page(50) }]));
  assert.throws(() => selectEvaBatch([...inventory, inventory[0]], catalog));
  assert.throws(() => selectEvaBatch(inventory, [{ ...catalog[0], origin: '---' }]));
  for (const limit of [0, 51, 1.1]) assert.throws(() => selectEvaBatch(inventory, catalog, { limit }));
  assert.throws(() => selectEvaBatch(inventory, catalog, { cursor: -1 }));
});

test('twenty pages every five minutes cannot keep fifty pages inside the original TTL', () => {
  assert.deepEqual(evaCadence({ pageCount: 50, batchSize: 20 }), {
    runsPerCycle: 3, maximumCaptureGapMs: 1_170_000, freshForAllPages: false, freshnessMarginMs: -570_000,
  });
  assert.deepEqual(evaCadence({ pageCount: 50, batchSize: 50 }), {
    runsPerCycle: 1, maximumCaptureGapMs: 570_000, freshForAllPages: true, freshnessMarginMs: 30_000,
  });
  assert.equal(evaCadence({ pageCount: 50, batchSize: 50, intervalMs: 330_000 }).freshForAllPages, false);
});

test('catalog identities derive only from original valid records and contain no prices', () => {
  const observations = [{ ...inventory[0], checkedAt, records: [record,
    { ...record, originAirportCode: 'KHH' }, { ...record, travelClass: 'Business Basic' }] },
  { ...inventory[1], checkedAt, records: [record], error: 'HTTP 503' },
  { url: page(50), checkedAt, records: [record] }];
  const proposal = observedEvaCatalog(observations, inventory);
  assert.equal(proposal.length, 2);
  assert.deepEqual(Object.keys(proposal[0]), ['airline', 'origin', 'destination', 'sourceUrl', 'collector']);
  assert.ok(proposal.every(row => row.sourceUrl === inventory[0].url));
  assert.throws(() => observedEvaCatalog([{ ...observations[0], checkedAt: 'bad' }], inventory));
  assert.deepEqual(observedEvaCatalog([{ ...inventory[0], checkedAt, records: [], fares: [record] }], inventory), []);
});

test('read-only collection preserves records, native prices and capture before fetch with concurrency at most two', async () => {
  await proofDirectory(async outputDirectory => {
    let active = 0, peak = 0;
    const fetchTimes = new Map();
    const result = await collectEvaBatch({ inventory, catalog, limit: 4, outputDirectory, minimumStartGapMs: 0,
      fetchFn: async (url, options) => {
        assert.equal(options.method, undefined);
        assert.equal(options.redirect, 'manual');
        assert.deepEqual(options.headers, { Accept: 'text/html' });
        fetchTimes.set(url.href, Date.now());
        active++; peak = Math.max(peak, active);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
        active--;
        return new Response(html([record]));
      } });
    assert.equal(peak, 2); assert.equal(result.summary.peakConcurrency, 2);
    assert.equal(result.summary.successfulPages, 4); assert.equal(result.summary.validFares, 4);
    for (const row of result.observations) {
      assert.ok(Date.parse(row.checkedAt) <= fetchTimes.get(row.url));
      assert.deepEqual(row.records, [record]);
      assert.equal(row.fares[0].amount, 13000); assert.equal(row.fares[0].currency, 'TWD');
      assert.equal(row.fares[0].checkedAt, row.checkedAt);
      assert.equal(row.fares[0].operator, null);
      assert.deepEqual(row.fares[0].upstreamPriceAge, { value: 7, unit: 'hours' });
      assert.equal(row.publication, undefined);
    }
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'eva-batch-observations.json'), 'utf8')), result.observations);
  });
});

test('failed and missing-schema pages remain diagnostic and cannot add catalog identities', async () => {
  await proofDirectory(async outputDirectory => {
    let calls = 0;
    const result = await collectEvaBatch({ inventory, catalog, limit: 3, outputDirectory, minimumStartGapMs: 0,
      fetchFn: async () => ++calls === 1 ? new Response('unavailable', { status: 503 })
        : new Response(calls === 2 ? '<html>missing public Fare data</html>' : html([record])) });
    assert.equal(result.summary.failures, 1); assert.equal(result.summary.pagesWithValidFares, 1);
    assert.equal(result.observations[0].error, 'HTTP 503');
    assert.deepEqual(result.observations[1].records, []);
    assert.deepEqual(result.observations[1].fares, []);
    assert.equal(observedEvaCatalog(result.observations, inventory).length, 1);
  });
});

test('request and run deadlines checkpoint failures without retrying or resetting capture', async () => {
  await proofDirectory(async outputDirectory => {
    let calls = 0;
    const result = await collectEvaBatch({ inventory, catalog, limit: 8, outputDirectory, minimumStartGapMs: 0,
      requestTimeoutMs: 10, maximumRunMs: 18,
      fetchFn: async (_url, options) => {
        calls++;
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      } });
    assert.ok(calls <= 4); assert.equal(result.observations.length, 8);
    assert.equal(result.summary.failures, 8); assert.equal(result.summary.nextCursor, 8);
    assert.ok(result.summary.durationMs < 500);
    assert.ok(result.observations.every(row => row.error && row.publication === undefined));
    assert.equal(JSON.parse(await readFile(join(outputDirectory, 'eva-batch-observations.json'), 'utf8')).length, 8);
  });
});

test('bounded collection rejects excessive concurrency and oversized public pages', async () => {
  await proofDirectory(async outputDirectory => {
    await assert.rejects(collectEvaBatch({ inventory, catalog, outputDirectory, concurrency: 3 }));
    const result = await collectEvaBatch({ inventory, catalog, outputDirectory, limit: 1,
      fetchFn: async () => new Response('x'.repeat(2_000_001)) });
    assert.equal(result.observations[0].error, 'Official page size limit');
    assert.equal(result.summary.validFares, 0);
  });
});
