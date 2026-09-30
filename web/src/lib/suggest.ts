import type { AirportSuggestion, CountryAirport, CountrySuggestion } from "../api/contract";

/** One row of the list: a city/airport from `results`, or a country from `countries`. */
export type ComboOption = { type: "place"; place: AirportSuggestion } | { type: "country"; country: CountrySuggestion };

export function countryPlaceName(place: CountryAirport): string {
  return place.nameHe || place.nameEn || place.code;
}

/**
 * The list order: a country the query names exactly comes first ("יוון"), cities and airports next, and countries
 * the query only starts ("יו") last, so typing a city is never pushed down by countries.
 */
export function mergeOptions(results: AirportSuggestion[], countries: CountrySuggestion[]): ComboOption[] {
  const exact = countries.filter((c) => c.match === "exact");
  const partial = countries.filter((c) => c.match !== "exact");
  return [
    ...exact.map((country) => ({ type: "country" as const, country })),
    ...results.map((place) => ({ type: "place" as const, place })),
    ...partial.map((country) => ({ type: "country" as const, country })),
  ];
}

export function placeDisplayName(place: AirportSuggestion): string {
  if (place.kind === "airport") return place.airportNameHe || place.airportNameEn || place.airportCode || place.code;
  return place.nameHe || place.nameEn || place.code;
}

export function placeSearchCode(place: AirportSuggestion): string {
  return place.kind === "airport" ? (place.airportCode || place.code) : place.code;
}

/** What picking a list row does: the code/name handed to onSelect, the status line, and the country chips to keep. */
export interface Choice {
  code: string;
  name: string;
  status: string;
  /** The picked country (its airports become chips), or null for a city/airport row. */
  country: CountrySuggestion | null;
  /** The chip pressed right after the pick ("" without a country). */
  countryPick: string;
}

/** A country row searches its best airport (places[0]); null when it somehow has none. */
export function chooseOption(option: ComboOption): Choice | null {
  if (option.type === "country") {
    const top = option.country.places[0];
    if (!top) return null;
    const name = countryPlaceName(top);
    const more = option.country.places.length > 1 ? " אפשר לבחור שדה תעופה אחר מהרשימה." : "";
    return { code: top.code, name, status: `נבחרה ${option.country.nameHe}: ${name}.${more}`, country: option.country, countryPick: top.code };
  }
  const name = placeDisplayName(option.place);
  return { code: placeSearchCode(option.place), name, status: `נבחר: ${name}`, country: null, countryPick: "" };
}

/**
 * The country chips to show and which one is pressed. `value` is the form's current destination when the parent
 * passes it: a destination changed elsewhere (a popular-destination button) to an airport outside the country hides
 * the chips, so two different selections never look active at once; one inside the country moves the pressed chip.
 */
export function countryChips(country: CountrySuggestion | null, countryPick: string, value?: string): { country: CountrySuggestion; selected: string } | null {
  if (!country) return null;
  if (value === undefined) return { country, selected: countryPick };
  return country.places.some((p) => p.code === value) ? { country, selected: value } : null;
}
