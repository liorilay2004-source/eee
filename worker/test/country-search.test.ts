/** countries/search.ts: Hebrew (and English) country names -> that country's destination airports. */
import { describe, expect, it } from "vitest";
import { resolveLocation } from "../src/airports/resolve";
import { directSeen } from "../src/airports/served";
import type { CityRecord } from "../src/airports/types";
import { createCountryIndex, MAX_COUNTRY_AIRPORTS, searchCountries } from "../src/countries/search";

const codes = (q: string) => searchCountries(q).map((c) => c.code);

describe("searchCountries (bundled data)", () => {
  it("יוון -> Greece with ATH first (served from TLV and most popular)", () => {
    const [gr] = searchCountries("יוון");
    expect(gr).toMatchObject({ type: "country", code: "GR", nameHe: "יוון" });
    expect(gr?.airports[0]).toBe("ATH");
    expect(gr?.airports).toEqual(expect.arrayContaining(["ATH", "SKG", "HER", "RHO"]));
    expect(gr?.places.map((p) => p.code)).toEqual(gr?.airports);
    expect(gr?.places[0]).toMatchObject({ code: "ATH", cityCode: "ATH", nameHe: "אתונה", direct: true });
    expect(gr!.airports.length).toBeLessThanOrEqual(MAX_COUNTRY_AIRPORTS);
    expect(new Set(gr!.airports).size).toBe(gr!.airports.length);
  });

  it("קפריסין -> LCA and PFO", () => {
    const [cy] = searchCountries("קפריסין");
    expect(cy?.code).toBe("CY");
    expect([...(cy?.airports ?? [])].sort()).toEqual(["LCA", "PFO"]);
  });

  it("orders airports seen direct from TLV before unserved ones, then by popularity", () => {
    // The US mixes both in the bundled snapshot (JFK/EWR direct, SFO not), so the check below cannot pass vacuously.
    const [us] = searchCountries("ארה\"ב");
    const flags = us!.places.map((p) => p.direct);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
    expect(flags.slice(flags.indexOf(false))).not.toContain(true);
    for (const p of us!.places) expect(p.direct).toBe(directSeen("TLV", p.code));
  });

  it("never offers Israel (the hub's own country) as a destination country", () => {
    for (const q of ["ישראל", "ישר", "Israel"]) expect(codes(q)).not.toContain("IL");
  });

  it("English aliases for names the runtime spells differently (Türkiye, Czechia)", () => {
    expect(codes("turkey")).toEqual(["TR"]);
    expect(codes("Czech Republic")).toEqual(["CZ"]);
    expect(codes("USA")).toEqual(["US"]);
  });

  it("normalizes: whitespace, niqqud, geresh/apostrophe variants, final letters, English case", () => {
    expect(codes("  יוון  ")).toEqual(["GR"]);
    expect(codes("קַפְרִיסִין")).toEqual(["CY"]);
    expect(codes("צ׳כיה")).toEqual(["CZ"]);
    expect(codes("צ'כיה")).toEqual(["CZ"]);
    expect(codes("צכיה")).toEqual(["CZ"]);
    expect(codes("ארה\"ב")).toEqual(["US"]);
    expect(codes("ארה״ב")).toEqual(["US"]);
    expect(codes("GREECE")).toEqual(["GR"]);
    expect(codes("greece")).toEqual(["GR"]);
  });

  it("matches while typing (prefix) and by a later word (הרפובליקה הדומיניקנית)", () => {
    expect(codes("יוו")).toContain("GR");
    expect(searchCountries("יוו")[0]?.match).toBe("partial");
    expect(searchCountries("יוון")[0]?.match).toBe("exact");
    expect(codes("קפרי")).toContain("CY");
    expect(codes("דומיניקנית")).toEqual(["DO"]);
  });

  it("unknown, too short or garbage -> none", () => {
    for (const q of ["", " ", "י", "gr", "זזזזז", "atlantis", "x".repeat(500), "(.*)[\\", "\u0000\u0001"]) {
      expect(searchCountries(q)).toEqual([]);
    }
    expect(searchCountries("יוון", 0)).toEqual([]);
  });

  it("a city name is not a country: exact city matches get no country suggestion", () => {
    for (const q of ["אתונה", "פריז", "לרנקה", "Barcelona", "TLV"]) expect(searchCountries(q)).toEqual([]);
  });

  it("drops a one-airport country whose airport the city results already offer (מלטה, סינגפור)", () => {
    for (const q of ["מלטה", "סינגפור"]) {
      const covered = new Set(resolveLocation(q).flatMap((r) => r.airports));
      expect(searchCountries(q, 3, covered)).toEqual([]);
    }
    // Multi-airport countries stay even when a city alias already matches the country name.
    const covered = new Set(resolveLocation("קפריסין").flatMap((r) => r.airports));
    expect(searchCountries("קפריסין", 3, covered).map((c) => c.code)).toEqual(["CY"]);
  });

  it("respects the limit", () => {
    expect(searchCountries("או", 1)).toHaveLength(1);
    expect(searchCountries("או").length).toBeLessThanOrEqual(3);
  });

  it("city results are untouched (ranking regression)", () => {
    expect(resolveLocation("אתונה")[0]?.code).toBe("ATH");
    expect(resolveLocation("קפריסין")[0]?.code).toBe("LCA");
  });
});

describe("createCountryIndex", () => {
  const city = (cityIata: string, countryCode: string, popularity: number, airports: string[], cityHe = ""): CityRecord => ({
    cityIata, cityEn: cityIata, cityHe, countryCode, popularity, airports: airports.map((iata) => ({ iata, nameEn: iata })), nearby: [],
  });
  const cities = [city("AAA", "XA", 90, ["AAA"]), city("BBB", "XA", 50, ["BBB"]), city("CCC", "XA", 10, ["CCC"]), city("DDD", "XA", 99, ["DDD"]), city("EEE", "XB", 5, ["EEE"])];
  const names = { XA: { nameHe: "ארץ־בדיקה" }, XB: { nameHe: "ארצות אחרות" }, XC: { nameHe: "ארץ ריקה" } };

  it("orders direct-from-TLV first, then popularity; drops airports without scheduled service; skips countries with no airports", () => {
    const idx = createCountryIndex(cities, names, (c) => c === "CCC" || c === "BBB", (c) => c === "DDD", () => null);
    const res = idx.searchCountries("ארץ בדיקה");
    expect(res.map((c) => c.code)).toEqual(["XA"]);
    expect(res[0]?.airports).toEqual(["BBB", "CCC", "AAA"]);
    expect(res[0]?.nameEn).toBeNull();
    expect(idx.searchCountries("ארץ ריקה")).toEqual([]);
  });

  it("works without English names (Intl unavailable)", () => {
    const idx = createCountryIndex(cities, names, () => false, () => false, () => null);
    expect(idx.searchCountries("xa land")).toEqual([]);
    expect(idx.searchCountries("ארצות").map((c) => c.code)).toEqual(["XB"]);
  });
});
