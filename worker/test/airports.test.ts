/** City/airport resolver: normalization, ranking, code helpers, garbage safety. Runs against a fixture, plus the real dataset when present. */
import { describe, expect, it } from "vitest";
import sample from "./fixtures/cities.sample.json";
import {
  airportsForCode,
  cityNameEn,
  cityNameHe,
  countryOfAirport,
  createResolver,
  nearbyAirports,
  normalizeQuery,
  resolveLocation,
  resolvePlace,
} from "../src/airports/resolve";
import type { CityRecord, LocationMatch } from "../src/airports/types";

const SAMPLE: CityRecord[] = sample;
const r = createResolver(SAMPLE);
const codes = (ms: LocationMatch[]): string[] => ms.map((m) => m.code);

// The real dataset is written by another agent; its checks are skipped while the file is absent.
let real: CityRecord[] | null = null;
try {
  real = (await import("../src/airports/cities.json")).default as unknown as CityRecord[];
} catch {
  real = null;
}

describe("normalizeQuery", () => {
  it("strips niqqud and cantillation", () => {
    const withNiqqud = "בַּרְצֵלוֹנָה";
    expect(normalizeQuery(withNiqqud)).toBe("ברצלונה");
    expect(normalizeQuery("ל֑ונדוׇן")).toBe(normalizeQuery("לונדון"));
  });

  it("folds Hebrew final letters to regular forms", () => {
    expect(normalizeQuery("לונדון")).toBe(normalizeQuery("לונדונ"));
    expect(normalizeQuery("ךםןףץ")).toBe("כמנפצ");
  });

  it("drops the whole geresh/apostrophe/quote family", () => {
    for (const q of ["ג'ירונה", "ג׳ירונה", "ג’ירונה", "ג`ירונה", "ג״ירונה", 'ג"ירונה']) {
      expect(normalizeQuery(q)).toBe(normalizeQuery("גירונה"));
    }
    expect(normalizeQuery('ארה"ב')).toBe(normalizeQuery("ארהב"));
    expect(normalizeQuery("O'Hare")).toBe("ohare");
  });

  it("turns hyphens and maqaf into spaces and collapses whitespace", () => {
    expect(normalizeQuery("ניו-יורק")).toBe("ניו יורק");
    expect(normalizeQuery("ניו־יורק")).toBe("ניו יורק");
    expect(normalizeQuery("  ניו \t\n  יורק  ")).toBe("ניו יורק");
    expect(normalizeQuery("Tel-Aviv")).toBe("tel aviv");
  });

  it("drops bidi marks and zero-width characters without leaving gaps", () => {
    expect(normalizeQuery("‏תל‎ אביב​‌‍﻿")).toBe("תל אביב");
    expect(normalizeQuery("‫תל‬ אביב")).toBe("תל אביב");
  });

  it("drops every format control, not just the common bidi marks (Arabic letter mark, variation selectors...)", () => {
    expect(normalizeQuery("ת\u061Cל אביב")).toBe("תל אביב"); // U+061C inside a word must not split it
    expect(normalizeQuery("TLV\uFE0F")).toBe("tlv"); // emoji variation selector
    expect(normalizeQuery("\u2708\uFE0F TLV")).toBe("tlv"); // "✈️ TLV"
    expect(normalizeQuery("T\u2061L\u2062V\u2063\u2064")).toBe("tlv"); // invisible math operators
    expect(normalizeQuery("T\u180EL\u00ADV")).toBe("tlv"); // Mongolian vowel separator, soft hyphen
    expect(normalizeQuery("\uFE00\uFE0F")).toBe("");
  });

  it("lowercases Latin and folds accents", () => {
    expect(normalizeQuery("  SÃO  Paulo ")).toBe("sao paulo");
    expect(normalizeQuery("Zürich")).toBe("zurich");
    expect(normalizeQuery("København")).toBe("kobenhavn");
    expect(normalizeQuery("Łódź")).toBe("lodz");
    expect(normalizeQuery("İstanbul")).toBe("istanbul");
  });

  it("unpacks Hebrew presentation forms", () => {
    expect(normalizeQuery("שׁ")).toBe("ש"); // shin with shin dot
  });

  it("neutralizes punctuation, controls and non-strings", () => {
    expect(normalizeQuery(".*")).toBe("");
    expect(normalizeQuery("a.b/c")).toBe("a b c");
    expect(normalizeQuery("\u0000\u0001x\u0007")).toBe("x");
    expect(normalizeQuery(null as unknown as string)).toBe("");
    expect(normalizeQuery(undefined as unknown as string)).toBe("");
    expect(normalizeQuery(42 as unknown as string)).toBe("");
  });
});

describe("resolveLocation: codes", () => {
  it("matches city and airport codes case-insensitively", () => {
    for (const q of ["TLV", "tlv", " Tlv "]) expect(r.resolveLocation(q)[0]?.code).toBe("TLV");
    const lon = r.resolveLocation("lon")[0];
    expect(lon).toMatchObject({ code: "LON", kind: "city", nameEn: "London", nameHe: "לונדון", countryCode: "GB" });
    expect(lon?.airports).toEqual(["LHR", "LGW", "STN", "LTN", "LCY"]);
  });

  it("returns an airport match for an airport code inside a multi-airport city", () => {
    const [m] = r.resolveLocation("LHR");
    expect(m).toEqual({
      code: "LON",
      kind: "airport",
      airportCode: "LHR",
      airportNameEn: "Heathrow Airport",
      nameHe: "לונדון",
      nameEn: "London",
      countryCode: "GB",
      airports: ["LHR"],
    });
  });

  it("prefers the city match when the city code equals its own airport code", () => {
    const res = r.resolveLocation("TLV");
    expect(res).toHaveLength(1);
    expect(res[0]?.kind).toBe("city");
    expect(res[0]?.airportCode).toBeUndefined();
    expect(res[0]?.airports).toEqual(["TLV"]);
  });

  it("ranks an exact code above any name match", () => {
    // "san" is San Diego's code although San Francisco is far more popular and only a prefix match.
    expect(codes(r.resolveLocation("san"))).toEqual(["SAN", "SFO", "SCL"]);
  });
});

describe("resolveLocation: names", () => {
  it("finds Hebrew and English names", () => {
    expect(r.resolveLocation("תל אביב")[0]?.code).toBe("TLV");
    for (const q of ["tel aviv", "TEL AVIV", "Tel-Aviv"]) expect(r.resolveLocation(q)[0]?.code).toBe("TLV");
    expect(r.resolveLocation("ברצלונה")[0]).toMatchObject({ code: "BCN", nameHe: "ברצלונה", nameEn: "Barcelona" });
  });

  it("matches Hebrew prefixes as the user types", () => {
    expect(r.resolveLocation("תל")[0]?.code).toBe("TLV");
    expect(r.resolveLocation("ברצ")[0]?.code).toBe("BCN");
    // All three are prefix matches, so popularity decides: San Francisco 88, Santiago 70, San Diego 60.
    expect(codes(r.resolveLocation("סן"))).toEqual(["SFO", "SCL", "SAN"]);
  });

  it("ignores niqqud in the query", () => {
    const withNiqqud = "בַּרְצֵלוֹנָה";
    expect(r.resolveLocation(withNiqqud)[0]?.code).toBe("BCN");
  });

  it("matches final and regular letter forms alike", () => {
    expect(r.resolveLocation("לונדונ")[0]?.code).toBe("LON");
    expect(r.resolveLocation("אמסטרדמ")[0]?.code).toBe("AMS");
    expect(r.resolveLocation("אמסטרדם")[0]?.code).toBe("AMS");
  });

  it("lets a geresh query match a name without one (and the other way round)", () => {
    for (const q of ["ג'ירונה", "ג׳ירונה", "ג’ירונה", "גירונה"]) {
      expect(r.resolveLocation(q)[0]?.code).toBe("GRO");
    }
    // The dataset spells Geneva with a geresh; users may or may not type it.
    for (const q of ["ג'נבה", "ג׳נבה", "גנבה", "ז'נבה", "זנבה"]) {
      expect(r.resolveLocation(q)[0]?.code).toBe("GVA");
    }
  });

  it("treats hyphen and maqaf as spaces", () => {
    for (const q of ["ניו-יורק", "ניו־יורק", "new-york", "New  York"]) {
      expect(r.resolveLocation(q)[0]?.code).toBe("NYC");
    }
  });

  it("finds aliases in both languages", () => {
    expect(r.resolveLocation("londres")[0]?.code).toBe("LON");
    expect(r.resolveLocation("לונדן")[0]?.code).toBe("LON");
    expect(r.resolveLocation('ת"א')[0]?.code).toBe("TLV");
    expect(r.resolveLocation("תא")[0]?.code).toBe("TLV");
    expect(r.resolveLocation("big apple")[0]?.code).toBe("NYC");
    expect(r.resolveLocation("בארסלונה")[0]?.code).toBe("BCN");
    expect(r.resolveLocation("København")[0]?.code).toBe("CPH");
    expect(r.resolveLocation("kobenhavn")[0]?.code).toBe("CPH");
  });

  it("returns null for a missing Hebrew name instead of guessing", () => {
    const [m] = r.resolveLocation("puerto berrio");
    expect(m).toMatchObject({ code: "PBE", nameHe: null, nameEn: "Puerto Berrio" });
  });

  it("matches airport names and reports them as airport matches", () => {
    expect(r.resolveLocation("heathrow")[0]).toMatchObject({ code: "LON", kind: "airport", airportCode: "LHR", airports: ["LHR"] });
    expect(r.resolveLocation("gatwick")[0]).toMatchObject({ kind: "airport", airportCode: "LGW" });
    expect(r.resolveLocation("ben gurion")[0]).toMatchObject({
      code: "TLV",
      kind: "airport",
      airportCode: "TLV",
      airportNameEn: "Ben Gurion Airport",
    });
    expect(r.resolveLocation("london city")[0]).toMatchObject({ kind: "airport", airportCode: "LCY" });
  });

  it("returns one city-level result per city even when many of its names match", () => {
    const res = r.resolveLocation("london");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ code: "LON", kind: "city" });
    expect(res[0]?.airports).toHaveLength(5);
  });
});

describe("resolveLocation: ranking", () => {
  it("orders IATA > prefix > word prefix > substring, ties by popularity", () => {
    const res = r.resolveLocation("ber");
    // BER exact code; Bergen (45) before Bern (30) as prefixes; Puerto Berrio is a word prefix;
    // Newark Liberty (98, an airport-name hit) before Kimberley (20) as substring matches.
    expect(codes(res)).toEqual(["BER", "BGO", "BRN", "PBE", "NYC", "KIM"]);
    expect(res[4]).toMatchObject({ kind: "airport", airportCode: "EWR" });
  });

  it("lets a better match tier beat popularity", () => {
    // New York (98) only matches "york" on a word boundary, Yorkton (20) as a prefix, York (5) exactly.
    expect(codes(r.resolveLocation("york"))).toEqual(["THV", "YQV", "NYC"]);
  });

  it("ranks exact names above prefixes", () => {
    expect(codes(r.resolveLocation("bern"))).toEqual(["BRN"]);
  });

  it("finds word prefixes and substrings", () => {
    expect(codes(r.resolveLocation("aviv"))).toEqual(["TLV"]);
    expect(codes(r.resolveLocation("viv"))).toEqual(["TLV", "LWO"]);
    expect(codes(r.resolveLocation("ork"))).toEqual(["NYC", "YQV", "THV"]);
  });

  it("breaks ties by popularity regardless of dataset order", () => {
    // Two cities are named exactly "Paris"; Paris (96) outranks Paris, Texas (8).
    expect(codes(r.resolveLocation("paris"))).toEqual(["PAR", "PRX"]);
    const reversed = createResolver([...SAMPLE].reverse());
    expect(codes(reversed.resolveLocation("paris"))).toEqual(["PAR", "PRX"]);
    expect(codes(reversed.resolveLocation("ber"))).toEqual(["BER", "BGO", "BRN", "PBE", "NYC", "KIM"]);
  });

  it("respects the limit and never repeats a city", () => {
    expect(r.resolveLocation("a")).toHaveLength(8);
    expect(r.resolveLocation("a", 3)).toHaveLength(3);
    const all = r.resolveLocation("a", 1000);
    expect(new Set(codes(all)).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(SAMPLE.length);
    expect(r.resolveLocation("a", 0)).toEqual([]);
    expect(r.resolveLocation("a", -5)).toEqual([]);
    expect(r.resolveLocation("a", Number.NaN)).toHaveLength(8);
    expect(r.resolveLocation("a", 2.9)).toHaveLength(2);
  });

  it("keeps match fields consistent with the helper functions", () => {
    for (const q of ["lon", "lhr", "york", "ber", "תל", "a", "airport", "heathrow"]) {
      for (const m of r.resolveLocation(q, 50)) {
        expect(m.airports).toEqual(r.airportsForCode(m.airportCode ?? m.code));
        expect(m.countryCode).toBe(r.countryOfAirport(m.code));
        expect(m.nameEn).toBe(r.cityNameEn(m.code));
        expect(m.nameHe).toBe(r.cityNameHe(m.code));
        expect(m.kind === "airport").toBe(m.airportCode !== undefined);
      }
    }
  });

  it("does not let callers mutate the resolver's data through results", () => {
    const first = r.resolveLocation("lon")[0];
    first?.airports.push("XXX");
    expect(r.resolveLocation("lon")[0]?.airports).toHaveLength(5);
  });
});

describe("resolveLocation: garbage input", () => {
  const garbage: unknown[] = [
    "",
    "   ",
    "\u0000\u0001\u0002",
    "\n\t\r",
    ".*",
    "(",
    ")",
    "[a-z",
    "\\",
    "?",
    "+++",
    "$^",
    "(?<x>.)\\1",
    "‏‎",
    "🙂🙂",
    "\uD800",
    "'\"`",
    null,
    undefined,
    42,
    {},
    [],
  ];

  it("returns [] without throwing", () => {
    for (const g of garbage) expect(r.resolveLocation(g as string)).toEqual([]);
  });

  it("treats regex metacharacters as plain text", () => {
    expect(r.resolveLocation(".*")).toEqual([]); // as a regex this would match every city
    expect(r.resolveLocation("tel|lon")).toEqual([]);
    expect(r.resolveLocation("t.l")).toEqual([]);
    expect(r.resolveLocation("(tel aviv")[0]?.code).toBe("TLV");
  });

  it("rejects over-long queries", () => {
    expect(r.resolveLocation("a".repeat(65))).toEqual([]);
    expect(r.resolveLocation("a".repeat(10_000))).toEqual([]);
    expect(() => r.resolveLocation("a".repeat(64))).not.toThrow();
    // Length is judged after normalization, so invisible characters do not push a real name over the limit.
    expect(r.resolveLocation("ְ".repeat(70) + "תל אביב")[0]?.code).toBe("TLV");
    expect(r.resolveLocation("ְ".repeat(300) + "תל אביב")).toEqual([]);
  });

  it("survives random mixed-script noise with well-formed results", () => {
    const pool = [..."abcxyzTLV ניו-יורק ג'ירונהםןךףץ.*+?^${}()|[]\\/ְ־֑‏‎\u0000\u0007é🙂𐀀"];
    let seed = 12345; // fixed LCG: reproducible, no Math.random flakiness
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const q = Array.from({ length: next(20) }, () => pool[next(pool.length)]).join("");
      const res = r.resolveLocation(q, 5);
      expect(res.length).toBeLessThanOrEqual(5);
      expect(new Set(codes(res)).size).toBe(res.length);
    }
  });

  it("is safe for the other helpers too", () => {
    for (const g of garbage) {
      expect(r.airportsForCode(g as string)).toEqual([]);
      expect(r.nearbyAirports(g as string)).toEqual([]);
      expect(r.countryOfAirport(g as string)).toBeNull();
      expect(r.cityNameHe(g as string)).toBeNull();
      expect(r.cityNameEn(g as string)).toBeNull();
    }
  });
});

describe("code helpers", () => {
  it("expands a city code to its airports, and an airport code to itself", () => {
    expect(r.airportsForCode("LON")).toEqual(["LHR", "LGW", "STN", "LTN", "LCY"]);
    expect(r.airportsForCode("lon")).toEqual(["LHR", "LGW", "STN", "LTN", "LCY"]);
    expect(r.airportsForCode(" nyc ")).toEqual(["JFK", "LGA", "EWR"]);
    expect(r.airportsForCode("LHR")).toEqual(["LHR"]);
    expect(r.airportsForCode("TLV")).toEqual(["TLV"]);
    expect(r.airportsForCode("XXX")).toEqual([]);
    expect(r.airportsForCode("")).toEqual([]);
    expect(r.airportsForCode("LONDON")).toEqual([]);
  });

  it("returns copies", () => {
    r.airportsForCode("LON").push("XXX");
    expect(r.airportsForCode("LON")).toHaveLength(5);
  });

  it("lists nearby airports that the code does not already cover", () => {
    expect(r.nearbyAirports("BCN")).toEqual(["GRO", "REU"]);
    expect(r.nearbyAirports("bcn")).toEqual(["GRO", "REU"]);
    expect(r.nearbyAirports("ETM")).toEqual(["AQJ"]);
    expect(r.nearbyAirports("TLV")).toEqual([]);
    expect(r.nearbyAirports("XXX")).toEqual([]);
    // City code: its own airports are covered, so LHR in the raw list is dropped.
    expect(r.nearbyAirports("LON")).toEqual(["SEN"]);
    // Airport code: sibling airports of the city come first, then the city's nearby list, never itself.
    expect(r.nearbyAirports("LHR")).toEqual(["LGW", "STN", "LTN", "LCY", "SEN"]);
    expect(r.nearbyAirports("JFK")).toEqual(["LGA", "EWR", "HPN", "ISP"]);
  });

  it("returns the country of a city or airport code", () => {
    expect(r.countryOfAirport("LHR")).toBe("GB");
    expect(r.countryOfAirport("lon")).toBe("GB");
    expect(r.countryOfAirport("JFK")).toBe("US");
    expect(r.countryOfAirport("TLV")).toBe("IL");
    expect(r.countryOfAirport("ZZZ")).toBeNull();
    expect(r.countryOfAirport("")).toBeNull();
  });

  it("returns city names for city and airport codes", () => {
    expect(r.cityNameHe("LHR")).toBe("לונדון");
    expect(r.cityNameHe("nyc")).toBe("ניו יורק");
    expect(r.cityNameHe("PRX")).toBeNull(); // no Hebrew name in the dataset
    expect(r.cityNameHe("ZZZ")).toBeNull();
    expect(r.cityNameEn("EWR")).toBe("New York");
    expect(r.cityNameEn("prx")).toBe("Paris");
    expect(r.cityNameEn("ZZZ")).toBeNull();
  });
});

describe("createResolver on imperfect data", () => {
  const base = (over: Partial<CityRecord>): CityRecord => ({
    cityIata: "AAA", cityEn: "Alpha", cityHe: "", countryCode: "us", popularity: 10,
    airports: [{ iata: "AAA", nameEn: "Alpha Airport" }], nearby: [], ...over,
  });

  it("keeps the first record of a duplicated city code", () => {
    const res = createResolver([base({ cityEn: "First" }), base({ cityEn: "Second" })]);
    expect(res.resolveLocation("aaa").map((m) => m.nameEn)).toEqual(["First"]);
    expect(res.resolveLocation("second")).toEqual([]);
  });

  it("skips malformed records and tolerates missing optional fields", () => {
    const junk = [null, undefined, {}, { cityIata: 5 }, base({ cityIata: "  " })] as unknown as CityRecord[];
    const bare = { cityIata: "bbb", cityEn: "Beta" } as unknown as CityRecord;
    const res = createResolver([...junk, bare, base({})]);
    expect(res.resolveLocation("beta")[0]).toMatchObject({ code: "BBB", nameHe: null, airports: [] });
    expect(res.resolveLocation("alpha")[0]?.code).toBe("AAA");
  });

  it("upper-cases codes and country codes from the data", () => {
    const res = createResolver([
      base({ cityIata: "xyz", countryCode: "il", airports: [{ iata: "xyz", nameEn: "X" }, { iata: "xy2", nameEn: "Y" }], nearby: ["qqq", "QQQ", "xyz"] }),
    ]);
    expect(res.airportsForCode("XYZ")).toEqual(["XYZ", "XY2"]);
    expect(res.countryOfAirport("xy2")).toBe("IL");
    expect(res.nearbyAirports("XYZ")).toEqual(["QQQ"]);
  });

  it("handles an empty dataset", () => {
    const res = createResolver([]);
    expect(res.resolveLocation("tlv")).toEqual([]);
    expect(res.airportsForCode("TLV")).toEqual([]);
  });

  it("stays fast on a 1000-city dataset", () => {
    const big: CityRecord[] = Array.from({ length: 1000 }, (_, i) => {
      const code = String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 65 + Math.floor(i / 676));
      return base({
        cityIata: code, cityEn: `City ${code} Springs`, cityHe: `עיר ${code}`, popularity: 1 + (i % 100),
        airports: [{ iata: code, nameEn: `${code} International Airport` }],
        aliasesEn: [`Alias ${i}`], aliasesHe: [`כינוי ${i}`],
      });
    });
    const started = performance.now();
    const res = createResolver(big);
    for (let i = 0; i < 200; i++) res.resolveLocation(i % 2 ? "spr" : "כינוי 1");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("singleton helpers (bound to cities.json)", () => {
  it.skipIf(real === null)("agree with a resolver built from the same file", () => {
    const fresh = createResolver(real as CityRecord[]);
    expect(resolveLocation("tlv")).toEqual(fresh.resolveLocation("tlv"));
    expect(airportsForCode("TLV")).toEqual(fresh.airportsForCode("TLV"));
    expect(nearbyAirports("BCN")).toEqual(fresh.nearbyAirports("BCN"));
    expect(countryOfAirport("TLV")).toBe(fresh.countryOfAirport("TLV"));
    expect(cityNameHe("TLV")).toBe(fresh.cityNameHe("TLV"));
    expect(cityNameEn("TLV")).toBe(fresh.cityNameEn("TLV"));
  });

  it("exposes normalizeQuery unchanged", () => {
    expect(normalizeQuery("ג'ירונה")).toBe("גירונה");
  });
});

describe.skipIf(real === null)("real dataset (src/airports/cities.json)", () => {
  const data = real as CityRecord[];
  const rr = createResolver(data);

  it("has unique, well-formed records", () => {
    expect(data.length).toBeGreaterThan(0);
    const cityCodes = new Set<string>();
    for (const c of data) {
      expect(c.cityIata, "cityIata").toMatch(/^[A-Z0-9]{3}$/);
      expect(cityCodes.has(c.cityIata), `duplicate city ${c.cityIata}`).toBe(false);
      cityCodes.add(c.cityIata);
      expect(c.cityEn.trim(), `${c.cityIata} cityEn`).not.toBe("");
      expect(c.countryCode, `${c.cityIata} countryCode`).toMatch(/^[A-Z]{2}$/);
      expect(c.popularity, `${c.cityIata} popularity`).toBeGreaterThanOrEqual(1);
      expect(c.popularity, `${c.cityIata} popularity`).toBeLessThanOrEqual(100);
      expect(c.airports.length, `${c.cityIata} airports`).toBeGreaterThan(0);
      for (const a of c.airports) expect(a.iata, `${c.cityIata} airport`).toMatch(/^[A-Z0-9]{3}$/);
      for (const n of c.nearby) expect(n, `${c.cityIata} nearby`).toMatch(/^[A-Z0-9]{3}$/);
    }
  });

  it("never lets one airport code belong to two cities", () => {
    const owner = new Map<string, string>();
    for (const c of data) {
      for (const a of c.airports) {
        const prev = owner.get(a.iata);
        expect(prev === undefined || prev === c.cityIata, `${a.iata} in ${prev} and ${c.cityIata}`).toBe(true);
        owner.set(a.iata, c.cityIata);
      }
    }
  });

  it("resolves the cities the product is built around", () => {
    expect(rr.resolveLocation("TLV")[0]?.code).toBe("TLV");
    expect(rr.resolveLocation("תל אביב")[0]?.code).toBe("TLV");
    expect(rr.resolveLocation("Tel Aviv")[0]?.code).toBe("TLV");
    expect(rr.resolveLocation("לונדון")[0]?.code).toBe("LON");
    expect(rr.resolveLocation("ברצלונה")[0]?.code).toBe("BCN");
    expect(rr.resolveLocation("BCN")[0]?.code).toBe("BCN");
    expect(rr.countryOfAirport("TLV")).toBe("IL");
  });

  it("expands LON to Heathrow, Gatwick and the other London airports", () => {
    const lon = rr.airportsForCode("LON");
    expect(lon).toEqual(expect.arrayContaining(["LHR", "LGW"]));
    expect(rr.airportsForCode("LHR")).toEqual(["LHR"]);
    expect(rr.countryOfAirport("LHR")).toBe("GB");
  });

  it("matches a Hebrew name typed with a geresh", () => {
    const gro = data.find((c) => c.cityIata === "GRO");
    if (!gro || !gro.cityHe) return; // Girona is not required to be in the top list
    const typed = gro.cityHe.slice(0, 1) + "׳" + gro.cityHe.slice(1);
    expect(rr.resolveLocation(typed)[0]?.code).toBe("GRO");
  });

  it("finds every Hebrew name and every airport code by exact lookup", () => {
    for (const c of data) {
      const viaCode = rr.resolveLocation(c.cityIata, 50).find((m) => m.code === c.cityIata);
      expect(viaCode, `code ${c.cityIata}`).toBeDefined();
      if (c.cityHe) {
        const viaName = rr.resolveLocation(c.cityHe, 50).map((m) => m.code);
        expect(viaName, `Hebrew name of ${c.cityIata}`).toContain(c.cityIata);
      }
      for (const a of c.airports) expect(rr.airportsForCode(a.iata).length, `airport ${a.iata}`).toBeGreaterThan(0);
    }
  });

  it("gives the same answer for a full Hebrew name with and without niqqud or final-letter changes", () => {
    for (const c of data.slice(0, 200)) {
      if (!c.cityHe) continue;
      const plain = rr.resolveLocation(c.cityHe, 3).map((m) => m.code);
      const decorated = rr.resolveLocation("‏" + c.cityHe.replace(/[ך]/g, "כ") + "‎", 3).map((m) => m.code);
      expect(decorated, c.cityIata).toEqual(plain);
    }
  });
});

// --- fix pass -----------------------------------------------------------------------------------------------

const rr = () => createResolver(real as CityRecord[]);

describe("codes versus names: Goa is not Genoa", () => {
  const rec = (over: Partial<CityRecord>): CityRecord => ({ cityIata: "AAA", cityEn: "A", cityHe: "", countryCode: "IT", popularity: 10, airports: [{ iata: "AAA", nameEn: "A" }], nearby: [], ...over });
  const genoa = rec({ cityIata: "GOA", cityEn: "Genoa", cityHe: "גנואה", popularity: 40, airports: [{ iata: "GOA", nameEn: "Genoa Cristoforo Colombo" }] });
  const goa = rec({ cityIata: "GOI", cityEn: "Goa", cityHe: "גואה", countryCode: "IN", popularity: 74, airports: [{ iata: "GOI", nameEn: "Goa Dabolim" }] });
  const g = createResolver([genoa, goa]);

  it("an exact name typed in lower or mixed case outranks another city's code", () => {
    for (const q of ["Goa", "goa", "gOa"]) expect(codes(g.resolveLocation(q)), q).toEqual(["GOI", "GOA"]);
    expect(codes(g.resolveLocation("גואה"))[0]).toBe("GOI");
  });

  it("the same letters in capitals are a code, and the code wins", () => {
    expect(codes(g.resolveLocation("GOA"))).toEqual(["GOA", "GOI"]);
  });

  it("a code that is nobody's name still resolves in any case", () => {
    for (const q of ["GOI", "goi", "Goi"]) expect(g.resolveLocation(q)[0]?.code, q).toBe("GOI");
  });

  it.skipIf(real === null)("in the real dataset", () => {
    expect(rr().resolveLocation("Goa")[0]?.code).toBe("GOI");
    expect(rr().resolveLocation("GOA")[0]?.code).toBe("GOA");
    expect(rr().resolveLocation("goa").map((m) => m.code)).toContain("GOA"); // Genoa is still offered
  });
});

describe("words around the place name", () => {
  const b = createResolver([
    { cityIata: "LON", cityEn: "London", cityHe: "לונדון", countryCode: "GB", popularity: 90, airports: [{ iata: "LHR", nameEn: "London Heathrow", nameHe: "הית'רו" }, { iata: "LGW", nameEn: "London Gatwick" }], nearby: [] },
    { cityIata: "TLV", cityEn: "Tel Aviv", cityHe: "תל אביב", countryCode: "IL", popularity: 100, airports: [{ iata: "TLV", nameEn: "Tel Aviv Ben Gurion" }], nearby: [], aliasesEn: ["Tel Aviv-Yafo"], aliasesHe: ["בן גוריון"] },
  ]);

  it("ignores 'airport', 'international' and the Hebrew equivalents when they would spoil the match", () => {
    for (const q of ["Ben Gurion Airport", "ben gurion international airport", "נמל התעופה בן גוריון", "שדה תעופה בן גוריון", "Ben Gurion Intl"]) {
      expect(b.resolveLocation(q)[0]?.code, q).toBe("TLV");
    }
    expect(b.resolveLocation("Heathrow Airport")[0]).toMatchObject({ code: "LON", airportCode: "LHR" });
    expect(b.resolveLocation("London Heathrow Airport")[0]).toMatchObject({ airportCode: "LHR" });
    expect(b.resolveLocation("TLV airport")[0]?.code).toBe("TLV");
  });

  it("ignores a trailing country after a comma", () => {
    expect(b.resolveLocation("Tel Aviv, Israel")[0]?.code).toBe("TLV");
    expect(b.resolveLocation("London, UK")[0]?.code).toBe("LON");
    expect(b.resolveLocation("Tel Aviv-Jaffa, Israel")).toEqual([]); // no such alias in this fixture: still no guess
  });

  it("an 'airport' typed on its own does not become an empty query that matches everything", () => {
    expect(b.resolveLocation("airport")).toEqual([]);
    expect(b.resolveLocation("Airport ")).toEqual([]);
    expect(b.resolveLocation(", Israel")).toEqual([]);
  });

  it("a query that matches as typed is never rewritten", () => {
    const withWord = createResolver([{ cityIata: "IST", cityEn: "Istanbul", cityHe: "", countryCode: "TR", popularity: 50, airports: [{ iata: "IST", nameEn: "Istanbul Airport" }, { iata: "SAW", nameEn: "Istanbul Sabiha Gokcen" }], nearby: [] }]);
    expect(withWord.resolveLocation("Istanbul Airport")[0]).toMatchObject({ code: "IST", kind: "airport", airportCode: "IST" });
  });
});

describe("Hebrew airport names", () => {
  const c = createResolver([
    { cityIata: "PAR", cityEn: "Paris", cityHe: "פריז", countryCode: "FR", popularity: 96, airports: [{ iata: "CDG", nameEn: "Paris Charles de Gaulle", nameHe: "שארל דה גול" }, { iata: "ORY", nameEn: "Paris Orly", nameHe: "אורלי" }], nearby: [] },
    { cityIata: "MSY", cityEn: "New Orleans", cityHe: "ניו אורלינס", countryCode: "US", popularity: 60, airports: [{ iata: "MSY", nameEn: "New Orleans Louis Armstrong" }], nearby: [] },
  ]);

  it("picks a specific airport by its Hebrew name, and reports that name", () => {
    expect(c.resolveLocation("אורלי")[0]).toMatchObject({ code: "PAR", kind: "airport", airportCode: "ORY", airportNameHe: "אורלי", airports: ["ORY"] });
    expect(c.resolveLocation("שארל דה גול")[0]).toMatchObject({ airportCode: "CDG" });
    expect(c.resolvePlace("אורלי")).toMatchObject({ airportCode: "ORY" }); // Orly, not New Orleans
  });

  it("an airport without a Hebrew name simply has none", () => {
    const [m] = c.resolveLocation("MSY");
    expect(m).not.toHaveProperty("airportNameHe");
  });
});

describe("resolvePlace (strict resolution of submitted text)", () => {
  const rec = (over: Partial<CityRecord>): CityRecord => ({ cityIata: "AAA", cityEn: "A", cityHe: "", countryCode: "US", popularity: 10, airports: [{ iata: "AAA", nameEn: "A" }], nearby: [], ...over });
  const s = createResolver([
    rec({ cityIata: "SDX", cityEn: "San Diego", popularity: 60, airports: [{ iata: "SDX", nameEn: "San Diego Lindbergh" }] }),
    rec({ cityIata: "SFX", cityEn: "San Francisco", popularity: 88, airports: [{ iata: "SFX", nameEn: "San Francisco International" }, { iata: "OAK", nameEn: "Oakland Metropolitan" }] }),
    rec({ cityIata: "PUJ", cityEn: "Punta Cana", popularity: 50, airports: [{ iata: "PUJ", nameEn: "Punta Cana" }], aliasesEn: ["Dominican Republic"] }),
    rec({ cityIata: "LON", cityEn: "London", cityHe: "לונדון", popularity: 90, airports: [{ iata: "LHR", nameEn: "London Heathrow" }, { iata: "LGW", nameEn: "London Gatwick" }] }),
  ]);

  it("accepts codes and exact names in any case", () => {
    expect(s.resolvePlace("PUJ")).toMatchObject({ code: "PUJ" });
    expect(s.resolvePlace("puj")).toMatchObject({ code: "PUJ" });
    expect(s.resolvePlace(" san diego ")).toMatchObject({ code: "SDX" });
    expect(s.resolvePlace("לונדון")).toMatchObject({ code: "LON", kind: "city" });
    expect(s.resolvePlace("LHR")).toMatchObject({ code: "LON", kind: "airport", airportCode: "LHR" });
  });

  it("refuses prefix, word-prefix and substring hits that autocomplete would show", () => {
    expect(s.resolveLocation("REP")[0]?.code).toBe("PUJ"); // the autocomplete is right to suggest it...
    expect(s.resolvePlace("REP")).toBeNull(); // ...a submitted "REP" is not Punta Cana
    for (const q of ["Punt", "Repub", "Dominic", "Lond", "eathrow", "diego lind"]) expect(s.resolvePlace(q), q).toBeNull();
  });

  it("accepts whole words of a longer name only when they identify exactly one place", () => {
    expect(s.resolvePlace("Heathrow")).toMatchObject({ code: "LON", airportCode: "LHR" });
    expect(s.resolvePlace("Lindbergh")).toMatchObject({ code: "SDX" });
    expect(s.resolvePlace("san")).toBeNull(); // San Diego and San Francisco
    expect(s.resolvePlace("Dominican")).toMatchObject({ code: "PUJ" }); // only one place has this word
  });

  it("does not trust whole-word hits for code-shaped input, and reads an all-caps triple as a code only", () => {
    const t = createResolver([rec({ cityIata: "MDE", cityEn: "Medellin", airports: [{ iata: "MDE", nameEn: "Medellin" }] }), rec({ cityIata: "XYZ", cityEn: "Xyz Med", airports: [{ iata: "XYZ", nameEn: "Xyz Med" }] })]);
    expect(t.resolvePlace("MED")).toBeNull();
    expect(t.resolvePlace("med")).toBeNull(); // a word of "xyz med", but code-shaped: not trusted
    expect(t.resolvePlace("xyz med")).toMatchObject({ code: "XYZ" });
    const kos = createResolver([rec({ cityIata: "KGS", cityEn: "Kos", airports: [{ iata: "KGS", nameEn: "Kos" }] })]);
    expect(kos.resolvePlace("Kos")).toMatchObject({ code: "KGS" });
    expect(kos.resolvePlace("KOS")).toBeNull(); // typed as a code, and there is no such code
  });

  it("looks through 'airport' and the ', country' tail, and is total: never throws", () => {
    expect(s.resolvePlace("London Heathrow Airport")).toMatchObject({ airportCode: "LHR" });
    expect(s.resolvePlace("London, UK")).toMatchObject({ code: "LON" });
    for (const junk of ["", "   ", "x".repeat(300), "\u0000", "🤷", null as unknown as string, 7 as unknown as string]) {
      expect(() => s.resolvePlace(junk)).not.toThrow();
      expect(s.resolvePlace(junk)).toBeNull();
    }
  });

  it.skipIf(real === null)("in the real dataset: unknown places stay unknown, known ones resolve", () => {
    for (const q of ["פולין", "יוון", "צרפת", "Siem Reap", "National", "Barcelo"]) expect(resolvePlace(q), q).toBeNull();
    expect(resolvePlace("REP")).toBeNull(); // not in the dataset: validate passes 3-letter codes through itself
    expect(resolvePlace("TLV")).toMatchObject({ code: "TLV" });
    expect(resolvePlace("Ben Gurion Airport")).toMatchObject({ code: "TLV" });
    expect(resolvePlace("אורלי")).toMatchObject({ airportCode: "ORY" });
    expect(resolvePlace('נתב"ג')).toMatchObject({ code: "TLV" });
    expect(resolvePlace("Goa")).toMatchObject({ code: "GOI" });
  });
});

describe.skipIf(real === null)("real dataset: corrections", () => {
  const data = real as CityRecord[];
  const byCity = (code: string) => data.find((c) => c.cityIata === code);

  it("Ulaanbaatar's airport is UBN (ULN was the old Buyant-Ukhaa airport)", () => {
    expect(byCity("ULN")?.airports.map((a) => a.iata)).toEqual(["UBN"]);
    expect(airportsForCode("UBN")).toEqual(["UBN"]);
    expect(airportsForCode("ULN")).toEqual(["UBN"]); // the city code still expands to its airport
    expect(resolveLocation("UBN")[0]?.code).toBe("ULN");
  });

  it("'פרס' (Persia) is not an alias of Perth", () => {
    expect(byCity("PER")?.aliasesHe ?? []).not.toContain("פרס");
    expect(resolveLocation("פרס").map((m) => m.code)).not.toContain("PER");
    expect(resolveLocation("פרת")[0]?.code).toBe("PER"); // its real name still works
  });

  it("finds Ben Gurion, Ramon, Heathrow, Orly and Charles de Gaulle by their everyday Hebrew names", () => {
    expect(resolveLocation('נתב"ג')[0]).toMatchObject({ code: "TLV", airportCode: "TLV" });
    expect(resolveLocation("נתבג")[0]?.code).toBe("TLV");
    expect(resolveLocation("נמל התעופה בן גוריון")[0]?.code).toBe("TLV");
    expect(resolveLocation("הית'רו")[0]).toMatchObject({ code: "LON", airportCode: "LHR" });
    expect(resolveLocation("היתרו")[0]).toMatchObject({ airportCode: "LHR" });
    expect(resolveLocation("גטוויק")[0]).toMatchObject({ airportCode: "LGW" });
    expect(resolveLocation("שארל דה גול")[0]).toMatchObject({ code: "PAR", airportCode: "CDG" });
    expect(resolveLocation("נריטה")[0]).toMatchObject({ code: "TYO", airportCode: "NRT" });
    expect(resolveLocation("האנדה")[0]).toMatchObject({ code: "TYO", airportCode: "HND" });
    expect(resolveLocation("אורלי")[0]).toMatchObject({ code: "PAR", airportCode: "ORY" }); // and no longer New Orleans first
  });

  it("every Hebrew airport name finds its own city", () => {
    for (const c of data) {
      for (const a of c.airports) {
        if (!a.nameHe) continue;
        expect(resolveLocation(a.nameHe, 5).map((m) => m.code), `${a.iata} ${a.nameHe}`).toContain(c.cityIata);
      }
    }
  });

  it("'Tel Aviv-Jaffa' and 'Elat' are aliases; the ', Israel' tail is ignored", () => {
    expect(resolveLocation("Tel Aviv-Jaffa")[0]?.code).toBe("TLV");
    expect(resolveLocation("Elat")[0]?.code).toBe("ETM");
    expect(resolveLocation("Tel Aviv, Israel")[0]?.code).toBe("TLV");
    expect(resolveLocation("Ben Gurion Airport")[0]?.code).toBe("TLV");
    expect(resolveLocation("Ramon Airport")[0]?.code).toBe("ETM");
    expect(resolveLocation("Eilat Ramon Airport")[0]?.code).toBe("ETM");
  });

  it("has the secondary airports Israelis fly to (Lesbos, Chios, Dortmund, Memmingen, Weeze...)", () => {
    for (const code of ["MJT", "JKH", "PVK", "AOK", "KVA", "RJK", "DTM", "FMM", "NRN", "HHN", "LCJ", "BZG", "IAS", "OHD", "PRN", "HDY", "DSS", "HBE", "CNF", "VVI", "SLA", "ANU", "UVF"]) {
      expect(airportsForCode(code), code).toEqual([code]);
      expect(countryOfAirport(code), code).toMatch(/^[A-Z]{2}$/);
    }
    expect(resolveLocation("Lesbos")[0]?.code).toBe("MJT");
    expect(resolveLocation("לסבוס")[0]?.code).toBe("MJT");
    expect(resolvePlace("Dortmund")).toMatchObject({ code: "DTM" });
  });

  it("every U+061C / variation-selector variant of a name resolves like the name", () => {
    expect(resolveLocation("ת؜ל אביב")[0]?.code).toBe("TLV");
    expect(resolveLocation("TLV️")[0]?.code).toBe("TLV");
    expect(resolveLocation("✈️ TLV")[0]?.code).toBe("TLV");
    expect(resolveLocation("T؜LV")[0]?.code).toBe("TLV");
  });
});
