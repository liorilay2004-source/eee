import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fareRecords } from './fare-records.mjs';
import { asianObservedLinks, normalizeAsianAdvertisements, observedAsianPage } from './probe-next-asian-airline-pages.mjs';
import { asianPublicationPages, publishAsianObservation } from './publish-asian-observation.mjs';

const inventories = {
  eva: JSON.parse(await readFile(new URL('./eva-observed-pages.json', import.meta.url), 'utf8')),
  vietnam: JSON.parse(await readFile(new URL('./vietnam-observed-pages.json', import.meta.url), 'utf8')),
};

export function selectAsianObservedPages(provider, offset = 0, limit = 20, publish = false) {
  const inventory = inventories[provider];
  if (!inventory) throw new Error('Unsupported Asian publication provider');
  const approved = asianPublicationPages(provider);
  const selection = publish ? inventory.filter(row => approved.has(row.url)) : inventory;
  if (!Number.isInteger(offset) || offset < 0 || offset > selection.length || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Invalid Asian observation batch');
  }
  const urls = new Set();
  for (const row of selection) {
    const url = observedAsianPage(row.url, provider), parent = observedAsianPage(row.observedOn, provider);
    if (url.origin !== parent.origin || urls.has(url.href)) throw new Error('Invalid observed inventory');
    urls.add(url.href);
  }
  return selection.slice(offset, offset + limit);
}

/** With a key, refreshes only currently approved pages. Discovery can inspect the wider actual link inventory. */
export async function collectAsianPublishedPages({ provider, offset = 0, limit = 20, key, outputDirectory = '.', fetchFn = fetch }) {
  if (key && !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid collector configuration');
  const pages = selectAsianObservedPages(provider, offset, limit, Boolean(key));
  const results = [];
  await mkdir(outputDirectory, { recursive: true });
  const checkpoint = () => writeFile(resolve(outputDirectory, `${provider}-published-observations.json`), JSON.stringify(results, null, 2));
  for (const row of pages) {
    const checkedAt = new Date().toISOString(); let observation;
    try {
      const url = observedAsianPage(row.url, provider);
      const response = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html' } });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2_000_000) throw new Error('Official page size limit'); chunks.push(part.value); }
      } finally { await reader.cancel(); }
      const html = Buffer.concat(chunks).toString('utf8'), records = fareRecords(html);
      const fares = normalizeAsianAdvertisements(records, { provider, sourceUrl: url.href, checkedAt });
      observation = { ...row, checkedAt, bytes, records, fares, links: asianObservedLinks(html, url.href, provider) };
      if (key && !records.length) throw new Error('No explicit published Fare records');
      if (key) observation.publication = await publishAsianObservation({ provider, page: url.href, checkedAt, records }, key, fetchFn);
      results.push(observation);
      console.log(JSON.stringify({ provider, page: row.url, records: records.length, fares: fares.length, ...observation.publication }));
    } catch (error) {
      results.push({ ...(observation ?? row), checkedAt, error: error.message });
      console.log(JSON.stringify({ provider, page: row.url, error: error.message }));
      await checkpoint();
      if (error.fatal) throw error;
    }
    await checkpoint();
  }
  return results;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const results = await collectAsianPublishedPages({ provider: process.env.ASIAN_PUBLIC_PROVIDER,
    offset: Number(process.env.ASIAN_PUBLIC_OFFSET ?? 0), limit: Number(process.env.ASIAN_PUBLIC_LIMIT ?? 20),
    key: process.env.COLLECTOR_KEY, outputDirectory: process.env.ASIAN_PUBLIC_OUTPUT_DIRECTORY ?? '.' });
  if (results.some(row => row.error)) process.exitCode = 1;
}
