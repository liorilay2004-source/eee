import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fareRecords } from './fare-records.mjs';
import { asianObservedLinks, normalizeAsianAdvertisements, observedAsianPage } from './probe-next-asian-airline-pages.mjs';
import { asianPublicationPages, publishAsianObservation } from './publish-asian-observation.mjs';
import { selectEvaBatch } from './eva-batch.mjs';

const inventories = {
  eva: JSON.parse(await readFile(new URL('./eva-observed-pages.json', import.meta.url), 'utf8')),
  vietnam: JSON.parse(await readFile(new URL('./vietnam-observed-pages.json', import.meta.url), 'utf8')),
};
const evaCatalog = JSON.parse(await readFile(new URL('../worker/src/eva-published-catalog.json', import.meta.url), 'utf8'));

export function selectAsianObservedPages(provider, offset = 0, limit = 20, publish = false) {
  const inventory = inventories[provider];
  if (!inventory) throw new Error('Unsupported Asian publication provider');
  const approved = asianPublicationPages(provider);
  const selection = publish ? inventory.filter(row => approved.has(row.url)) : inventory;
  const maximum = provider === 'eva' && publish ? 50 : 20;
  if (!Number.isInteger(offset) || offset < 0 || offset > selection.length || !Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error('Invalid Asian observation batch');
  }
  const urls = new Set();
  for (const row of selection) {
    const url = observedAsianPage(row.url, provider), parent = observedAsianPage(row.observedOn, provider);
    if (url.origin !== parent.origin || urls.has(url.href)) throw new Error('Invalid observed inventory');
    urls.add(url.href);
  }
  return provider === 'eva' && publish ? selectEvaBatch(inventory, evaCatalog, { cursor: offset, limit }).pages
    : selection.slice(offset, offset + limit);
}

/** With a key, refreshes only currently approved pages. Discovery can inspect the wider actual link inventory. */
export async function collectAsianPublishedPages({ provider, offset = 0, limit, key, outputDirectory = '.', fetchFn = fetch,
  evaMaximumRunMs = 260_000, evaMinimumStartGapMs = 500 }) {
  if (key && !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid collector configuration');
  const isEva = provider === 'eva';
  if (isEva && (!Number.isInteger(evaMaximumRunMs) || evaMaximumRunMs < 1 || evaMaximumRunMs > 260_000
    || !Number.isInteger(evaMinimumStartGapMs) || evaMinimumStartGapMs < 0 || evaMinimumStartGapMs > 2000)) {
    throw new Error('Invalid bounded EVA refresh');
  }
  const pages = selectAsianObservedPages(provider, offset, limit ?? (isEva && key ? 50 : 20), Boolean(key));
  const results = new Array(pages.length);
  await mkdir(outputDirectory, { recursive: true });
  let checkpointWrites = Promise.resolve(), fatalError = null, checkpointRevision = 0;
  const checkpointPath = resolve(outputDirectory, `${provider}-published-observations.json`);
  const checkpoint = () => {
    checkpointWrites = checkpointWrites.then(async () => {
      const temporaryPath=`${checkpointPath}.${++checkpointRevision}.tmp`;
      try{
        await writeFile(temporaryPath, JSON.stringify(results.filter(Boolean), null, 2));
        for(let attempt=0;;attempt++){
          try{await rename(temporaryPath,checkpointPath);break;}
          catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error?.code)||attempt>=9)throw error;await new Promise(resolveWait=>setTimeout(resolveWait,10*(attempt+1)));}
        }
      }finally{await rm(temporaryPath,{force:true});}
    });
    return checkpointWrites;
  };
  const started = performance.now();
  const request = isEva ? (url, options) => {
    const remaining = evaMaximumRunMs - (performance.now() - started);
    if (remaining <= 0) throw new Error('EVA refresh deadline reached');
    return fetchFn(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))]) });
  } : fetchFn;
  async function collectPage(row, index) {
    const checkedAt = new Date().toISOString(); let observation;
    try {
      if (isEva && performance.now() - started >= evaMaximumRunMs) throw new Error('EVA refresh deadline reached');
      const url = observedAsianPage(row.url, provider);
      const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(isEva ? 10000 : 15000), headers: { Accept: 'text/html' } });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2_000_000) throw new Error('Official page size limit'); chunks.push(part.value); }
      } finally { await reader.cancel(); }
      const html = Buffer.concat(chunks).toString('utf8'), records = fareRecords(html);
      const fares = normalizeAsianAdvertisements(records, { provider, sourceUrl: url.href, checkedAt });
      observation = { ...row, checkedAt, bytes, records, fares, links: asianObservedLinks(html, url.href, provider) };
      // Persist the original capture before publication, so a timeout cannot lose observed source data.
      results[index] = observation;
      await checkpoint();
      if (key && !records.length) throw new Error('No explicit published Fare records');
      if (fatalError) throw new Error('Publication stopped after authentication failure');
      if (key) observation.publication = await publishAsianObservation({ provider, page: url.href, checkedAt, records }, key, request);
      console.log(JSON.stringify({ provider, page: row.url, records: records.length, fares: fares.length, ...observation.publication }));
    } catch (error) {
      results[index] = { ...(observation ?? row), checkedAt, error: error.message };
      console.log(JSON.stringify({ provider, page: row.url, error: error.message }));
      if (error.fatal) fatalError = error;
      await checkpoint();
    }
    await checkpoint();
  }
  if (isEva) {
    let nextIndex = 0, nextStart = 0, gate = Promise.resolve();
    const reserveStart = () => {
      gate = gate.then(async () => {
        const remaining = evaMaximumRunMs - (performance.now() - started);
        const delay = Math.min(Math.max(0, nextStart - performance.now()), Math.max(0, remaining));
        if (delay) await new Promise(resolveWait => setTimeout(resolveWait, delay));
        nextStart = performance.now() + evaMinimumStartGapMs;
      });
      return gate;
    };
    async function lane() {
      while (!fatalError) {
        const index = nextIndex++;
        if (index >= pages.length) return;
        if (performance.now() - started < evaMaximumRunMs) await reserveStart();
        if (fatalError) return;
        await collectPage(pages[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, pages.length) }, lane));
  } else {
    for (let index = 0; index < pages.length && !fatalError; index++) await collectPage(pages[index], index);
  }
  await checkpointWrites;
  if (fatalError) throw fatalError;
  return results.filter(Boolean);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const results = await collectAsianPublishedPages({ provider: process.env.ASIAN_PUBLIC_PROVIDER,
    offset: Number(process.env.ASIAN_PUBLIC_OFFSET ?? 0),
    ...(process.env.ASIAN_PUBLIC_LIMIT === undefined ? {} : { limit: Number(process.env.ASIAN_PUBLIC_LIMIT) }),
    key: process.env.COLLECTOR_KEY, outputDirectory: process.env.ASIAN_PUBLIC_OUTPUT_DIRECTORY ?? '.' });
  if (results.some(row => row.error)) process.exitCode = 1;
}
