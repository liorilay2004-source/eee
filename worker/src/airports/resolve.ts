/**
 * City/airport lookup for the search form and the pipeline (SPEC §4.3, §7 step 1).
 *
 * Users type Hebrew or English in every possible spelling, so both the dataset and the query go through the
 * same normalizer and are compared as plain strings. Indexes are built once per resolver; a lookup is one
 * pass over the pre-normalized names (O(n) for ~1000 cities) and never builds a RegExp from user input.
 */
import type { AirportRecord, CityRecord, LocationMatch, Resolver } from "./types";
import citiesData from "./cities.json";

// ---------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------

/**
 * Bidi marks, zero-width characters, soft hyphen and the like: invisible, so they vanish (no word break).
 * \p{Cf} covers all format controls (LRM/RLM, U+061C Arabic letter mark, ZWJ/ZWNJ, isolates, BOM, invisible math
 * operators...); U+FE00-FE0F are the variation selectors that follow emoji ("TLV ✈️"), marks that would otherwise
 * stay attached to the last letter.
 */
const INVISIBLE = /[\p{Cf}\uFE00-\uFE0F]/gu;
/**
 * Geresh/apostrophe/quote family. Dropped rather than mapped to one symbol so that ג'ירונה, גירונה and
 * ארה"ב / ארהב all meet, and O'Hare meets OHare.
 */
const QUOTES = /['"`´ʼ׳״‘’“”′]/g;
/** Niqqud and cantillation. U+05BE (maqaf) sits inside this range, so it is turned into a space first. */
const HEBREW_POINTS = /[֑-ׇ]/g;
const MAQAF = /־/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
/** Latin letters that NFKD does not decompose (København, Łódź, Straße). */
const LATIN_FOLD_RE = /[øæœßłđı]/g;
const LATIN_FOLD: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ı: "i" };
const HEBREW_FINALS_RE = /[ךםןףץ]/g;
/** Final letters folded to their regular forms: ך->כ ם->מ ן->נ ף->פ ץ->צ. */
const HEBREW_FINALS: Record<string, string> = {
  "ך": "כ",
  "ם": "מ",
  "ן": "נ",
  "ף": "פ",
  "ץ": "צ",
};
/** Everything that is not a letter, mark, digit or whitespace (hyphens, dots, slashes, controls, emoji...). */
const NOT_WORD = /[^\p{L}\p{M}\p{N}\s]/gu;
const WHITESPACE = /\s+/g;

/**
 * Canonical form used for both dataset names and user queries. Total: any input, including non-strings
 * from a sloppy caller, yields a (possibly empty) string and never throws.
 */
export function normalizeQuery(s: string): string {
  if (typeof s !== "string" || s === "") return "";
  return (
    s
      .replace(INVISIBLE, "")
      .replace(QUOTES, "") // before NFKD, which would split U+00B4 into a space plus a mark
      .normalize("NFKD") // also unpacks Hebrew presentation forms into letter + points
      .replace(MAQAF, " ")
      .replace(HEBREW_POINTS, "")
      .toLowerCase()
      .replace(COMBINING_MARKS, "")
      .replace(LATIN_FOLD_RE, (c) => LATIN_FOLD[c] ?? c)
      .replace(HEBREW_FINALS_RE, (c) => HEBREW_FINALS[c] ?? c)
      .replace(NOT_WORD, " ")
      .replace(WHITESPACE, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------------------------------

/** Longest normalized query we try to match; anything longer is garbage, not a place name. */
const MAX_QUERY_LEN = 64;
/** Cheap guard applied before normalizing: heavy niqqud can triple a name, but not beyond this. */
const MAX_RAW_LEN = 256;
const DEFAULT_LIMIT = 8;
/** Codes are 3 letters; the cap only stops absurd inputs from reaching Map lookups. */
const MAX_CODE_LEN = 8;

// Match quality, best first.
const T_IATA = 0;
const T_EXACT = 1;
const T_PREFIX = 2;
const T_WORD = 3;
const T_SUBSTRING = 4;
/** Strict resolution only: the query is a run of whole words of a longer name ("heathrow" in "london heathrow"). */
const T_TOKENS = 1.5;

interface CityInfo {
  code: string;
  nameEn: string;
  nameHe: string | null;
  countryCode: string;
  popularity: number;
  airports: AirportRecord[];
  airportCodes: string[];
  nearby: string[];
}

/** One searchable string: a city name/alias (airport === -1) or an airport name (index into the city's airports). */
interface NameEntry {
  text: string;
  padded: string; // " " + text, so "word starts with q" is one includes() call
  city: number;
  airport: number;
}

interface Candidate {
  tier: number;
  /** 0 = matched at city level, 1 = at airport level; a city-level hit of equal tier wins for the same city. */
  level: number;
  airport: number;
}

function upperCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list as unknown[]) if (typeof item === "string" && item.trim() !== "") out.push(item);
  return out;
}

/** True for a query typed in capitals ("GOA", "JFK Airport" is not: it has lower-case letters). */
function isTypedInCapitals(raw: string): boolean {
  const t = raw.trim();
  return t !== "" && t === t.toUpperCase() && t !== t.toLowerCase();
}

/** Words that describe the kind of place, not which one: dropped when they would keep a query from matching. */
const STOP_PHRASES = ["נמל התעופה", "שדה התעופה", "נמל תעופה", "שדה תעופה", "airports", "airport", "international", "intl"].map(normalizeQuery);

function stripStopPhrases(q: string): string {
  let out = ` ${q} `;
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    for (const phrase of STOP_PHRASES) out = out.split(` ${phrase} `).join(" ");
    if (out === before) break;
  }
  return out.replace(WHITESPACE, " ").trim();
}

/**
 * The normalized forms of a query to try, most literal first: as typed, the part before a comma ("Tel Aviv,
 * Israel"), and each of those without "airport"/"international"/"נמל תעופה" ("Ben Gurion Airport").
 */
function queryVariants(raw: string): string[] {
  const out: string[] = [];
  const add = (q: string): void => {
    if (q !== "" && q.length <= MAX_QUERY_LEN && !out.includes(q)) out.push(q);
  };
  const full = normalizeQuery(raw);
  const head = raw.includes(",") ? normalizeQuery(raw.split(",")[0] ?? "") : "";
  add(full);
  add(head);
  if (full !== "") add(stripStopPhrases(full));
  if (head !== "") add(stripStopPhrases(head));
  return out;
}

export function createResolver(cities: CityRecord[]): Resolver {
  const infos: CityInfo[] = [];
  const entries: NameEntry[] = [];
  const cityByCode = new Map<string, number>();
  const airportByCode = new Map<string, { city: number; airport: number }>();

  for (const rec of cities) {
    const code = upperCode(rec?.cityIata);
    // A duplicated city code is a dataset bug; the first record wins so results stay unique per city.
    if (code === "" || cityByCode.has(code)) continue;

    const airports: AirportRecord[] = [];
    const seenAirports = new Set<string>();
    for (const a of Array.isArray(rec.airports) ? rec.airports : []) {
      const iata = upperCode(a?.iata);
      if (iata === "" || seenAirports.has(iata)) continue;
      seenAirports.add(iata);
      const nameHe = typeof a.nameHe === "string" && a.nameHe.trim() !== "" ? a.nameHe : undefined;
      airports.push({ iata, nameEn: typeof a.nameEn === "string" ? a.nameEn : "", ...(nameHe ? { nameHe } : {}) });
    }

    const nearby: string[] = [];
    for (const n of cleanList(rec.nearby)) {
      const iata = upperCode(n);
      if (iata !== "" && !nearby.includes(iata)) nearby.push(iata);
    }

    const cityIdx = infos.length;
    const nameEn = typeof rec.cityEn === "string" ? rec.cityEn : "";
    const nameHe = typeof rec.cityHe === "string" && rec.cityHe.trim() !== "" ? rec.cityHe : null;
    infos.push({
      code,
      nameEn,
      nameHe,
      countryCode: typeof rec.countryCode === "string" ? rec.countryCode.toUpperCase() : "",
      popularity: Number.isFinite(rec.popularity) ? rec.popularity : 0,
      airports,
      airportCodes: airports.map((a) => a.iata),
      nearby,
    });
    cityByCode.set(code, cityIdx);
    airports.forEach((a, i) => {
      if (!airportByCode.has(a.iata)) airportByCode.set(a.iata, { city: cityIdx, airport: i });
    });

    const seenText = new Set<string>();
    const addCityName = (raw: string): void => {
      const text = normalizeQuery(raw);
      if (text === "" || seenText.has(text)) return;
      seenText.add(text);
      entries.push({ text, padded: " " + text, city: cityIdx, airport: -1 });
    };
    if (nameHe !== null) addCityName(nameHe);
    addCityName(nameEn);
    for (const alias of cleanList(rec.aliasesHe)) addCityName(alias);
    for (const alias of cleanList(rec.aliasesEn)) addCityName(alias);
    airports.forEach((a, i) => {
      for (const name of [a.nameEn, a.nameHe ?? ""]) {
        const text = normalizeQuery(name);
        if (text !== "") entries.push({ text, padded: " " + text, city: cityIdx, airport: i });
      }
    });
  }

  /** Index of the city a city-or-airport code belongs to; city codes win over airport codes. */
  function cityIndexOfCode(code: string): number | undefined {
    const key = upperCode(code);
    if (key === "" || key.length > MAX_CODE_LEN) return undefined;
    return cityByCode.get(key) ?? airportByCode.get(key)?.city;
  }

  function toMatch(city: number, c: Candidate): LocationMatch {
    const info = infos[city] as CityInfo;
    const airport = c.airport >= 0 ? info.airports[c.airport] : undefined;
    const base = {
      code: info.code,
      nameHe: info.nameHe,
      nameEn: info.nameEn,
      countryCode: info.countryCode,
    };
    if (!airport) return { ...base, kind: "city", airports: [...info.airportCodes] };
    return {
      ...base,
      kind: "airport",
      airportCode: airport.iata,
      airportNameEn: airport.nameEn,
      ...(airport.nameHe ? { airportNameHe: airport.nameHe } : {}),
      airports: [airport.iata],
    };
  }

  /**
   * Candidates for one normalized query, best first, one per city. `iataTier` is the tier a code hit gets: a code
   * typed in capitals is a code (T_IATA), otherwise it only ties with exact names, so "Goa" is Goa and not the
   * city whose code happens to be GOA. `strict` keeps only codes, exact names and whole-word runs.
   */
  function rank(q: string, iataTier: number, strict: boolean): Array<[number, Candidate]> {
    // One candidate per city: the best (tier, level) among everything that matched it.
    const best = new Map<number, Candidate>();
    const offer = (city: number, tier: number, level: number, airport: number): void => {
      const cur = best.get(city);
      if (!cur || tier < cur.tier || (tier === cur.tier && level < cur.level)) {
        best.set(city, { tier, level, airport });
      }
    };

    const code = q.toUpperCase();
    const cityHit = cityByCode.get(code);
    if (cityHit !== undefined) offer(cityHit, iataTier, 0, -1);
    const airportHit = airportByCode.get(code);
    if (airportHit) offer(airportHit.city, iataTier, 1, airportHit.airport);

    const wordQ = " " + q;
    for (const e of entries) {
      let tier: number;
      if (e.text === q) tier = T_EXACT;
      else if (strict) {
        if (!(e.padded + " ").includes(wordQ + " ")) continue;
        tier = T_TOKENS;
      } else if (e.text.startsWith(q)) tier = T_PREFIX;
      else if (e.padded.includes(wordQ)) tier = T_WORD;
      else if (e.text.includes(q)) tier = T_SUBSTRING;
      else continue;
      offer(e.city, tier, e.airport === -1 ? 0 : 1, e.airport);
    }

    return [...best].sort(([ia, a], [ib, b]) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const ca = infos[ia] as CityInfo;
      const cb = infos[ib] as CityInfo;
      if (ca.popularity !== cb.popularity) return cb.popularity - ca.popularity;
      if (a.level !== b.level) return a.level - b.level;
      return ca.code < cb.code ? -1 : ca.code > cb.code ? 1 : 0; // deterministic, independent of dataset order
    });
  }

  function resolveLocation(query: string, limit: number = DEFAULT_LIMIT): LocationMatch[] {
    if (typeof query !== "string" || query.length > MAX_RAW_LEN) return [];
    const max = Number.isNaN(limit) ? DEFAULT_LIMIT : Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const iataTier = isTypedInCapitals(query) ? T_IATA : T_EXACT;
    for (const q of queryVariants(query)) {
      const ranked = rank(q, iataTier, false);
      if (ranked.length > 0) return ranked.slice(0, max).map(([city, c]) => toMatch(city, c));
    }
    return [];
  }

  function resolvePlace(query: string): LocationMatch | null {
    if (typeof query !== "string" || query.length > MAX_RAW_LEN) return null;
    const typed = query.trim();
    const capitals3 = /^[A-Z]{3}$/.test(typed); // an all-caps triple is a code and nothing else
    const shape3 = /^[A-Za-z]{3}$/.test(typed);
    const iataTier = isTypedInCapitals(query) ? T_IATA : T_EXACT;
    for (const q of queryVariants(query)) {
      const ranked = rank(q, iataTier, true);
      const top = ranked[0];
      if (!top) continue;
      if (capitals3 && top[1].tier !== T_IATA) continue;
      if (top[1].tier === T_TOKENS && (ranked.length > 1 || shape3)) continue; // ambiguous, or too short to trust
      return toMatch(top[0], top[1]);
    }
    return null;
  }

  function airportsForCode(code: string): string[] {
    const key = upperCode(code);
    if (key === "" || key.length > MAX_CODE_LEN) return [];
    const city = cityByCode.get(key);
    if (city !== undefined) return [...(infos[city] as CityInfo).airportCodes];
    return airportByCode.has(key) ? [key] : [];
  }

  function nearbyAirports(code: string): string[] {
    const key = upperCode(code);
    if (key === "" || key.length > MAX_CODE_LEN) return [];
    const cityCodeHit = cityByCode.get(key);
    const airportHit = cityCodeHit === undefined ? airportByCode.get(key) : undefined;
    const idx = cityCodeHit ?? airportHit?.city;
    if (idx === undefined) return [];
    const info = infos[idx] as CityInfo;

    // A city code already covers all of the city's airports; an airport code covers only itself, so its
    // sibling airports count as nearby (they are the closest alternatives).
    const covered = new Set<string>([key, ...(cityCodeHit !== undefined ? info.airportCodes : [])]);
    const siblings = cityCodeHit !== undefined ? [] : info.airportCodes;
    const out: string[] = [];
    for (const c of [...siblings, ...info.nearby]) {
      if (covered.has(c)) continue;
      covered.add(c);
      out.push(c);
    }
    return out;
  }

  function countryOfAirport(code: string): string | null {
    const idx = cityIndexOfCode(code);
    if (idx === undefined) return null;
    return (infos[idx] as CityInfo).countryCode || null;
  }

  function cityNameHe(code: string): string | null {
    const idx = cityIndexOfCode(code);
    return idx === undefined ? null : (infos[idx] as CityInfo).nameHe;
  }

  function cityNameEn(code: string): string | null {
    const idx = cityIndexOfCode(code);
    if (idx === undefined) return null;
    return (infos[idx] as CityInfo).nameEn || null;
  }

  return { resolveLocation, resolvePlace, airportsForCode, nearbyAirports, countryOfAirport, cityNameHe, cityNameEn };
}

// ---------------------------------------------------------------------------------------------------------
// Singleton bound to the shipped dataset
// ---------------------------------------------------------------------------------------------------------

const CITIES: CityRecord[] = citiesData;
/**
 * Built when the module loads, not on the first request: global-scope CPU is budgeted apart from the per-request
 * limit (10 ms on the Workers Free plan), and the ~10 ms index build would otherwise land on some user's request.
 * The indexes are read-only afterwards.
 */
const shared: Resolver = createResolver(CITIES);
const defaultResolver = (): Resolver => shared;

export function resolveLocation(query: string, limit = DEFAULT_LIMIT): LocationMatch[] {
  return defaultResolver().resolveLocation(query, limit);
}

export function resolvePlace(query: string): LocationMatch | null {
  return defaultResolver().resolvePlace(query);
}

export function airportsForCode(code: string): string[] {
  return defaultResolver().airportsForCode(code);
}

export function nearbyAirports(code: string): string[] {
  return defaultResolver().nearbyAirports(code);
}

export function countryOfAirport(code: string): string | null {
  return defaultResolver().countryOfAirport(code);
}

export function cityNameHe(code: string): string | null {
  return defaultResolver().cityNameHe(code);
}

export function cityNameEn(code: string): string | null {
  return defaultResolver().cityNameEn(code);
}
