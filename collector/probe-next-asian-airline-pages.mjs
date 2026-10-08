import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fareRecords } from './fare-records.mjs';

/** Diagnostic public-page probe. Does not publish, authenticate, or use browser quota. */
const providers = Object.freeze({
  eva: {
    airline: 'BR', host: 'flights.evaair.com', locale: 'en-tw',
    root: 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo',
    economyBrand: 'Economy Basic',
  },
  vietnam: {
    airline: 'VN', host: 'www.vietnamairlines.com', locale: 'en-gb',
    root: 'https://www.vietnamairlines.com/en-gb/flights-from-london-to-hanoi',
    economyBrand: 'Economy Super Lite',
  },
});
const realDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function observedAsianPage(url, provider) {
  const config = providers[provider];
  if (!config) throw new Error('Unsupported diagnostic provider');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== config.host || parsed.port || parsed.username
    || parsed.password || parsed.search || parsed.hash
    || !new RegExp(`^/${config.locale}/flights-from-[a-z-]+$`).test(parsed.pathname)) {
    throw new Error('Unsupported observed official page');
  }
  return parsed;
}

export function normalizeAsianAdvertisements(records, { provider, sourceUrl, checkedAt }) {
  const config = providers[provider];
  observedAsianPage(sourceUrl, provider);
  if (!Array.isArray(records) || records.length > 500 || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error('Invalid observation');
  }
  const today = new Date(checkedAt).toISOString().slice(0, 10), seen = new Set(), fares = [];
  for (const row of records) {
    if (!row || row.__typename !== 'Fare' || row.travelClass !== config.economyBrand
      || row.farenetTravelClass !== 'ECONOMY' || row.formattedTravelClass !== 'Economy'
      || !(row.redemption == null || row.redemption === false) || !(row.promoCode == null || row.promoCode === '')
      || !/^[A-Z]{3}$/.test(row.originAirportCode ?? '') || !/^[A-Z]{3}$/.test(row.destinationAirportCode ?? '')
      || row.originAirportCode === row.destinationAirportCode || !realDate(row.departureDate) || row.departureDate < today
      || typeof row.totalPrice !== 'number' || !Number.isFinite(row.totalPrice) || row.totalPrice <= 0 || row.totalPrice > 1e9
      || !/^[A-Z]{3}$/.test(row.currencyCode ?? '')) continue;
    const oneWay = row.flightType === 'ONE_WAY' && (row.returnDate == null || row.returnDate === '');
    const roundTrip = row.flightType === 'ROUND_TRIP' && realDate(row.returnDate) && row.returnDate > row.departureDate;
    if (!oneWay && !roundTrip) continue;
    let upstreamPriceAge = null;
    const age = row.priceLastSeen;
    const value = typeof age?.value === 'string' && /^\d+$/.test(age.value) ? Number(age.value) : age?.value;
    const unit = ({ minute: 'minutes', minutes: 'minutes', hour: 'hours', hours: 'hours', day: 'days', days: 'days' })[age?.unit];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 36500 && unit) upstreamPriceAge = { value, unit };
    const fare = {
      airline: config.airline, origin: row.originAirportCode, destination: row.destinationAirportCode,
      departDate: row.departureDate, returnDate: roundTrip ? row.returnDate : null,
      structure: oneWay ? 'oneway' : 'roundtrip', amount: row.totalPrice, currency: row.currencyCode,
      displayPrice: typeof row.formattedTotalPrice === 'string' ? row.formattedTotalPrice : null,
      sourceUrl, checkedAt, upstreamPriceAge, pricing: 'published_advertisement', checkoutVerified: false,
      operator: null,
    };
    const key = JSON.stringify([fare.origin, fare.destination, fare.departDate, fare.returnDate, fare.amount, fare.currency]);
    if (!seen.has(key)) { seen.add(key); fares.push(fare); }
  }
  return fares;
}

export function asianObservedLinks(html, sourceUrl, provider) {
  observedAsianPage(sourceUrl, provider);
  const links = new Set();
  for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
    try {
      const url = observedAsianPage(new URL(match[1].replaceAll('&amp;', '&'), sourceUrl).href, provider);
      links.add(url.href);
    } catch { /* Ignore different locales, booking engines, assets, and unobserved routes. */ }
  }
  return [...links].map(url => ({ url, observedOn: sourceUrl }));
}

export async function probeAsianPublicPages({ provider, limit = 10, outputDirectory, fetchFn = fetch }) {
  const config = providers[provider];
  if (!config || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid diagnostic batch');
  if (!outputDirectory) throw new Error('Explicit proof directory required');
  await mkdir(outputDirectory, { recursive: true });
  const queue = [{ url: config.root, observedOn: config.root }], visited = new Set(), observations = [];
  while (queue.length && observations.length < limit) {
    const row = queue.shift();
    if (visited.has(row.url)) continue;
    visited.add(row.url);
    const checkedAt = new Date().toISOString();
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
      const links = asianObservedLinks(html, url.href, provider);
      observations.push({ ...row, checkedAt, bytes, records, fares, links });
      await writeFile(resolve(outputDirectory, `${String(observations.length).padStart(2, '0')}.html`), html);
      queue.push(...links.filter(link => !visited.has(link.url)));
      console.log(JSON.stringify({ provider, page: url.href, records: records.length, fares: fares.length, observedLinks: links.length }));
    } catch (error) {
      observations.push({ ...row, checkedAt, error: error.message });
      console.log(JSON.stringify({ provider, page: row.url, error: error.message }));
    }
    await writeFile(resolve(outputDirectory, `${provider}-page-observations.json`), JSON.stringify(observations, null, 2));
  }
  return observations;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const provider = process.env.NEXT_ASIAN_AIRLINE ?? 'eva';
  const limit = Number(process.env.NEXT_ASIAN_LIMIT ?? 10);
  const outputDirectory = process.env.NEXT_ASIAN_PROOF_DIRECTORY;
  const observations = await probeAsianPublicPages({ provider, limit, outputDirectory });
  if (observations.some(row => row.error)) process.exitCode = 1;
}
