#!/usr/bin/env node
/**
 * Builds extension/data/index.json: the small place index the extension resolves "לאתונה" / "flights to Greece" /
 * "ATH" with. Generated from the Worker's own datasets so the extension and the API agree on places:
 *
 *   worker/src/airports/cities.json     cities, airports, Hebrew/English names and aliases, popularity
 *   worker/src/airports/served.json     airports seen with a direct flight from TLV (orders a country's airports)
 *   worker/src/countries/countries.json Hebrew country names (Unicode CLDR, Unicode License V3)
 *   worker/src/countries/search.ts      the everyday country aliases the website accepts ("ארה״ב", "אנגליה", "UAE")
 *
 * A country resolves to its top airport ordered exactly like worker/src/countries/search.ts orders it (seen with a
 * direct flight from TLV first, then by city popularity, then dataset order; airports without scheduled service
 * left out), and the extension asks the API for that airport's CITY (all of London, not only Heathrow).
 *
 * Names go through the extension's own normalizer (lib/text.js), so the index and the queries always agree.
 *
 * Usage (from extension/):  node scripts/gen-index.mjs           write data/index.json
 *                           node scripts/gen-index.mjs --check   exit 1 if data/index.json is not a fresh build
 * No network, no dependencies, deterministic output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../lib/text.js";

const EXTENSION = new URL("../", import.meta.url);
const REPO = new URL("../", EXTENSION);
export const OUTPUT = new URL("data/index.json", EXTENSION);
export const SOURCES = {
  cities: new URL("worker/src/airports/cities.json", REPO),
  served: new URL("worker/src/airports/served.json", REPO),
  countries: new URL("worker/src/countries/countries.json", REPO),
  search: new URL("worker/src/countries/search.ts", REPO),
};
/** The index must stay small: it is sent to the page's content script once per flight search. */
export const MAX_BYTES = 150_000;
const HUB = "TLV";
const HOME = "IL";
/** Words that alone name no airport ("London City" is not "City"). */
const GENERIC_AIRPORT_WORDS = new Set(["international", "intl", "airport", "city", "south", "north", "east", "west", "central", "capital", "national", "regional"]);

/**
 * English country names (fixed here rather than read from Intl.DisplayNames, whose output changes with the ICU
 * version of whatever Node runs the check). Every country of cities.json must be listed: the build fails otherwise.
 * @type {Record<string, string[]>}
 */
export const ENGLISH_NAMES = {
  AE: ["United Arab Emirates"], AG: ["Antigua and Barbuda", "Antigua"], AL: ["Albania"], AM: ["Armenia"],
  AR: ["Argentina"], AT: ["Austria"], AU: ["Australia"], AW: ["Aruba"], AZ: ["Azerbaijan"],
  BA: ["Bosnia and Herzegovina", "Bosnia"], BB: ["Barbados"], BD: ["Bangladesh"], BE: ["Belgium"], BG: ["Bulgaria"],
  BH: ["Bahrain"], BM: ["Bermuda"], BO: ["Bolivia"], BR: ["Brazil"], BS: ["Bahamas", "The Bahamas"], BZ: ["Belize"],
  CA: ["Canada"], CH: ["Switzerland"], CI: ["Ivory Coast", "Cote d'Ivoire"], CL: ["Chile"], CN: ["China"],
  CO: ["Colombia"], CR: ["Costa Rica"], CU: ["Cuba"], CW: ["Curacao"], CY: ["Cyprus"], CZ: ["Czechia"],
  DE: ["Germany"], DK: ["Denmark"], DO: ["Dominican Republic"], DZ: ["Algeria"], EC: ["Ecuador"], EE: ["Estonia"],
  EG: ["Egypt"], ES: ["Spain"], ET: ["Ethiopia"], FI: ["Finland"], FJ: ["Fiji"], FR: ["France"],
  GB: ["United Kingdom", "UK", "Great Britain"], GE: ["Georgia"], GH: ["Ghana"], GR: ["Greece"], GT: ["Guatemala"],
  HK: ["Hong Kong"], HR: ["Croatia"], HU: ["Hungary"], ID: ["Indonesia"], IE: ["Ireland"], IL: ["Israel"],
  IN: ["India"], IS: ["Iceland"], IT: ["Italy"], JM: ["Jamaica"], JO: ["Jordan"], JP: ["Japan"], KE: ["Kenya"],
  KH: ["Cambodia"], KR: ["South Korea"], KW: ["Kuwait"], KY: ["Cayman Islands"], KZ: ["Kazakhstan"], LA: ["Laos"],
  LB: ["Lebanon"], LC: ["Saint Lucia", "St Lucia"], LK: ["Sri Lanka"], LT: ["Lithuania"], LU: ["Luxembourg"],
  LV: ["Latvia"], MA: ["Morocco"], MD: ["Moldova"], ME: ["Montenegro"], MK: ["North Macedonia", "Macedonia"],
  MM: ["Myanmar", "Burma"], MN: ["Mongolia"], MO: ["Macao", "Macau"], MT: ["Malta"], MU: ["Mauritius"],
  MV: ["Maldives"], MX: ["Mexico"], MY: ["Malaysia"], NA: ["Namibia"], NC: ["New Caledonia"], NG: ["Nigeria"],
  NI: ["Nicaragua"], NL: ["Netherlands", "Holland"], NO: ["Norway"], NP: ["Nepal"], NZ: ["New Zealand"],
  OM: ["Oman"], PA: ["Panama"], PE: ["Peru"], PF: ["French Polynesia"], PH: ["Philippines"], PK: ["Pakistan"],
  PL: ["Poland"], PR: ["Puerto Rico"], PT: ["Portugal"], PY: ["Paraguay"], QA: ["Qatar"], RO: ["Romania"],
  RS: ["Serbia"], RU: ["Russia"], RW: ["Rwanda"], SA: ["Saudi Arabia"], SC: ["Seychelles"], SE: ["Sweden"],
  SG: ["Singapore"], SI: ["Slovenia"], SK: ["Slovakia"], SN: ["Senegal"], SV: ["El Salvador"],
  SX: ["Sint Maarten"], TH: ["Thailand"], TN: ["Tunisia"], TR: ["Turkiye"], TT: ["Trinidad and Tobago"],
  TW: ["Taiwan"], TZ: ["Tanzania"], UG: ["Uganda"], US: ["United States"], UY: ["Uruguay"], UZ: ["Uzbekistan"],
  VN: ["Vietnam"], XK: ["Kosovo"], ZA: ["South Africa"], ZW: ["Zimbabwe"],
};

/** Everyday Hebrew spellings CLDR and search.ts do not have. @type {Record<string, string[]>} */
export const EXTRA_HEBREW = {
  CH: ["שוויץ"], SC: ["סיישל"], KR: ["דרום קוריאה"], MK: ["מקדוניה", "צפון מקדוניה"], SA: ["סעודיה"],
  VN: ["ויטנאם", "ויאטנם"], BA: ["בוסניה"], TT: ["טרינידד"], NO: ["נורבגיה"], TW: ["טאיוואן"], PH: ["פיליפינים"],
  BS: ["בהאמה"], TH: ["טאילנד"],
};

/**
 * Spellings people type into Google that the city dataset does not list (a double vav, a one-word "אבודאבי", the
 * short "vegas"). Extension-only: they widen what a free-text query can name, never what a city is. The build fails
 * when a code here is not a city of cities.json.
 * @type {Record<string, string[]>}
 */
export const EXTRA_CITY_NAMES = {
  WAW: ["וורשה"], VRN: ["וורונה"], LAS: ["וגאס", "ווגאס", "לאס ווגאס", "vegas"], NYC: ["nyc"], BUD: ["בודאפשט"],
  AMS: ["אמסטרדאם"], AUH: ["אבודאבי"],
};

/**
 * `const NAME: Record<string, string[]> = { CC: ["..", ..], ... };` in search.ts -> { CC: [...] }. Strict: any line
 * it cannot read fails the build (the website's aliases must never be dropped silently).
 * @param {string} source
 * @param {string} name
 * @returns {Record<string, string[]>}
 */
export function extractAliases(source, name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`gen-index: ${name} not found in worker/src/countries/search.ts`);
  const open = source.indexOf("{", source.indexOf("=", start));
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error(`gen-index: cannot read ${name}`);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const line of source.slice(open + 1, close).split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("//")) continue;
    const m = /^([A-Z]{2}):\s*(\[.*\]),?$/.exec(t);
    if (!m) throw new Error(`gen-index: unexpected line in ${name}: ${t}`);
    const list = JSON.parse(/** @type {string} */ (m[2]));
    if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) throw new Error(`gen-index: bad aliases for ${m[1]}`);
    out[/** @type {string} */ (m[1])] = list;
  }
  if (Object.keys(out).length === 0) throw new Error(`gen-index: ${name} is empty`);
  return out;
}

/**
 * @param {{ cities: any[], served: any, countries: Record<string, { nameHe: string }>, heAliases: Record<string, string[]>, enAliases: Record<string, string[]>, extraCityNames?: Record<string, string[]> }} src
 */
export function buildIndex(src) {
  const norm = /** @type {(s: string) => string} */ (/** @type {any} */ (globalThis)[Symbol.for("eee.extension")].text.normalizeName);
  const upper = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim().toUpperCase() : "");
  const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim() : "");

  /** @type {Record<string, [string, string, string]>} */
  const c = {};
  /** @type {Record<string, string>} */
  const a = {};
  /** @type {Map<string, number>} */
  const pop = new Map();
  for (const city of src.cities) {
    const code = upper(city?.cityIata);
    const cc = upper(city?.countryCode);
    if (!/^[A-Z]{3}$/.test(code) || !/^[A-Z]{2}$/.test(cc) || Object.hasOwn(c, code)) continue;
    c[code] = [text(city.cityHe), text(city.cityEn), cc];
    pop.set(code, Number.isFinite(city.popularity) ? city.popularity : 0);
  }
  for (const city of src.cities) {
    const code = upper(city?.cityIata);
    if (!Object.hasOwn(c, code)) continue;
    for (const ap of Array.isArray(city.airports) ? city.airports : []) {
      const iata = upper(ap?.iata);
      if (!/^[A-Z]{3}$/.test(iata) || iata === code || Object.hasOwn(c, iata) || Object.hasOwn(a, iata)) continue;
      a[iata] = code;
    }
  }

  // Names. Priority: city names and aliases, then country names, then airport names; within one priority the more
  // popular city wins, then the smaller code (deterministic).
  /** @type {Map<string, { target: string, prio: number, pop: number }>} */
  const names = new Map();
  const offer = (/** @type {string} */ name, /** @type {string} */ target, /** @type {number} */ prio, /** @type {number} */ p) => {
    const key = norm(name);
    if (key === "" || key.length > 64) return;
    const cur = names.get(key);
    if (!cur || prio < cur.prio || (prio === cur.prio && (p > cur.pop || (p === cur.pop && target < cur.target)))) names.set(key, { target, prio, pop: p });
  };
  for (const city of src.cities) {
    const code = upper(city?.cityIata);
    if (!Object.hasOwn(c, code)) continue;
    const p = pop.get(code) ?? 0;
    for (const n of [city.cityHe, city.cityEn, ...(city.aliasesHe ?? []), ...(city.aliasesEn ?? [])]) if (typeof n === "string") offer(n, code, 1, p);
    const airports = Array.isArray(city.airports) ? city.airports : [];
    for (const ap of airports) {
      const iata = upper(ap?.iata);
      const target = iata === code ? code : Object.hasOwn(a, iata) ? `#${iata}` : null;
      if (!target) continue;
      for (const n of [ap.nameHe, ap.nameEn]) if (typeof n === "string") offer(n, target, 3, p);
      // In a city with several airports, the airport's own name without the city ("London Gatwick" -> "Gatwick").
      const en = text(ap.nameEn);
      const cityEn = text(city.cityEn);
      if (airports.length > 1 && cityEn && en.startsWith(`${cityEn} `)) {
        const rest = en.slice(cityEn.length + 1);
        if (!norm(rest).split(" ").every((w) => GENERIC_AIRPORT_WORDS.has(w))) offer(rest, target, 3, p);
      }
    }
  }

  for (const [code, list] of Object.entries(src.extraCityNames ?? {})) {
    if (!Object.hasOwn(c, code)) throw new Error(`gen-index: EXTRA_CITY_NAMES names ${code}, which is not a city of cities.json`);
    for (const n of list) offer(n, code, 1, pop.get(code) ?? 0);
  }

  // Countries: airports ordered like worker/src/countries/search.ts createCountryIndex.
  const direct = new Set();
  for (const [hub, list] of Object.entries(src.served?.directFrom ?? {})) {
    for (const code of Array.isArray(list) ? list : []) {
      if (hub === HUB) direct.add(code);
      else if (code === HUB) direct.add(hub);
    }
  }
  const closed = new Set(Array.isArray(src.served?.noScheduledService) ? src.served.noScheduledService : []);
  /** @type {Map<string, { code: string, cityCode: string, direct: boolean, pop: number, order: number }[]>} */
  const byCountry = new Map();
  const seen = new Set();
  let order = 0;
  for (const city of src.cities) {
    const cc = upper(city?.countryCode);
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    const cityCode = upper(city.cityIata);
    const p = Number.isFinite(city.popularity) ? city.popularity : 0;
    for (const ap of Array.isArray(city.airports) ? city.airports : []) {
      const code = upper(ap?.iata);
      if (!/^[A-Z]{3}$/.test(code) || seen.has(code) || closed.has(code)) continue;
      seen.add(code);
      const list = byCountry.get(cc) ?? [];
      list.push({ code, cityCode: cityCode || code, direct: direct.has(code), pop: p, order: order++ });
      byCountry.set(cc, list);
    }
  }
  /** @type {Record<string, [string, string, string]>} */
  const k = {};
  for (const [cc, row] of Object.entries(src.countries)) {
    const list = byCountry.get(cc);
    if (!list || list.length === 0 || typeof row?.nameHe !== "string") continue;
    if (!Object.hasOwn(ENGLISH_NAMES, cc)) throw new Error(`gen-index: add an English name for ${cc} to ENGLISH_NAMES`);
    list.sort((x, y) => (x.direct !== y.direct ? (x.direct ? -1 : 1) : y.pop - x.pop || x.order - y.order));
    // Israel is only ever an origin: "מישראל" means the user's default airport, so its entry points at TLV.
    const top = cc === HOME ? { code: HUB, cityCode: HUB } : /** @type {(typeof list)[number]} */ (list[0]);
    const name = row.nameHe.replace(/\s*\(.*$/, "");
    k[cc] = [name, top.code, top.cityCode];
    const p = Math.max(...list.map((x) => x.pop));
    const all = [row.nameHe, ...(src.heAliases[cc] ?? []), ...(EXTRA_HEBREW[cc] ?? []), ...(ENGLISH_NAMES[cc] ?? []), ...(src.enAliases[cc] ?? [])];
    for (const raw of all) for (const variant of [raw, raw.replace(/\s*\(.*$/, "")]) offer(variant, `@${cc}`, 2, p);
  }
  if (!Object.hasOwn(k, HOME)) throw new Error("gen-index: Israel (the origin country) is missing");

  const sortedEntries = (/** @type {Record<string, unknown>} */ o) => Object.keys(o).sort().map((key) => [key, o[key]]);
  return {
    c: Object.fromEntries(sortedEntries(c)),
    a: Object.fromEntries(sortedEntries(a)),
    k: Object.fromEntries(sortedEntries(k)),
    n: Object.fromEntries([...names.keys()].sort().map((key) => [key, /** @type {{ target: string }} */ (names.get(key)).target])),
  };
}

const ABOUT =
  "Generated by extension/scripts/gen-index.mjs from worker/src/airports/cities.json, worker/src/airports/served.json, " +
  "worker/src/countries/countries.json and the aliases in worker/src/countries/search.ts. Do not edit by hand: run " +
  "`node scripts/gen-index.mjs` in extension/. Hebrew country names: Unicode CLDR, Unicode License V3 (see " +
  "extension/THIRD_PARTY_NOTICES).";

/**
 * One entry per line: small, and a data change shows up as a readable diff.
 * @param {ReturnType<typeof buildIndex>} index
 */
export function serialize(index) {
  const block = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ obj) =>
    `${JSON.stringify(key)}:{\n${Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n")}\n}`;
  return `{"v":1,\n"about":${JSON.stringify(ABOUT)},\n${block("c", index.c)},\n${block("a", index.a)},\n${block("k", index.k)},\n${block("n", index.n)}\n}\n`;
}

/** Reads the sources from the repository and returns the file content data/index.json must have. */
export function generate() {
  const read = (/** @type {URL} */ u) => readFileSync(u, "utf8");
  const search = read(SOURCES.search);
  const index = buildIndex({
    cities: JSON.parse(read(SOURCES.cities)),
    served: JSON.parse(read(SOURCES.served)),
    countries: JSON.parse(read(SOURCES.countries)).countries,
    heAliases: extractAliases(search, "HEBREW_ALIASES"),
    enAliases: extractAliases(search, "ENGLISH_ALIASES"),
    extraCityNames: EXTRA_CITY_NAMES,
  });
  return serialize(index);
}

function main() {
  const fresh = generate();
  const bytes = Buffer.byteLength(fresh, "utf8");
  if (bytes > MAX_BYTES) {
    console.error(`gen-index: the index is ${bytes} bytes, over the ${MAX_BYTES}-byte budget`);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {
      /* missing = stale */
    }
    if (current !== fresh) {
      console.error("gen-index: extension/data/index.json is stale. Run `node scripts/gen-index.mjs` in extension/ and commit the result.");
      process.exit(1);
    }
    console.log(`gen-index: data/index.json is up to date (${bytes} bytes)`);
    return;
  }
  writeFileSync(OUTPUT, fresh);
  console.log(`gen-index: wrote data/index.json (${bytes} bytes)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
