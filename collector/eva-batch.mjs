import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fareRecords } from './fare-records.mjs';
import { normalizeAsianAdvertisements, observedAsianPage } from './probe-next-asian-airline-pages.mjs';

const REPOSITORY = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_PAGES = 50;
const MAX_BYTES = 2_000_000;
export const EVA_CAPTURE_TTL_MS = 600_000;

function validatedInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length > 500) throw new Error('Invalid observed EVA inventory');
  const seen = new Set();
  return inventory.map(row => {
    const url = observedAsianPage(row?.url, 'eva').href;
    const parent = observedAsianPage(row?.observedOn, 'eva').href;
    if (seen.has(url)) throw new Error('Duplicate observed EVA page');
    seen.add(url);
    return { url, observedOn: parent };
  });
}

/** Route identities come only from actual valid Fare records; no amounts enter the proposed catalog. */
export function observedEvaCatalog(observations, inventory) {
  const pages = new Map(validatedInventory(inventory).map(row => [row.url, row]));
  if (!Array.isArray(observations)) throw new Error('Invalid EVA observations');
  const identities = new Map();
  for (const observation of observations) {
    if (observation?.error || !pages.has(observation?.url)) continue;
    const checkedAt = observation.checkedAt;
    if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))
      || new Date(checkedAt).toISOString() !== checkedAt) throw new Error('Invalid original EVA capture');
    const fares = normalizeAsianAdvertisements(observation.records, { provider: 'eva', sourceUrl: observation.url, checkedAt });
    for (const fare of fares) {
      const row = { airline: 'BR', origin: fare.origin, destination: fare.destination,
        sourceUrl: fare.sourceUrl, collector: 'eva' };
      identities.set(JSON.stringify([row.sourceUrl, row.origin, row.destination]), row);
    }
  }
  return [...identities.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)
    || a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination));
}

/** Circular selection advances across the whole approved inventory rather than starving later pages. */
export function selectEvaBatch(inventory, catalog, { cursor = 0, limit = 20 } = {}) {
  const observed = validatedInventory(inventory);
  if (!Array.isArray(catalog) || catalog.length > 1000) throw new Error('Invalid EVA catalog');
  const observedUrls = new Set(observed.map(row => row.url));
  const approved = new Set();
  for (const row of catalog) {
    const url = observedAsianPage(row?.sourceUrl, 'eva').href;
    if (row.airline !== 'BR' || row.collector !== 'eva' || !/^[A-Z]{3}$/.test(row.origin ?? '')
      || !/^[A-Z]{3}$/.test(row.destination ?? '') || row.origin === row.destination || !observedUrls.has(url)) {
      throw new Error('Unobserved EVA catalog identity');
    }
    approved.add(url);
  }
  const pages = observed.filter(row => approved.has(row.url));
  if (!pages.length || pages.length > MAX_PAGES || !Number.isSafeInteger(cursor) || cursor < 0
    || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGES) throw new Error('Invalid EVA batch');
  const count = Math.min(limit, pages.length), start = cursor % pages.length;
  return { pages: Array.from({ length: count }, (_, index) => pages[(start + index) % pages.length]),
    totalPages: pages.length, nextCursor: (start + count) % pages.length };
}

/** Maximum capture gap includes run jitter. It must be strictly below the original ten-minute TTL. */
export function evaCadence({ pageCount, batchSize = 20, intervalMs = 300_000, maximumRunMs = 270_000 }) {
  if (![pageCount, batchSize].every(n => Number.isInteger(n) && n > 0 && n <= MAX_PAGES)
    || ![intervalMs, maximumRunMs].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid EVA cadence');
  const runsPerCycle = Math.ceil(pageCount / batchSize);
  const maximumCaptureGapMs = runsPerCycle * intervalMs + maximumRunMs;
  return { runsPerCycle, maximumCaptureGapMs, freshForAllPages: maximumCaptureGapMs < EVA_CAPTURE_TTL_MS,
    freshnessMarginMs: EVA_CAPTURE_TTL_MS - maximumCaptureGapMs };
}

function safeOutput(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !outputDirectory) throw new Error('Outside-repository proof directory required');
  const path = resolve(outputDirectory);
  if (path.toLowerCase() === REPOSITORY.toLowerCase()
    || path.toLowerCase().startsWith((REPOSITORY + sep).toLowerCase())) throw new Error('EVA proof must stay outside the repository');
  return path;
}

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

/** Read-only timing probe. Never reads credentials or publishes observations. At most two normal HTTP requests in flight. */
export async function collectEvaBatch({ inventory, catalog, cursor = 0, limit = 20, concurrency = 2,
  requestTimeoutMs = 10_000, maximumRunMs = 270_000, minimumStartGapMs = 500, outputDirectory, fetchFn = fetch }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000
    || !Number.isInteger(maximumRunMs) || maximumRunMs < 1 || maximumRunMs > 270_000
    || !Number.isInteger(minimumStartGapMs) || minimumStartGapMs < 0 || minimumStartGapMs > 2000) {
    throw new Error('Invalid bounded EVA collection');
  }
  const batch = selectEvaBatch(inventory, catalog, { cursor, limit });
  const output = safeOutput(outputDirectory);
  await mkdir(output, { recursive: true });
  const startedAt = new Date().toISOString(), start = performance.now();
  const observations = new Array(batch.pages.length);
  let index = 0, active = 0, peakConcurrency = 0, nextStart = 0, gate = Promise.resolve(), checkpoints = Promise.resolve();
  const checkpoint = () => {
    checkpoints = checkpoints.then(() => writeFile(resolve(output, 'eva-batch-observations.json'),
      JSON.stringify(observations.filter(Boolean), null, 2)));
    return checkpoints;
  };
  async function reserveStart() {
    const slot = gate.then(async () => {
      const delay = Math.max(0, nextStart - performance.now());
      const remaining = maximumRunMs - (performance.now() - start);
      if (remaining <= 0) return;
      if (delay) await wait(Math.min(delay, remaining));
      nextStart = performance.now() + minimumStartGapMs;
    });
    gate = slot;
    await slot;
  }
  async function page(row) {
    const checkedAt = new Date().toISOString(), begun = performance.now();
    const remaining = maximumRunMs - (begun - start);
    if (remaining <= 0) return { ...row, checkedAt, error: 'Run deadline reached', durationMs: 0 };
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Public page timeout')); }, Math.min(requestTimeoutMs, remaining));
    });
    const request = (async () => {
      const response = await fetchFn(observedAsianPage(row.url, 'eva'),
        { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html' } });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('Missing public page body');
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > MAX_BYTES) throw new Error('Official page size limit');
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      const records = fareRecords(Buffer.concat(chunks).toString('utf8'));
      const fares = normalizeAsianAdvertisements(records, { provider: 'eva', sourceUrl: row.url, checkedAt });
      const approved = catalog.filter(config => config.sourceUrl === row.url);
      return { ...row, checkedAt, bytes, records, fares,
        matchingApprovedFares: fares.filter(fare => approved.some(config => config.origin === fare.origin
          && config.destination === fare.destination)).length };
    })();
    try {
      return { ...await Promise.race([request, timeout]), durationMs: Math.round(performance.now() - begun) };
    } catch (error) {
      return { ...row, checkedAt, error: error.message, durationMs: Math.round(performance.now() - begun) };
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function lane() {
    for (;;) {
      const at = index++;
      if (at >= batch.pages.length) return;
      if (performance.now() - start < maximumRunMs) await reserveStart();
      if (performance.now() - start >= maximumRunMs) {
        observations[at] = { ...batch.pages[at], error: 'Run deadline reached', checkedAt: new Date().toISOString(), durationMs: 0 };
      } else {
        active++;
        peakConcurrency = Math.max(peakConcurrency, active);
        try { observations[at] = await page(batch.pages[at]); }
        finally { active--; }
      }
      await checkpoint();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.pages.length) }, lane));
  await checkpoints;
  const completedAt = new Date().toISOString(), durationMs = Math.round(performance.now() - start);
  const good = observations.filter(row => !row.error);
  const summary = { startedAt, completedAt, durationMs, requestedPages: batch.pages.length, totalApprovedPages: batch.totalPages,
    successfulPages: good.length, pagesWithValidFares: good.filter(row => row.fares.length).length,
    failures: observations.filter(row => row.error).length, peakConcurrency, nextCursor: batch.nextCursor,
    records: good.reduce((sum, row) => sum + row.records.length, 0), validFares: good.reduce((sum, row) => sum + row.fares.length, 0),
    matchingApprovedFares: good.reduce((sum, row) => sum + row.matchingApprovedFares, 0),
    bytes: good.reduce((sum, row) => sum + row.bytes, 0), maximumRunMs, requestTimeoutMs, minimumStartGapMs,
    oldestCaptureAgeAtCompletionMs: Math.max(0, ...observations.map(row => Date.parse(completedAt) - Date.parse(row.checkedAt))) };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  return { observations, summary };
}
