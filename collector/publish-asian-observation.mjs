import { readFile } from 'node:fs/promises';
import { normalizeAsianAdvertisements, observedAsianPage } from './probe-next-asian-airline-pages.mjs';
import { publishPageObservation } from './publish-page-observation.mjs';

const catalogs = {
  eva: JSON.parse(await readFile(new URL('../worker/src/eva-published-catalog.json', import.meta.url), 'utf8')),
  vietnam: JSON.parse(await readFile(new URL('../worker/src/vietnam-published-catalog.json', import.meta.url), 'utf8')),
};
const airlineCodes = { eva: 'BR', vietnam: 'VN' };

/** Publish verbatim Fare records; expected counts include only observed, approved airport pairs. */
export async function publishAsianObservation(observation, key, fetchFn = fetch) {
  const { provider, page, checkedAt, records } = observation;
  observedAsianPage(page, provider);
  const pages = catalogs[provider]?.filter(row => row.sourceUrl === page);
  if (!pages?.length) throw Object.assign(new Error('Unapproved Asian publication page'), { fatal: true });
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt) {
    throw new Error('Invalid original observation timestamp');
  }
  // An empty extraction could mean a challenge or changed page schema, rather than a removed price.
  if (!Array.isArray(records) || !records.length) throw new Error('No explicit published Fare records');
  const fares = normalizeAsianAdvertisements(records, { provider, sourceUrl: page, checkedAt })
    .filter(fare => pages.some(row => row.airline === fare.airline && row.origin === fare.origin && row.destination === fare.destination));
  return publishPageObservation({ airline: airlineCodes[provider], page, checkedAt, records, expectedFares: fares.length }, key, fetchFn);
}

export function asianPublicationPages(provider) {
  if (!catalogs[provider]) throw new Error('Unsupported Asian publication provider');
  return new Set(catalogs[provider].map(row => row.sourceUrl));
}
