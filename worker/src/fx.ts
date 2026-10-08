import type { FxRates, Repo } from "./types";
import { readFxCache, writeFxCache } from "./fx-cache";

/**
 * FX to ILS (SPEC §4.2), mirroring engine/tpe/fx.py: Bank of Israel first, open.er-api.com as fallback, then the
 * ECB euro reference rates (Worker only; official, free incl. commercial reuse with "Source: ECB statistics.",
 * docs/FLIGHT_API_RESEARCH.md §16), cached in D1 per UTC date. If every source fails the newest stored day is
 * served, marked ":stale". A later source is only asked when the earlier ones failed, so a normal day costs one call.
 * Original amounts are never touched here: rates are only used for comparison/display.
 */

export const BOI_URL = "https://boi.org.il/PublicApi/GetExchangeRates";
export const FALLBACK_URL = "https://open.er-api.com/v6/latest/ILS";
export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const TIMEOUT_MS = 8000;
const CODE = /^[A-Z]{3}$/;

type Rates = Record<string, number>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number > 0 (numeric strings tolerated, booleans/null/"" are not numbers), else null. */
function positive(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** BoI: exchangeRates[{key, currentExchangeRate, unit}], the rate is ILS per `unit` units (JPY unit=100). */
function parseBoi(payload: unknown): Rates | null {
  if (!isRecord(payload) || !Array.isArray(payload.exchangeRates)) return null;
  const rates: Rates = {};
  for (const item of payload.exchangeRates as unknown[]) {
    if (!isRecord(item) || typeof item.key !== "string") continue;
    const code = item.key.trim().toUpperCase();
    if (!CODE.test(code) || code === "ILS") continue;
    const rate = positive(item.currentExchangeRate);
    const unit = item.unit === undefined || item.unit === null ? 1 : positive(item.unit);
    if (rate === null || unit === null) continue; // a malformed entry is dropped, never guessed
    const perUnit = rate / unit;
    if (Number.isFinite(perUnit) && perUnit > 0) rates[code] = perUnit;
  }
  // Same sanity gate as the Python engine: a payload without USD is not a real rate table.
  return rates.USD === undefined ? null : rates;
}

/** open.er-api.com: rates are units of X per 1 ILS, so 1 X = 1/rate ILS. */
function parseFallback(payload: unknown): Rates | null {
  if (!isRecord(payload) || !isRecord(payload.rates)) return null;
  if (payload.result !== undefined && payload.result !== "success") return null;
  const rates: Rates = {};
  for (const [key, value] of Object.entries(payload.rates)) {
    const code = key.trim().toUpperCase();
    if (!CODE.test(code) || code === "ILS") continue;
    const perIls = positive(value);
    if (perIls === null) continue;
    const toIls = 1 / perIls;
    if (Number.isFinite(toIls) && toIls > 0) rates[code] = toIls;
  }
  return rates.USD === undefined ? null : rates;
}

/** One attribute of an XML start tag, single or double quoted. */
const xmlAttr = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)")`).exec(attrs)?.slice(1).find((v) => v !== undefined) ?? null;

/**
 * ECB eurofxref-daily.xml: <Cube currency='USD' rate='1.1355'/> = units of X per 1 EUR, including ILS.
 * So 1 EUR = rate(ILS) ILS and 1 X = rate(ILS) / rate(X) ILS. Without an ILS or USD rate it is not a usable table.
 */
export function parseEcb(payload: unknown): Rates | null {
  if (typeof payload !== "string") return null;
  const perEur: Rates = {};
  for (const m of payload.matchAll(/<(?:[\w-]+:)?Cube\b([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    const code = xmlAttr(attrs, "currency")?.trim().toUpperCase() ?? "";
    const rate = positive(xmlAttr(attrs, "rate"));
    if (CODE.test(code) && rate !== null && perEur[code] === undefined) perEur[code] = rate;
  }
  const ils = perEur.ILS;
  if (ils === undefined) return null;
  const rates: Rates = { EUR: ils };
  for (const [code, perEurRate] of Object.entries(perEur)) {
    if (code === "ILS" || code === "EUR") continue;
    const toIls = ils / perEurRate;
    if (Number.isFinite(toIls) && toIls > 0) rates[code] = toIls;
  }
  return rates.USD === undefined ? null : rates;
}

/**
 * The day an ECB file is for: <Cube time='YYYY-MM-DD'>. The ECB publishes on working days only, so on weekends,
 * holidays and before ~16:00 CET this is an earlier day than today. A file without a valid date is not trusted.
 */
export function ecbRatesDate(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  for (const m of payload.matchAll(/<(?:[\w-]+:)?Cube\b([^>]*)>/g)) {
    const time = xmlAttr(m[1] ?? "", "time")?.trim() ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(time) && time === new Date(`${time}T00:00:00Z`).toISOString().slice(0, 10)) return time;
  }
  return null;
}

const SOURCES: {
  name: string;
  url: string;
  format: "json" | "xml";
  parse: (payload: unknown) => Rates | null;
  /** The day the rates are for, when the source says so; absent = the source serves today's rates. */
  asOf?: (payload: unknown) => string | null;
}[] = [
  { name: "bank_of_israel", url: BOI_URL, format: "json", parse: parseBoi },
  { name: "open.er-api.com", url: FALLBACK_URL, format: "json", parse: parseFallback },
  { name: "ecb", url: ECB_URL, format: "xml", parse: parseEcb, asOf: ecbRatesDate },
];

async function fetchPayload(fetchFn: typeof fetch, url: string, format: "json" | "xml"): Promise<unknown> {
  const accept = format === "json" ? "application/json" : "application/xml, text/xml";
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return format === "json" ? res.json() : res.text();
}

/** Stored/served rates must have the basics or they are treated as missing. */
function usable(fx: FxRates | null): fx is FxRates {
  return fx !== null && isRecord(fx.ratesToIls) && fx.ratesToIls.ILS === 1 && positive(fx.ratesToIls.USD) !== null;
}

/** Storage trouble must degrade to "fetch anyway", never fail the search. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

const markStale = (fx: FxRates): FxRates => ({ ...fx, source: fx.source.endsWith(":stale") ? fx.source : `${fx.source}:stale` });

/**
 * Rates a source published for an EARLIER day (the ECB on a weekend): never stored or served as today's. They are
 * kept under their own day (only if that day has no row yet, so a Bank of Israel row is never overwritten) and served
 * marked ":stale", unless the newest stored day is at least as recent, which then wins.
 */
async function olderDay(repo: Repo, fx: FxRates): Promise<FxRates> {
  const stored = await attempt(() => repo.getLatestFxRates());
  if (usable(stored) && stored.date >= fx.date) return markStale(stored);
  const sameDay = await attempt(() => repo.getFxRates(fx.date));
  if (!usable(sameDay)) await attempt(() => repo.saveFxRates(fx));
  return markStale(fx);
}

async function loadFxRates(repo: Repo, fetchFn: typeof fetch, now: Date): Promise<FxRates> {
  const date = now.toISOString().slice(0, 10); // rates are cached per UTC date (24h)

  const cached = await attempt(() => repo.getFxRates(date));
  if (usable(cached)) return cached;

  const failures: string[] = [];
  for (const source of SOURCES) {
    try {
      const payload = await fetchPayload(fetchFn, source.url, source.format);
      const rates = source.parse(payload);
      if (!rates) throw new Error("unexpected payload");
      const asOf = source.asOf ? source.asOf(payload) : date;
      if (asOf === null) throw new Error("no rates date");
      if (asOf < date) return await olderDay(repo, { date: asOf, source: source.name, ratesToIls: { ...rates, ILS: 1 } });
      const fx: FxRates = { date, source: source.name, ratesToIls: { ...rates, ILS: 1 } };
      await attempt(() => repo.saveFxRates(fx)); // a failed cache write must not lose fresh rates
      return fx;
    } catch (err) {
      failures.push(`${source.name}: ${errorText(err)}`);
    }
  }

  const stale = await attempt(() => repo.getLatestFxRates());
  if (usable(stale)) return markStale(stale);
  throw new Error(`No FX rates available (${failures.join("; ")})`);
}

/** Skip D1 and upstream FX calls when a valid public edge-cache entry exists. */
const pendingRates = new WeakMap<object, Map<string, Promise<FxRates>>>();
export async function getFxRates(repo: Repo, fetchFn: typeof fetch, now: Date, storage?: Pick<Cache, "match" | "put">): Promise<FxRates> {
  const hit = await readFxCache(storage, now);
  if (hit) return hit;
  if (!storage) return loadFxRates(repo, fetchFn, now);
  let pending = pendingRates.get(storage);
  if (!pending) { pending = new Map(); pendingRates.set(storage, pending); }
  const date = now.toISOString().slice(0,10);
  const existing = pending.get(date);
  if (existing) return existing;
  const work = (async () => {
    const rates = await loadFxRates(repo, fetchFn, now);
    await writeFxCache(storage, now, rates);
    return rates;
  })();
  pending.set(date, work);
  try { return await work; } finally { pending.delete(date); }
}
