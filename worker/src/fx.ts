import type { FxRates, Repo } from "./types";

/**
 * FX to ILS (SPEC §4.2), mirroring engine/tpe/fx.py: Bank of Israel first, open.er-api.com as fallback,
 * cached in D1 per UTC date. If both sources fail the newest stored day is served, marked ":stale".
 * Original amounts are never touched here: rates are only used for comparison/display.
 */

export const BOI_URL = "https://boi.org.il/PublicApi/GetExchangeRates";
export const FALLBACK_URL = "https://open.er-api.com/v6/latest/ILS";
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

const SOURCES: { name: string; url: string; parse: (payload: unknown) => Rates | null }[] = [
  { name: "bank_of_israel", url: BOI_URL, parse: parseBoi },
  { name: "open.er-api.com", url: FALLBACK_URL, parse: parseFallback },
];

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

export async function getFxRates(repo: Repo, fetchFn: typeof fetch, now: Date): Promise<FxRates> {
  const date = now.toISOString().slice(0, 10); // rates are cached per UTC date (24h)

  const cached = await attempt(() => repo.getFxRates(date));
  if (usable(cached)) return cached;

  const failures: string[] = [];
  for (const source of SOURCES) {
    try {
      const rates = source.parse(await fetchJson(fetchFn, source.url));
      if (!rates) throw new Error("unexpected payload");
      const fx: FxRates = { date, source: source.name, ratesToIls: { ...rates, ILS: 1 } };
      await attempt(() => repo.saveFxRates(fx)); // a failed cache write must not lose fresh rates
      return fx;
    } catch (err) {
      failures.push(`${source.name}: ${errorText(err)}`);
    }
  }

  const stale = await attempt(() => repo.getLatestFxRates());
  if (usable(stale)) {
    return { ...stale, source: stale.source.endsWith(":stale") ? stale.source : `${stale.source}:stale` };
  }
  throw new Error(`No FX rates available (${failures.join("; ")})`);
}
