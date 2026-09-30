import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanCountries } from "../api/client";
import type { AirportSuggestion, CountrySuggestion } from "../api/contract";
import { CountryAirportChips, CountryOptionContent } from "../components/AirportCombobox";
import { chooseOption, countryChips, mergeOptions } from "./suggest";

const greece: CountrySuggestion = {
  type: "country", code: "GR", nameHe: "יוון", nameEn: "Greece", match: "exact",
  airports: ["ATH", "SKG", "HER"],
  places: [
    { code: "ATH", cityCode: "ATH", nameHe: "אתונה", nameEn: "Athens", direct: true },
    { code: "SKG", cityCode: "SKG", nameHe: "סלוניקי", nameEn: "Thessaloniki", direct: true },
    { code: "HER", cityCode: "HER", nameHe: null, nameEn: "Heraklion", direct: false },
  ],
};
const athens: AirportSuggestion = { code: "ATH", nameHe: "אתונה", nameEn: "Athens", countryCode: "GR", kind: "city", airports: ["ATH"] };

describe("country suggestion in the destination autocomplete", () => {
  it("renders the country row with its Hebrew name, airport count and top airport", () => {
    const html = renderToStaticMarkup(<CountryOptionContent country={greece} />);
    expect(html).toContain("יוון");
    expect(html).toContain("3 שדות תעופה");
    expect(html).toContain("Greece");
    expect(html).toContain(">ATH<");
  });

  it("renders a chip per airport, the searched one pressed, with a Hebrew group label", () => {
    const html = renderToStaticMarkup(<CountryAirportChips country={greece} selected="ATH" onPick={() => {}} />);
    expect(html).toContain('aria-label="שדות תעופה ביוון"');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*אתונה/);
    expect(html).toContain("סלוניקי");
    expect(html).toContain("Heraklion"); // no Hebrew city name: English, never guessed
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });

  it("shows no chips for a one-airport country", () => {
    const one = { ...greece, airports: ["ATH"], places: greece.places.slice(0, 1) };
    expect(renderToStaticMarkup(<CountryAirportChips country={one} selected="ATH" onPick={() => {}} />)).toBe("");
  });

  it("puts an exactly named country first and a still-typed one after the cities", () => {
    expect(mergeOptions([athens], [greece]).map((o) => o.type)).toEqual(["country", "place"]);
    expect(mergeOptions([athens], [{ ...greece, match: "partial" }]).map((o) => o.type)).toEqual(["place", "country"]);
    expect(mergeOptions([athens], []).map((o) => o.type)).toEqual(["place"]);
  });

  it("older APIs (no countries field) and malformed items are ignored", () => {
    expect(cleanCountries(undefined)).toEqual([]);
    expect(cleanCountries({})).toEqual([]);
    expect(cleanCountries([null, { type: "city" }, { ...greece, places: [] }, { ...greece, places: [{ code: "x" }] }])).toEqual([]);
    expect(cleanCountries([greece])).toEqual([greece]);
  });

  it("picking a country (click, or Enter on the first row) searches its top airport and keeps its chips", () => {
    // Enter with no active row picks items[0]; an exactly named country is items[0].
    const first = mergeOptions([athens], [greece])[0]!;
    expect(chooseOption(first)).toEqual({ code: "ATH", name: "אתונה", status: "נבחרה יוון: אתונה. אפשר לבחור שדה תעופה אחר מהרשימה.", country: greece, countryPick: "ATH" });
    // A top airport with no Hebrew city name is labelled in English, never guessed.
    const herFirst = { ...greece, places: [greece.places[2]!, ...greece.places.slice(0, 2)] };
    expect(chooseOption({ type: "country", country: herFirst })).toMatchObject({ code: "HER", name: "Heraklion" });
    expect(chooseOption({ type: "country", country: { ...greece, places: [] } })).toBeNull();
  });

  it("picking a city row clears the country chips", () => {
    expect(chooseOption({ type: "place", place: athens })).toEqual({ code: "ATH", name: "אתונה", status: "נבחר: אתונה", country: null, countryPick: "" });
    const airport: AirportSuggestion = { ...athens, kind: "airport", airportCode: "ATH", airportNameHe: "נמל התעופה אתונה" };
    expect(chooseOption({ type: "place", place: airport })).toMatchObject({ code: "ATH", name: "נמל התעופה אתונה", country: null });
  });

  it("chips follow the form's destination: hidden when it moves outside the country, re-pressed inside it", () => {
    expect(countryChips(null, "", "ATH")).toBeNull();
    expect(countryChips(greece, "ATH")).toEqual({ country: greece, selected: "ATH" });
    expect(countryChips(greece, "ATH", "ATH")).toEqual({ country: greece, selected: "ATH" });
    // A popular-destination button set Rome: the Greek chips must not stay pressed.
    expect(countryChips(greece, "ATH", "FCO")).toBeNull();
    expect(countryChips(greece, "ATH", "")).toBeNull();
    // A button set another Greek airport: that chip is the pressed one.
    expect(countryChips(greece, "ATH", "SKG")).toEqual({ country: greece, selected: "SKG" });
  });
});
