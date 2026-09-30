#!/usr/bin/env node
/**
 * Builds src/countries/countries.json: Hebrew country names and each country's current currency (with its Hebrew
 * name), from the Unicode CLDR JSON packages. The Worker reads the bundled file only (countries/countries.ts), so it
 * makes ZERO runtime calls for country names.
 *
 *   node scripts/gen-countries.mjs
 *
 * On Node 22 behind an HTTPS proxy, run it with NODE_USE_ENV_PROXY=1 so fetch() uses HTTPS_PROXY.
 *
 * Source: the cldr-json npm packages (https://github.com/unicode-org/cldr-json), pinned to CLDR_VERSION and read from
 * the jsDelivr npm CDN. Licence: Unicode License V3 (https://www.unicode.org/license.txt); redistribution is allowed
 * with the copyright and permission notice, which worker/THIRD_PARTY_NOTICES carries. This script makes exactly 3
 * requests, one after the other, no retries: a failed call stops the script and nothing is written.
 *
 * Output: only ISO 3166-1 alpha-2 style region codes (two capital letters). Dropped: numeric UN M.49 groupings
 * ("001", "150"...), "-alt-" name variants, and the two-letter codes that are not a country or territory (NOT_REGIONS).
 * currency = the region's first currency in currencyData with a _from on or before the run date, no _to, and not
 * _tender "false"; null when none (e.g. AQ). Caveat: where CLDR lists several current tenders, the first listed wins,
 * which is not always the one used day to day (PA -> PAB, not USD; LS -> ZAR, not LSL). Fine for a label; do not use
 * it to pick a price display currency without an override.
 * HK and MO use CLDR's "-alt-short" name (USE_SHORT_NAME).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "countries", "countries.json");
const CLDR_VERSION = "48.2.0";
const CDN = "https://cdn.jsdelivr.net/npm";
const URLS = {
  territories: `${CDN}/cldr-localenames-full@${CLDR_VERSION}/main/he/territories.json`,
  currencyData: `${CDN}/cldr-core@${CLDR_VERSION}/supplemental/currencyData.json`,
  currencies: `${CDN}/cldr-numbers-full@${CLDR_VERSION}/main/he/currencies.json`,
};
/**
 * Two-letter CLDR codes that are not ISO 3166-1 countries: groupings, private use or unknown (EU, euro area, UN,
 * outlying Oceania, pseudo-locales, unknown) and ISO 3166 "exceptionally reserved" / CLDR-only territories
 * (Ascension, Clipperton, Sark, Diego Garcia, Ceuta & Melilla, Canary Islands, Tristan da Cunha). XK (Kosovo) is kept:
 * user-assigned, but the de facto code airlines and CLDR use.
 */
const NOT_REGIONS = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ", "AC", "CP", "CQ", "DG", "EA", "IC", "TA"]);
/**
 * Regions whose CLDR standard name carries a long qualifier that repeats the city name on a card
 * ("הונג קונג (אזור מנהלי מיוחד של סין)"); for these the CLDR "-alt-short" name is used. Kept explicit: other short
 * variants (US, PS) change wording, not just length, so they are not picked up automatically.
 */
const USE_SHORT_NAME = new Set(["HK", "MO"]);
/** "YYYY-MM-DD" of the run; a currency whose _from is later than this is not current yet. */
const TODAY = new Date().toISOString().slice(0, 10);
const ALPHA2 = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "travel-price-engine gen-countries (build-time, 3 requests per run)", Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const territories = (await get(URLS.territories))?.main?.he?.localeDisplayNames?.territories;
const currencyData = await get(URLS.currencyData);
const regions = currencyData?.supplemental?.currencyData?.region;
const currencyNames = (await get(URLS.currencies))?.main?.he?.numbers?.currencies;
if (!territories || typeof territories !== "object") throw new Error("territories.json: no main.he.localeDisplayNames.territories");
if (!regions || typeof regions !== "object") throw new Error("currencyData.json: no supplemental.currencyData.region");
if (!currencyNames || typeof currencyNames !== "object") throw new Error("currencies.json: no main.he.numbers.currencies");

/** The region's current legal tender, or null. */
function currentCurrency(cc) {
  const list = Array.isArray(regions[cc]) ? regions[cc] : [];
  for (const entry of list) {
    for (const [code, info] of Object.entries(entry ?? {})) {
      if (!CURRENCY.test(code) || !info || typeof info._from !== "string" || info._from > TODAY || info._to !== undefined || info._tender === "false") continue;
      return code;
    }
  }
  return null;
}

const countries = {};
for (const cc of Object.keys(territories).sort()) {
  if (!ALPHA2.test(cc) || NOT_REGIONS.has(cc)) continue;
  const raw = USE_SHORT_NAME.has(cc) && typeof territories[`${cc}-alt-short`] === "string" ? territories[`${cc}-alt-short`] : territories[cc];
  const nameHe = typeof raw === "string" ? raw.trim() : "";
  if (nameHe === "") continue;
  const currency = currentCurrency(cc);
  const cur = currency ? currencyNames[currency]?.displayName : undefined;
  countries[cc] = { nameHe, currency, currencyHe: typeof cur === "string" && cur.trim() !== "" ? cur.trim() : null };
}

const n = Object.keys(countries).length;
if (n < 240) throw new Error(`cldr: only ${n} countries, refusing to write a thin table`);
for (const [cc, want] of [["FR", "EUR"], ["IL", "ILS"], ["US", "USD"]]) {
  if (countries[cc]?.currency !== want) throw new Error(`cldr: ${cc} currency ${countries[cc]?.currency}, expected ${want}; refusing to write`);
}

const version = currencyData?.supplemental?.version?._cldrVersion ?? CLDR_VERSION;
const out = {
  source: `Unicode CLDR ${version} (cldr-json npm ${CLDR_VERSION}): cldr-localenames-full main/he/territories, cldr-core supplemental/currencyData, cldr-numbers-full main/he/currencies`,
  license: "Unicode License V3 (https://www.unicode.org/license.txt), Copyright © 2004-2026 Unicode, Inc.; full notice in worker/THIRD_PARTY_NOTICES",
  version: CLDR_VERSION,
  regenerate: "node scripts/gen-countries.mjs",
  countries,
};
mkdirSync(dirname(OUT), { recursive: true });
// One country per line (small diffs on regenerate), built row by row rather than by regex over the JSON text.
const { countries: rows, ...head } = out;
const body = Object.entries(rows).map(([cc, row]) => `${JSON.stringify(cc)}:${JSON.stringify(row)}`).join(",\n");
const headText = JSON.stringify(head).slice(0, -1);
writeFileSync(OUT, `${headText},"countries":{\n${body}}}\n`);
JSON.parse(`${headText},"countries":{\n${body}}}`); // fail loudly if the hand-assembled text is not JSON
console.log(`wrote ${OUT}: ${n} countries, CLDR ${version} (npm ${CLDR_VERSION}), 3 requests`);
