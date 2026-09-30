/**
 * Hebrew country names and country currencies. Pure lookups over a bundled table, so the Worker makes ZERO runtime
 * calls for them:
 *
 *   countries.json is written by scripts/gen-countries.mjs from Unicode CLDR (cldr-json npm packages, pinned version).
 *   Licence: Unicode License V3; the copyright and permission notice is in worker/THIRD_PARTY_NOTICES, and responses
 *   that show a Hebrew country name carry COUNTRIES_ATTRIBUTION.
 *
 * Every lookup is case-insensitive and returns null for unknown or malformed input.
 */
import countriesJson from "./countries.json";

export const COUNTRIES_ATTRIBUTION = "Unicode CLDR, Unicode License V3";

export interface CountryInfo {
  nameHe: string;
  /** ISO 4217 code of the current legal tender, or null when CLDR lists none (e.g. Antarctica). */
  currency: string | null;
  /** Hebrew name of `currency`, or null. */
  currencyHe: string | null;
}

const COUNTRIES: Readonly<Record<string, CountryInfo>> = countriesJson.countries as Record<string, CountryInfo>;

/** Hebrew currency names by ISO 4217 code, from the same table (only currencies some country uses today). */
const CURRENCY_HE: ReadonlyMap<string, string> = new Map(
  Object.values(COUNTRIES).flatMap((c): [string, string][] => (c.currency && c.currencyHe ? [[c.currency, c.currencyHe]] : [])),
);

/** CLDR version the bundled table was built from, e.g. "48.2.0". */
export const COUNTRIES_CLDR_VERSION: string = countriesJson.version;

function norm(code: unknown, len: number): string | null {
  if (typeof code !== "string") return null;
  const up = code.trim().toUpperCase();
  return up.length === len && /^[A-Z]+$/.test(up) ? up : null;
}

/** The table row for an ISO 3166-1 alpha-2 code ("fr", "FR"), or null. */
export function countryInfo(cc: unknown): CountryInfo | null {
  const k = norm(cc, 2);
  return k !== null && Object.prototype.hasOwnProperty.call(COUNTRIES, k) ? (COUNTRIES[k] ?? null) : null;
}

/** "FR" -> "צרפת"; null when unknown. */
export function countryNameHe(cc: unknown): string | null {
  return countryInfo(cc)?.nameHe ?? null;
}

/**
 * "GR" -> "EUR"; null when unknown or when the country has no current currency in CLDR. Where CLDR lists several
 * current tenders the first listed is returned, which is not always the one used day to day (PA -> PAB, not USD;
 * LS -> ZAR). A label, not a price-display currency: add an override before using it for prices.
 */
export function currencyOf(cc: unknown): string | null {
  return countryInfo(cc)?.currency ?? null;
}

/** "EUR" -> "אירו"; null for a code no country in the table uses. */
export function currencyNameHe(code: unknown): string | null {
  const k = norm(code, 3);
  return k === null ? null : (CURRENCY_HE.get(k) ?? null);
}
