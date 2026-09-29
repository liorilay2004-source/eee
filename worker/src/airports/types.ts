/**
 * Shapes of the airports/cities dataset (airports/cities.json) and of the resolver output.
 * Kept in its own module so the dataset builder, the resolver and the API layer share one contract.
 */

export interface AirportRecord {
  iata: string; // airport IATA, upper case
  nameEn: string;
  /** Hebrew airport name ("נתב\"ג", "אורלי"), so an airport can be picked by its Hebrew name too; optional. */
  nameHe?: string;
}

/** One city (a metropolitan area): the unit users think in, expanding to one or more airports. */
export interface CityRecord {
  cityIata: string; // city code; equals the airport code for single-airport cities
  cityEn: string;
  /** Hebrew name; "" when the city is outside the Hebrew top list (English/IATA fallback, SPEC §4.3). */
  cityHe: string;
  countryCode: string; // ISO 3166-1 alpha-2
  popularity: number; // 1-100, used to order otherwise equal matches
  airports: AirportRecord[];
  /** Other airports within reasonable ground distance, for the "include nearby airports" option (SPEC §7). */
  nearby: string[];
  aliasesHe?: string[];
  aliasesEn?: string[];
}

export type LocationKind = "city" | "airport";

export interface LocationMatch {
  /** City code (also for airport matches, so callers can group by city). */
  code: string;
  kind: LocationKind;
  /** Set only when `kind` is "airport": the airport that matched. */
  airportCode?: string;
  /** Set only when `kind` is "airport": that airport's English name (city names are in nameHe/nameEn). */
  airportNameEn?: string;
  /** Set only when `kind` is "airport" and the dataset has a Hebrew name for that airport. */
  airportNameHe?: string;
  /** City names; nameHe is null when the dataset has no Hebrew name (never guessed). */
  nameHe: string | null;
  nameEn: string;
  countryCode: string;
  /**
   * Airports to search: every airport of the city for a city match, just the matched airport for an
   * airport match. Always equal to airportsForCode(airportCode ?? code).
   */
  airports: string[];
}

export interface Resolver {
  /**
   * Ranked autocomplete/lookup: IATA > exact name/alias > name prefix > word prefix > substring, then popularity.
   * An all-caps 3-letter query is a code; typed in lower or mixed case ("Goa") an exact name outranks another
   * city's code. "Airport", "International" and a trailing ", Country" are ignored when they would spoil the match.
   */
  resolveLocation(query: string, limit?: number): LocationMatch[];
  /**
   * Strict resolution for SUBMITTED text (where nobody can pick from a list): a code, an exact name or alias, or
   * words that identify exactly one place. Prefix, word-prefix and substring hits, which autocomplete is right to
   * show, are refused here: "REP" must not become Punta Cana because of "Dominican Republic". null = not sure.
   */
  resolvePlace(query: string): LocationMatch | null;
  /** City code -> its airports; airport code -> [code]; unknown -> []. Case-insensitive. */
  airportsForCode(code: string): string[];
  /** Airports near a city/airport that the code itself does not already cover. */
  nearbyAirports(code: string): string[];
  /** ISO country of a city or airport code, or null when unknown. */
  countryOfAirport(code: string): string | null;
  cityNameHe(code: string): string | null;
  cityNameEn(code: string): string | null;
}
