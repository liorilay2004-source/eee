/**
 * Country search for the destination autocomplete: "יוון" / "קפריסין" / "Greece" -> that country's airports.
 *
 * Additive to /api/airports: the city/airport `results` are computed exactly as before, and country suggestions go in
 * a separate `countries` array that older web builds simply ignore. Names come from the bundled CLDR table
 * (countries.json, Hebrew), a few everyday Hebrew aliases ("ארה״ב", "אנגליה"), and English names from the runtime's
 * Intl.DisplayNames when it has them (it may not; then English country search is simply off). Queries and names go
 * through the same normalizer as the city resolver (niqqud, geresh/quote variants, final letters, case).
 *
 * Israel (the hub's country) is never offered: a trip from TLV to Israel is not what a destination country means.
 *
 * Airports of a country are ordered: seen with a direct flight from TLV first, then by city popularity. Airports
 * without scheduled service are left out. Nothing here makes a network call; indexes are built once at module load.
 */
import citiesData from "../airports/cities.json";
import { normalizeQuery } from "../airports/resolve";
import { directSeen, noScheduledService } from "../airports/served";
import type { CityRecord } from "../airports/types";
import countriesJson from "./countries.json";

export interface CountryAirport {
  /** Airport IATA code (what a search is run with). */
  code: string;
  /** The airport's city code. */
  cityCode: string;
  /** City name in Hebrew, or null when the dataset has none (never guessed). */
  nameHe: string | null;
  nameEn: string;
  /** Seen with a direct flight to/from TLV in the bundled snapshot (a hint, not a promise). */
  direct: boolean;
}

export interface CountrySuggestion {
  type: "country";
  /** ISO 3166-1 alpha-2. */
  code: string;
  nameHe: string;
  nameEn: string | null;
  /** "exact": the query is the country's name or alias; "partial": a prefix of one (still typing). */
  match: "exact" | "partial";
  /** Airport codes, best first; equals places.map((p) => p.code). Never empty. */
  airports: string[];
  places: CountryAirport[];
}

const MAX_RAW_LEN = 256;
const MAX_QUERY_LEN = 64;
/** A country can have dozens of airports (US); the list is a picker, not a census. */
export const MAX_COUNTRY_AIRPORTS = 12;
export const DEFAULT_COUNTRY_LIMIT = 3;
const HUB = "TLV";
/** The hub's own country: every search leaves from TLV, so "ישראל" as a destination would only offer domestic trips. */
const HOME_COUNTRY = "IL";

/** Everyday Hebrew names CLDR does not use. Normalized before use, so geresh/quote spelling does not matter. */
const HEBREW_ALIASES: Record<string, string[]> = {
  US: ["ארה\"ב", "ארצות הברית של אמריקה", "אמריקה"],
  GB: ["אנגליה", "הממלכה המאוחדת"],
  AE: ["האמירויות", "אמירויות", "איחוד האמירויות"],
  MV: ["מלדיביים", "המלדיבים", "מלדיבים"],
  CZ: ["צ'כיה", "צכיה"],
  GE: ["ג'ורג'יה"],
  KR: ["קוריאה"],
  DO: ["דומיניקנית", "הרפובליקה הדומיניקנית"],
};

/** English names Intl.DisplayNames no longer returns (it says "Türkiye", "Czechia") or that people type. */
const ENGLISH_ALIASES: Record<string, string[]> = {
  TR: ["Turkey"],
  CZ: ["Czech Republic"],
  US: ["USA", "America"],
  GB: ["England", "Britain"],
  AE: ["UAE", "Emirates"],
};

interface CountryEntry {
  code: string;
  nameHe: string;
  nameEn: string | null;
  /** Normalized searchable names, each padded with a leading space for word-prefix checks. */
  names: string[];
  places: CountryAirport[];
  /** Highest city popularity in the country: orders otherwise equal country matches. */
  popularity: number;
}

function englishNames(): ((cc: string) => string | null) {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    return (cc) => {
      try {
        const name = dn.of(cc);
        return typeof name === "string" && name !== "" && name !== cc ? name : null;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}

export function createCountryIndex(
  cities: readonly CityRecord[],
  namesHe: Readonly<Record<string, { nameHe: string }>>,
  isDirect: (code: string) => boolean = (code) => directSeen(HUB, code),
  isClosed: (code: string) => boolean = noScheduledService,
  nameEn: (cc: string) => string | null = englishNames(),
) {
  // Airports per country, with the ordering keys.
  const byCountry = new Map<string, Array<CountryAirport & { pop: number; order: number }>>();
  const seen = new Set<string>();
  let order = 0;
  for (const city of cities) {
    const cc = typeof city?.countryCode === "string" ? city.countryCode.trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    const cityCode = typeof city.cityIata === "string" ? city.cityIata.trim().toUpperCase() : "";
    const pop = Number.isFinite(city.popularity) ? city.popularity : 0;
    for (const a of Array.isArray(city.airports) ? city.airports : []) {
      const code = typeof a?.iata === "string" ? a.iata.trim().toUpperCase() : "";
      if (!/^[A-Z]{3}$/.test(code) || seen.has(code) || isClosed(code)) continue;
      seen.add(code);
      const list = byCountry.get(cc) ?? [];
      list.push({
        code,
        cityCode: cityCode || code,
        nameHe: typeof city.cityHe === "string" && city.cityHe.trim() !== "" ? city.cityHe : null,
        nameEn: typeof city.cityEn === "string" ? city.cityEn : "",
        direct: isDirect(code),
        pop,
        order: order++,
      });
      byCountry.set(cc, list);
    }
  }

  const entries: CountryEntry[] = [];
  for (const [cc, row] of Object.entries(namesHe)) {
    const list = byCountry.get(cc);
    if (cc === HOME_COUNTRY || !list || list.length === 0 || typeof row?.nameHe !== "string") continue;
    list.sort((x, y) => (x.direct !== y.direct ? (x.direct ? -1 : 1) : y.pop - x.pop || x.order - y.order));
    const places = list.slice(0, MAX_COUNTRY_AIRPORTS).map(({ pop: _p, order: _o, ...place }) => place);
    const en = nameEn(cc);
    const names = new Set<string>();
    for (const raw of [row.nameHe, ...(HEBREW_ALIASES[cc] ?? []), ...(en ? [en] : []), ...(ENGLISH_ALIASES[cc] ?? [])]) {
      // "הונג קונג (אזור מנהלי מיוחד של סין)": the part before the brackets is a name of its own.
      for (const variant of [raw, raw.replace(/\s*\(.*$/, "")]) {
        const n = normalizeQuery(variant);
        if (n !== "") names.add(" " + n);
      }
    }
    entries.push({ code: cc, nameHe: row.nameHe, nameEn: en, names: [...names], places, popularity: Math.max(...list.map((p) => p.pop)) });
  }

  /**
   * Countries whose name (or alias) equals the query, starts with it, or has a word starting with it. A query shorter
   * than 2 characters (3 for Latin letters) matches nothing. A country with a single airport is left out when
   * `covered` already offers that airport (Malta, Singapore: the city suggestion says it all).
   */
  function searchCountries(query: string, limit: number = DEFAULT_COUNTRY_LIMIT, covered: ReadonlySet<string> = new Set()): CountrySuggestion[] {
    if (typeof query !== "string" || query.length > MAX_RAW_LEN) return [];
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_COUNTRY_LIMIT;
    const q = normalizeQuery(query);
    if (max === 0 || q === "" || q.length > MAX_QUERY_LEN) return [];
    if (q.length < (/^[a-z0-9 ]+$/.test(q) ? 3 : 2)) return [];
    const exact = " " + q;
    const hits: Array<{ e: CountryEntry; tier: number }> = [];
    for (const e of entries) {
      let tier = -1;
      for (const n of e.names) {
        const t = n === exact ? 0 : n.startsWith(exact) ? 1 : n.includes(exact) ? 2 : -1;
        if (t !== -1 && (tier === -1 || t < tier)) tier = t;
      }
      if (tier === -1) continue;
      if (e.places.length === 1 && covered.has(e.places[0]!.code)) continue;
      hits.push({ e, tier });
    }
    hits.sort((a, b) => a.tier - b.tier || b.e.popularity - a.e.popularity || (a.e.code < b.e.code ? -1 : 1));
    return hits.slice(0, max).map(({ e, tier }) => ({
      type: "country",
      code: e.code,
      nameHe: e.nameHe,
      nameEn: e.nameEn,
      match: tier === 0 ? "exact" : "partial",
      airports: e.places.map((p) => p.code),
      places: e.places.map((p) => ({ ...p })),
    }));
  }

  return { searchCountries };
}

const shared = createCountryIndex(citiesData as CityRecord[], countriesJson.countries as Record<string, { nameHe: string }>);

export function searchCountries(query: string, limit?: number, covered?: ReadonlySet<string>): CountrySuggestion[] {
  return shared.searchCountries(query, limit, covered);
}
