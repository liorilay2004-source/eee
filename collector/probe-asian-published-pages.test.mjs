import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectAsianPublishedPages, selectAsianObservedPages } from './probe-asian-published-pages.mjs';
test('publication selects only empirically approved pages while diagnostic selection supports the broader observed inventory', () => {
  assert.equal(selectAsianObservedPages('eva', 0, 20, true).length, 10);
  assert.equal(selectAsianObservedPages('eva', 100, 20, false).length, 16);
  assert.equal(selectAsianObservedPages('vietnam', 0, 20, true).length, 1);
  assert.throws(() => selectAsianObservedPages('eva', 0, 21));
  assert.throws(() => selectAsianObservedPages('eva', 11, 1, true));
});
test('checkpoints raw observations before later failures and does not convert a failed page into a successful empty publication', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'asian-fare-collector-'));
  try {
    let calls = 0;
    const rows = await collectAsianPublishedPages({ provider: 'eva', limit: 2, outputDirectory, fetchFn: async () => {
      if (++calls === 1) return new Response('<script id="__NEXT_DATA__">{"props":{"fares":[]}}</script>');
      return new Response('unavailable', { status: 503 });
    } });
    assert.equal(rows.length, 2); assert.deepEqual(rows[0].records, []); assert.deepEqual(rows[0].fares, []);
    assert.equal(rows[1].error, 'HTTP 503'); assert.equal(rows[1].publication, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'eva-published-observations.json'), 'utf8')), rows);
  } finally {
    assert.ok(resolve(outputDirectory).startsWith(resolve(join(tmpdir(), 'asian-fare-collector-'))));
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
test('authenticated missing-page schema fails without publishing an empty cache clearing snapshot', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'asian-fare-collector-'));
  try {
    let calls = 0;
    const rows = await collectAsianPublishedPages({ provider: 'eva', limit: 1, outputDirectory, key: 'a'.repeat(64),
      fetchFn: async (url, options) => { calls++; assert.equal(options.method, undefined); return new Response('<html>Changed page or challenge</html>'); } });
    assert.equal(calls, 1); assert.equal(rows[0].error, 'No explicit published Fare records');
    assert.equal(rows[0].publication, undefined);
  } finally {
    assert.ok(resolve(outputDirectory).startsWith(resolve(join(tmpdir(), 'asian-fare-collector-'))));
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
