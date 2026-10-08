import {FALLBACK_URL} from './fx';
import {readFxCache, writeFxCache} from './fx-cache';
import type {FxRates} from './types';

type Storage = Pick<Cache, 'match' | 'put'>;
interface ExoticRates extends FxRates {publishedAt: string}
const MAX_AGE_MS = 7 * 86_400_000;
const SUPPORTED = new Set(['AED', 'TWD']);
const pending = new WeakMap<object, {hour: number; result: Promise<ExoticRates | null>}>();
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Official endpoint documentation: https://www.exchangerate-api.com/docs/free .
 * Rates are currency units per ILS. Both original publication timestamps must agree.
 * This provider requires a linked attribution wherever its converted rates are used.
 */
function parseRates(value: unknown, now: Date): ExoticRates | null {
  if (!record(value) || value.result !== 'success' || value.base_code !== 'ILS' || !record(value.rates)
    || value.rates.ILS !== 1 || !positive(value.rates.USD) || !Number.isSafeInteger(value.time_last_update_unix)
    || typeof value.time_last_update_utc !== 'string') return null;
  const published = (value.time_last_update_unix as number) * 1000;
  const utc = Date.parse(value.time_last_update_utc);
  if (!Number.isFinite(published) || published <= 0 || !Number.isFinite(utc) || published !== utc) return null;
  // Date.parse alone normalizes impossible dates; require the source's UTC calendar text to round-trip.
  const canonical = new Date(published).toUTCString();
  if (![canonical, canonical.replace(/GMT$/, '+0000')].includes(value.time_last_update_utc)) return null;
  const age = now.getTime() - published;
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null;
  const ratesToIls: Record<string, number> = {ILS: 1, USD: 1 / value.rates.USD};
  if (!positive(ratesToIls.USD)) return null;
  for (const code of SUPPORTED) {
    const perIls = value.rates[code];
    if (positive(perIls) && positive(1 / perIls)) ratesToIls[code] = 1 / perIls;
  }
  if (![...SUPPORTED].some(code => ratesToIls[code] !== undefined)) return null;
  const publishedAt = new Date(published).toISOString();
  const date = publishedAt.slice(0, 10);
  return {date, source: `open.er-api.com${date < now.toISOString().slice(0, 10) ? ':stale' : ''}`, ratesToIls, publishedAt};
}

function cachedRates(fx: FxRates | null, now: Date): ExoticRates | null {
  if (!fx || !('publishedAt' in fx) || typeof fx.publishedAt !== 'string') return null;
  const published = Date.parse(fx.publishedAt);
  const age = now.getTime() - published;
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS || new Date(published).toISOString() !== fx.publishedAt
    || fx.publishedAt.slice(0, 10) !== fx.date || !/^open\.er-api\.com(?::stale)?$/.test(fx.source)) return null;
  return fx as ExoticRates;
}

/** Add only requested missing AED/TWD rates; preserve primary values and the oldest publication day. */
export async function supplementExoticFx(base: FxRates, required: readonly string[], fetchFn: typeof fetch,
  now: Date, storage?: Storage): Promise<FxRates> {
  const missing = [...new Set(required.filter(code => SUPPORTED.has(code) && base.ratesToIls[code] === undefined))];
  if (!missing.length || !Number.isFinite(now.getTime())) return base;
  const load = async (): Promise<ExoticRates | null> => {
    const cached = cachedRates(await readFxCache(storage, now, 'exotic'), now);
    if (cached) return cached;
    try {
      const response = await fetchFn(FALLBACK_URL, {redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: {accept: 'application/json'}});
      if (!response.ok || !response.body) return null;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 32_000) return null;
          chunks.push(part.value);
        }
      } finally {
        try {await reader.cancel();} catch { /* Parsing a completed body needs no retry. */ }
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      const rates = parseRates(JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes)), now);
      if (!rates) return null;
      await writeFxCache(storage, now, rates, 'exotic');
      return rates;
    } catch {return null;}
  };
  const key = storage ?? fetchFn, hour = Math.floor(now.getTime() / 3_600_000);
  if (pending.get(key)?.hour !== hour) pending.set(key, {hour, result: load()});
  // A shared pending table can outlive its source timestamp near the seven-day boundary.
  const extra = cachedRates(await pending.get(key)!.result, now);
  if (!extra) return base;
  const additions = Object.fromEntries(missing.filter(code => positive(extra.ratesToIls[code]))
    .map(code => [code, extra.ratesToIls[code]!]));
  if (!Object.keys(additions).length) return base;
  const date = base.date < extra.date ? base.date : extra.date;
  return {...base, date, source: `${base.source.replace(/:stale$/, '')}+open.er-api.com${date < now.toISOString().slice(0, 10) ? ':stale' : ''}`,
    ratesToIls: {...base.ratesToIls, ...additions}};
}
