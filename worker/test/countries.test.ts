/** countries/countries.ts: lookups over the bundled src/countries/countries.json (Unicode CLDR, Unicode License V3). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import raw from "../src/countries/countries.json";
import { COUNTRIES_ATTRIBUTION, COUNTRIES_CLDR_VERSION, countryInfo, countryNameHe, currencyNameHe, currencyOf } from "../src/countries/countries";

const worker = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("countryNameHe / currencyOf / currencyNameHe", () => {
  it("names countries in Hebrew", () => {
    expect(countryNameHe("FR")).toBe("צרפת");
    expect(countryNameHe("IL")).toBe("ישראל");
    expect(countryNameHe("GR")).toBe("יוון");
  });

  it("gives each country's current currency", () => {
    expect(currencyOf("IL")).toBe("ILS");
    expect(currencyOf("GR")).toBe("EUR"); // not the drachma (GRD, ended 2002)
    expect(currencyOf("FR")).toBe("EUR");
    expect(currencyOf("US")).toBe("USD");
    expect(currencyOf("GB")).toBe("GBP");
    expect(currencyOf("AQ")).toBeNull(); // a territory CLDR gives no currency
  });

  it("names currencies in Hebrew", () => {
    expect(currencyNameHe("EUR")).toBe("אירו");
    expect(currencyNameHe("ILS")).toBe("שקל חדש");
    expect(countryInfo("GR")).toEqual({ nameHe: "יוון", currency: "EUR", currencyHe: "אירו" });
  });

  it("is case-insensitive and trims", () => {
    expect(countryNameHe("fr")).toBe("צרפת");
    expect(countryNameHe(" Fr ")).toBe("צרפת");
    expect(currencyOf("il")).toBe("ILS");
    expect(currencyNameHe("eur")).toBe("אירו");
  });

  it.each([null, undefined, "", " ", "F", "FRA", "F1", "12", "001", "QQ", "EU", "ZZ", "__proto__", "constructor", "צר", 42, {}, ["FR"]])(
    "junk %j -> null",
    (bad) => {
      expect(countryNameHe(bad)).toBeNull();
      expect(currencyOf(bad)).toBeNull();
      expect(countryInfo(bad)).toBeNull();
    },
  );

  it.each([null, "", "EU", "EURO", "XXX", "GRD", "__proto__", 7])("unknown currency %j -> null", (bad) => {
    expect(currencyNameHe(bad)).toBeNull();
  });
});

describe("bundled countries.json", () => {
  const countries = raw.countries as Record<string, { nameHe: unknown; currency: unknown; currencyHe: unknown }>;
  const keys = Object.keys(countries);

  it("covers more than 200 countries", () => {
    expect(keys.length).toBeGreaterThan(200);
  });

  it("has only ISO 3166-1 alpha-2 style keys: no numeric groupings, no -alt- variants, no EU/UN/ZZ", () => {
    for (const k of keys) expect(k).toMatch(/^[A-Z]{2}$/);
    for (const k of ["001", "150", "EU", "EZ", "UN", "QO", "XA", "XB", "ZZ", "US-alt-short"]) expect(keys, k).not.toContain(k);
  });

  it("drops ISO 3166 exceptionally reserved / CLDR-only territories, keeps XK (Kosovo)", () => {
    for (const k of ["AC", "CP", "CQ", "DG", "EA", "IC", "TA"]) expect(keys, k).not.toContain(k);
    expect(countryNameHe("XK")).toMatch(/[א-ת]/);
  });

  it("uses CLDR's short name for Hong Kong and Macao, so a card does not read \"הונג קונג, הונג קונג (…)\"", () => {
    expect(countryNameHe("HK")).toBe("הונג קונג");
    expect(countryNameHe("MO")).toBe("מקאו");
    expect(currencyOf("HK")).toBe("HKD");
  });

  it("only Antarctica has no current currency", () => {
    expect(keys.filter((k) => countries[k]?.currency === null)).toEqual(["AQ"]);
  });

  it("every row is small and well-formed: Hebrew name, ISO 4217 currency (or null) with a Hebrew name", () => {
    for (const [k, v] of Object.entries(countries)) {
      expect(Object.keys(v).sort(), k).toEqual(["currency", "currencyHe", "nameHe"]);
      expect(v.nameHe, k).toMatch(/[א-ת]/);
      if (v.currency === null) expect(v.currencyHe, k).toBeNull();
      else expect(v.currency, k).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("records source, licence and pinned version, and ships the Unicode licence notice", () => {
    expect(raw.source).toMatch(/Unicode CLDR/);
    expect(raw.license).toMatch(/Unicode License V3/);
    expect(COUNTRIES_CLDR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(COUNTRIES_ATTRIBUTION).toBe("Unicode CLDR, Unicode License V3");
    const notices = readFileSync(join(worker, "THIRD_PARTY_NOTICES"), "utf8");
    expect(notices).toMatch(/UNICODE LICENSE V3/);
    expect(notices).toMatch(/Copyright © \d{4}-\d{4} Unicode, Inc\./);
    expect(notices).toMatch(/Permission is hereby granted, free of charge/);
    expect(notices).toContain(COUNTRIES_CLDR_VERSION);
  });
});
