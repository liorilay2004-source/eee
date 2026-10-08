import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectAsianPublishedPages, selectAsianObservedPages } from './probe-asian-published-pages.mjs';

const catalogs = {
  eva: JSON.parse(await readFile(new URL('../worker/src/eva-published-catalog.json', import.meta.url), 'utf8')),
  vietnam: JSON.parse(await readFile(new URL('../worker/src/vietnam-published-catalog.json', import.meta.url), 'utf8')),
};
const key = 'a'.repeat(64);
const cashFare = (config, provider = 'eva') => ({ __typename: 'Fare',
  travelClass: provider === 'eva' ? 'Economy Basic' : 'Economy Super Lite', farenetTravelClass: 'ECONOMY',
  formattedTravelClass: 'Economy', originAirportCode: config.origin, destinationAirportCode: config.destination,
  departureDate: '2029-06-01', returnDate: '2029-06-05', flightType: 'ROUND_TRIP', currencyCode: 'TWD',
  totalPrice: 13000, formattedTotalPrice: 'TWD 13,000', priceLastSeen: { value: '7', unit: 'hours' }, redemption: false, promoCode: '' });
const html = records => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { fares: records } })}</script>`;
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function proofDirectory(run) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'eva-expanded-integration-'));
  try { return await run(outputDirectory); }
  finally {
    assert.ok(resolve(outputDirectory).startsWith(resolve(join(tmpdir(), 'eva-expanded-integration-'))));
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

test('EVA default publication refreshes all fifty allowlisted pages with two lanes and immediate original receipts', async () => {
  await proofDirectory(async outputDirectory => {
    let active = 0, peak = 0;
    const fetched = new Set(), published = new Map(), capture = new Map();
    const rows = await collectAsianPublishedPages({ provider: 'eva', key, outputDirectory, evaMinimumStartGapMs: 0,
      fetchFn: async (input, options) => {
        const url = String(input);
        if (options.method === 'POST') {
          assert.equal(url, 'https://eee-api.liorilay2004.workers.dev/api/internal/public-fares');
          const body = JSON.parse(options.body);
          assert.equal(body.source, 'published_page'); assert.equal(body.airline, 'BR');
          assert.ok(Date.parse(body.checkedAt) <= capture.get(body.page));
          assert.ok(Date.now() - Date.parse(body.checkedAt) < 120_000);
          assert.deepEqual(body.records, [cashFare(catalogs.eva.find(config => config.sourceUrl === body.page))]);
          const checkpoint = JSON.parse(await readFile(join(outputDirectory, 'eva-published-observations.json'), 'utf8'));
          assert.ok(checkpoint.some(row => row.url === body.page && row.checkedAt === body.checkedAt && row.records.length === 1));
          published.set(body.page, body.checkedAt);
          return Response.json({ fares: 1, checkedAt: body.checkedAt });
        }
        assert.ok(url.startsWith('https://flights.evaair.com/en-tw/flights-from-'));
        assert.equal(options.method, undefined); assert.equal(options.redirect, 'manual');
        assert.deepEqual(options.headers, { Accept: 'text/html' });
        const config = catalogs.eva.find(config => config.sourceUrl === url);
        assert.ok(config); assert.equal(fetched.has(url), false);
        fetched.add(url); capture.set(url, Date.now());
        active++; peak = Math.max(peak, active);
        await pause(5); active--;
        return new Response(html([cashFare(config)]));
      } });
    assert.equal(rows.length, 50); assert.equal(fetched.size, 50); assert.equal(published.size, 50); assert.equal(peak, 2);
    for (const row of rows) {
      assert.equal(row.error, undefined); assert.equal(row.publication.published, 1);
      assert.equal(row.publication.checkedAt, row.checkedAt); assert.equal(row.checkedAt, published.get(row.url));
      assert.equal(row.fares[0].amount, 13000); assert.equal(row.fares[0].currency, 'TWD');
      assert.equal(row.fares[0].operator, null);
      assert.deepEqual(row.fares[0].upstreamPriceAge, { value: 7, unit: 'hours' });
    }
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'eva-published-observations.json'), 'utf8')), rows);
  });
});

test('EVA default pacing spaces official page starts while publication happens before later collection', async () => {
  await proofDirectory(async outputDirectory => {
    const starts = [], events = [];
    const rows = await collectAsianPublishedPages({ provider: 'eva', key, limit: 2, outputDirectory,
      fetchFn: async (input, options) => {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body); events.push('publish');
          return Response.json({ fares: 1, checkedAt: body.checkedAt });
        }
        starts.push(performance.now()); events.push('fetch');
        return new Response(html([cashFare(catalogs.eva.find(config => config.sourceUrl === String(input)))]));
      } });
    assert.equal(rows.length, 2); assert.ok(starts[1] - starts[0] >= 450);
    assert.deepEqual(events, ['fetch', 'publish', 'fetch', 'publish']);
  });
});

test('failed pages continue, absent schema never clears and receipt failures retain original source records', async () => {
  await proofDirectory(async outputDirectory => {
    let pageCalls = 0, posts = 0;
    const rows = await collectAsianPublishedPages({ provider: 'eva', key, limit: 4, outputDirectory,
      evaMinimumStartGapMs: 0, fetchFn: async (input, options) => {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body); posts++;
          return Response.json({ fares: posts === 1 ? 99 : 1, checkedAt: body.checkedAt });
        }
        pageCalls++;
        if (pageCalls === 1) return new Response('temporarily unavailable', { status: 503 });
        if (pageCalls === 2) return new Response('<html>missing Fare schema</html>');
        return new Response(html([cashFare(catalogs.eva.find(config => config.sourceUrl === String(input)))]));
      } });
    assert.equal(pageCalls, 4); assert.equal(posts, 2);
    assert.equal(rows.filter(row => row.error).length, 3);
    assert.equal(rows[0].error, 'HTTP 503'); assert.equal(rows[1].error, 'No explicit published Fare records');
    const receiptFailure = rows.find(row => row.error === 'Ingestion receipt mismatch');
    assert.ok(receiptFailure.records.length); assert.equal(receiptFailure.fares[0].checkedAt, receiptFailure.checkedAt);
    assert.equal(rows.filter(row => row.publication).length, 1);
  });
});

test('an authentication rejection stops new EVA work and checkpoints the two active captures', async () => {
  await proofDirectory(async outputDirectory => {
    let fetched = 0, posts = 0;
    await assert.rejects(collectAsianPublishedPages({ provider: 'eva', key, outputDirectory,
      evaMinimumStartGapMs: 0, fetchFn: async (input, options) => {
        if (options.method === 'POST') { posts++; return new Response('unauthorized', { status: 401 }); }
        fetched++; await pause(5);
        return new Response(html([cashFare(catalogs.eva.find(config => config.sourceUrl === String(input)))]));
      } }), /Ingestion HTTP 401/);
    assert.ok(fetched <= 2); assert.ok(posts <= 2);
    const checkpoint = JSON.parse(await readFile(join(outputDirectory, 'eva-published-observations.json'), 'utf8'));
    assert.ok(checkpoint.length <= 2); assert.ok(checkpoint.some(row => row.error === 'Ingestion HTTP 401'));
    assert.ok(checkpoint.every(row => row.records.length === 1 && row.publication === undefined));
  });
});

test('EVA deadline bounds collection and does not publish timed-out or unstarted pages', async () => {
  await proofDirectory(async outputDirectory => {
    let calls = 0;
    const start = performance.now();
    const rows = await collectAsianPublishedPages({ provider: 'eva', key, limit: 5, outputDirectory,
      evaMaximumRunMs: 10, evaMinimumStartGapMs: 0, fetchFn: async (_input, options) => {
        calls++; assert.equal(options.method, undefined);
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timed out'))));
      } });
    assert.ok(calls <= 2); assert.equal(rows.length, 5); assert.ok(rows.every(row => row.error));
    assert.ok(performance.now() - start < 500);
    assert.ok(rows.every(row => row.publication === undefined));
  });
});

test('Vietnam retains its one approved page, sequential behavior and independent provider schema', async () => {
  await proofDirectory(async outputDirectory => {
    let posts = 0;
    const rows = await collectAsianPublishedPages({ provider: 'vietnam', key, outputDirectory,
      fetchFn: async (input, options) => {
        if (options.method === 'POST') {
          posts++; const body = JSON.parse(options.body);
          assert.equal(body.airline, 'VN');
          return Response.json({ fares: 1, checkedAt: body.checkedAt });
        }
        return new Response(html([cashFare(catalogs.vietnam.find(config => config.sourceUrl === String(input)), 'vietnam')]));
      } });
    assert.equal(rows.length, 1); assert.equal(posts, 1); assert.equal(rows[0].publication.published, 1);
    assert.throws(() => selectAsianObservedPages('vietnam', 0, 21, true));
  });
});
