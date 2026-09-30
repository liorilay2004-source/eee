/**
 * Destination and origin resolution: Hebrew and English city/country/airport names, codes, Hebrew prefixes, niqqud
 * and geresh variants; Israel is only ever the origin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CTX, EEE, INDEX, analyze, read, summary } from "./helpers.mjs";

const P = EEE.places;
const T = EEE.text;
const dest = (/** @type {string} */ q) => {
  const r = analyze(q);
  return r && r.kind === "route" ? r.destination : null;
};

describe("normalization (same rules as the Worker's resolver)", () => {
  it("drops niqqud, quotes and geresh, folds final letters and case", () => {
    assert.equal(T.normalizeName("אַתּוּנָה"), "אתונה");
    assert.equal(T.normalizeName("ארה״ב"), "ארהב");
    assert.equal(T.normalizeName('ארה"ב'), "ארהב");
    assert.equal(T.normalizeName("צ׳כיה"), "צכיה");
    assert.equal(T.normalizeName("ברלין"), "ברלינ");
    assert.equal(T.normalizeName("  Tel-Aviv  "), "tel aviv");
    assert.equal(T.normalizeName("São Paulo"), "sao paulo");
    assert.equal(T.normalizeName("Kraków"), "krakow");
    assert.equal(T.normalizeName("\u200Fרומא\u200E"), "רומא");
    assert.equal(T.normalizeName(/** @type {any} */ (42)), "");
  });

  it("matches the Worker's normalizeQuery rule for rule (same regexes, same order)", () => {
    const worker = read("../worker/src/airports/resolve.ts");
    for (const piece of ["[\\p{Cf}\\uFE00-\\uFE0F]", "['\"`´ʼ׳״‘’“”′]", "[̀-ͯ]", "[øæœßłđı]", "[ךםןףץ]", "[^\\p{L}\\p{M}\\p{N}\\s]"]) {
      assert.ok(worker.includes(piece), `worker normalizer changed: ${piece}`);
    }
    assert.ok(worker.includes('.normalize("NFKD")'));
  });

  it("reads Hebrew prefixes shortest first, the whole word first", () => {
    const readings = (/** @type {string} */ w) => T.prefixReadings(w).map((/** @type {any} */ r) => `${r.prefix}+${r.rest}`);
    assert.deepEqual(readings("להודו"), ["+להודו", "ל+הודו"]); // never לה + ודו
    assert.deepEqual(readings("ומלונדונ"), ["+ומלונדונ", "ו+מלונדונ", "ומ+לונדונ"]);
    assert.deepEqual(readings("athens"), ["+athens"]);
    assert.equal(T.roleOfPrefix("ל"), "to");
    assert.equal(T.roleOfPrefix("ומ"), "from");
    assert.equal(T.roleOfPrefix("ב"), "in");
    assert.equal(T.roleOfPrefix("ו"), null);
  });
});

describe("destinations", () => {
  it("Hebrew city names, with and without prefixes", () => {
    assert.equal(dest("טיסות לאתונה"), "ATH");
    assert.equal(dest("טיסות אתונה"), "ATH");
    assert.equal(dest("טיסות ולאתונה"), "ATH");
    assert.equal(dest("טיסות ל אתונה"), "ATH");
    assert.equal(dest("טיסה ללונדון"), "LON");
    assert.equal(dest("טיסה לניו יורק"), "NYC");
    assert.equal(dest("טיסה לתל אביב ולאתונה"), null); // Israel as a destination silences the query
    assert.equal(dest("טיסות לברצלונה"), "BCN");
    assert.equal(dest("טיסות למדריד"), "MAD");
    assert.equal(dest("טיסות לורשה"), "WAW");
    assert.equal(dest("טיסות להונג קונג"), "HKG");
    assert.equal(dest("טיסה לבנגקוק"), "BKK");
  });

  it("English city names in any case, multi-word names", () => {
    assert.equal(dest("flights to Athens"), "ATH");
    assert.equal(dest("FLIGHTS TO ROME"), "ROM");
    assert.equal(dest("flights to new york"), "NYC");
    assert.equal(dest("flights to los angeles"), "LAX");
    assert.equal(dest("flights to sao paulo"), "SAO");
    assert.equal(dest("flights to krakow"), "KRK");
  });

  it("countries resolve to the city of their top airport, ordered like the website's country search", () => {
    assert.equal(dest("טיסות ליוון"), "ATH");
    assert.equal(dest("flights to greece"), "ATH");
    assert.equal(dest("טיסות לאיטליה"), "ROM");
    assert.equal(dest("טיסות לאנגליה"), "LON");
    assert.equal(dest("flights to england"), "LON");
    assert.equal(dest("flights to the UK"), "LON");
    assert.equal(dest("טיסות לארצות הברית"), "NYC");
    assert.equal(dest("flights to USA"), "NYC");
    assert.equal(dest("flights to czech republic"), "PRG");
    assert.equal(dest("flights to turkey"), "IST");
    assert.equal(dest("טיסות לתאילנד"), "BKK");
    assert.equal(dest("טיסות לשוויץ"), "ZRH");
    assert.equal(dest("טיסות להולנד"), "AMS");
    const r = analyze("טיסות ליוון");
    assert.equal(r?.kind === "route" ? r.destCountryHe : undefined, "יוון");
  });

  it("airport codes only when typed in capitals, never common upper-case words", () => {
    assert.equal(dest("flights ATH"), "ATH");
    assert.equal(dest("flights to LHR"), "LHR");
    assert.equal(dest("טיסות LCA"), "LCA");
    assert.equal(dest("flights ath"), null);
    const tokens = T.tokenize("CHEAP FLIGHTS THE BEST");
    assert.deepEqual(P.findPlaces(tokens, INDEX), []);
  });

  it("a code glued to a Hebrew prefix takes the prefix's direction", () => {
    assert.equal(dest("טיסה לBCN"), "BCN");
    assert.equal(analyze("טיסה מETM לATH")?.origin, "ETM");
    assert.equal(dest("טיסה לTHE"), null); // still not a common word
  });

  it("a query typed all in capitals: three-letter English words are words, not codes", () => {
    assert.equal(P.isShouting(T.tokenize("CAN I GET CHEAP FLIGHTS")), true);
    assert.equal(P.isShouting(T.tokenize("TLV ATH")), false); // just codes
    assert.equal(P.isShouting(T.tokenize("flights TLV MAD")), false);
    assert.deepEqual(P.findPlaces(T.tokenize("CAN I GET CHEAP FLIGHTS FOR HER"), INDEX), []);
    assert.equal(dest("flights TLV MAD"), "MAD"); // in a normal query a capitalized MAD is Madrid
    assert.equal(dest("FLIGHTS TO LHR"), "LHR"); // not an everyday word
    for (const w of ["CAN", "HER", "MAD", "MAN", "WAS", "SIN", "GOT", "FAT", "PEN", "MRS", "SAW"]) assert.ok(P.SHOUTED_WORDS.has(w), w);
  });

  it("airport names (Hebrew and the distinctive English part)", () => {
    assert.equal(dest("flights to heathrow"), "LHR");
    assert.equal(dest("טיסות להית'רו"), "LHR");
    assert.equal(dest("flights to gatwick"), "LGW");
    assert.equal(dest("flights to charles de gaulle"), "CDG");
  });

  it("place names that are everyday words need a direction word", () => {
    assert.equal(dest("flights to nice"), "NCE");
    assert.equal(dest("nice flights"), null);
    assert.equal(dest("טיסה למלגה"), "AGP");
    assert.equal(dest("מלגה לטיסה"), null);
    assert.equal(dest("טיסות לקובה"), "HAV");
    for (const w of ["nice", "split", "male", "tours", "מלגה", "קונה", "פונה"]) assert.ok(P.WEAK_NAMES.has(T.normalizeName(w)), w);
  });

  it("more everyday words and names that are place names (found in review)", () => {
    // Hebrew: "בקו" = on a line, "קניה" = buying, "עובדה" = a fact, "קרבי" = combat, "סבו" = his grandfather, ...
    for (const w of ["בקו", "קניה", "עובדה", "קרבי", "סבו", "מרידה", "לבנון", "דוחה", "סופיה", "jordan", "washington"]) {
      assert.ok(P.WEAK_NAMES.has(T.normalizeName(w)), w);
    }
    assert.equal(dest("טיסות בקו ישיר"), null);
    assert.equal(dest("טיסות לבקו"), "GYD");
    assert.equal(dest("flight denzel washington"), null);
    assert.equal(dest("flights to washington"), "WAS");
    assert.equal(analyze("עובדה: טיסות זולות לאתונה")?.origin, "TLV"); // not Ovda
  });

  it("a weak name behind a Hebrew prefix counts only after a flight word, a cue or a neutral word", () => {
    assert.equal(dest("טיסה לקניה"), "NBO"); // to Kenya
    assert.equal(summary(analyze("טיפים לקניה של טיסה זולה")), "null"); // tips for buying a flight
  });

  it("a stop on the way is not the destination", () => {
    assert.equal(P.roleWord({ norm: "via" }), "via");
    assert.equal(P.roleWord({ norm: T.normalizeName("דרך") }), "via");
    assert.equal(summary(analyze("flights to rome via athens")), "null");
    assert.equal(summary(analyze("טיסות דרך איסטנבול")), "null");
  });

  it("one destination: a city with its own country is fine, two cities or two countries are not", () => {
    assert.equal(dest("flights to paris france"), "PAR");
    assert.equal(dest("טיסות ליוון אתונה"), "ATH");
    assert.equal(dest("flights to london heathrow"), "LHR"); // the most precise name
    assert.equal(summary(analyze("flights to ontario canada")), "null"); // Ontario, California is not in Canada
    assert.equal(summary(analyze("london to paris flights")), "null");
    assert.equal(summary(analyze("טיסה רומא אתונה")), "null");
  });

  it("a region of a place is not that place", () => {
    for (const q of ["flights to south america", "טיסות לצפון איטליה", "טיסות לאמריקה הלטינית", "flights to new mexico", "flights to north korea"]) {
      assert.equal(summary(analyze(q)), "null", q);
    }
    assert.equal(dest("flights to south africa"), "CPT"); // the region word is part of the country's name
    assert.equal(dest("flights to new york"), "NYC");
    assert.equal(dest("טיסות לצפון מקדוניה"), "SKP");
  });

  it("a destination we cannot resolve is silence, not the explore list", () => {
    assert.equal(summary(analyze("טיסות לאטלנטיס")), "null");
    assert.equal(summary(analyze("flights to narnia")), "null");
  });
});

describe("origin and direction", () => {
  it("TLV by default, ETM for Eilat / Ramon, the settings' default otherwise", () => {
    assert.equal(analyze("טיסות לאתונה")?.origin, "TLV");
    assert.equal(analyze("טיסות מאילת לאתונה")?.origin, "ETM");
    assert.equal(analyze("טיסות מרמון לאתונה")?.origin, "ETM");
    assert.equal(analyze("flights from eilat to athens")?.origin, "ETM");
    assert.equal(analyze("flights ETM ATH")?.origin, "ETM");
    assert.equal(analyze("טיסות מתל אביב לאתונה")?.origin, "TLV");
    assert.equal(analyze("טיסות מנתב\"ג לאתונה")?.origin, "TLV");
    assert.equal(analyze("טיסות לאתונה", { ...CTX, defaultOrigin: "ETM" })?.origin, "ETM");
    assert.equal(analyze("טיסות מישראל לאתונה", { ...CTX, defaultOrigin: "ETM" })?.origin, "ETM");
    assert.equal(analyze("טיסות לאתונה", { ...CTX, defaultOrigin: "XXX" })?.origin, "TLV");
    assert.equal(analyze("טיסות מחיפה לאתונה")?.origin, "HFA");
  });

  it("never offers Israel as a destination, never prices a trip that starts abroad", () => {
    for (const q of ["טיסות לאילת", "טיסות לישראל", "flights to tel aviv", "flights to israel", "טיסות מאתונה לתל אביב", "flights from london", "טיסות מלונדון לאתונה"]) {
      assert.equal(summary(analyze(q)), "null", q);
    }
    // Without any direction word the order decides: an Israeli place after the foreign one is a flight into Israel.
    assert.equal(summary(analyze("אתונה תל אביב טיסות")), "null");
    assert.equal(summary(analyze("flights tel aviv athens")), "ROUTE TLV-ATH 2026-10");
    // Two Israeli cities are a domestic trip; "Israel" beside an Israeli city is that city.
    assert.equal(summary(analyze("טיסה תל אביב אילת")), "null");
    assert.equal(summary(analyze("flights from eilat israel to athens")), "ROUTE ETM-ATH 2026-10");
    // An Israeli place is an explore origin only when the query says "from": "טיסות אילת" is a trip TO Eilat.
    assert.equal(summary(analyze("טיסות אילת")), "null");
    assert.equal(summary(analyze("טיסות נתב\"ג")), "null");
    assert.equal(summary(analyze("טיסות מנתב\"ג")), "EXPLORE TLV 2026-10");
    assert.equal(P.isHome(P.placeOfName(INDEX, "ישראל")), true);
    assert.equal(INDEX.k.IL[1], "TLV");
  });

  it("explore needs TLV or ETM (the API's explore origins)", () => {
    assert.equal(summary(analyze("טיסות זולות מחיפה")), "null");
    assert.equal(summary(analyze("טיסות זולות מאילת")), "EXPLORE ETM 2026-10");
  });

  it("Hebrew display names come from the index", () => {
    const r = /** @type {any} */ (analyze("flights to athens"));
    assert.equal(r.destNameHe, "אתונה");
    assert.equal(r.originNameHe, "תל אביב");
    assert.equal(/** @type {any} */ (analyze("טיסות מאילת לאתונה")).originNameHe, "אילת");
  });
});

describe("index lookups are safe", () => {
  it("unknown, malformed and prototype keys resolve to nothing", () => {
    assert.equal(P.placeOfName(INDEX, "__proto__"), null);
    assert.equal(P.placeOfName(INDEX, "constructor"), null);
    assert.equal(P.placeOfCode(INDEX, "ZZZ"), null);
    assert.equal(P.placeOfCode(INDEX, "ath"), null);
    assert.equal(P.cityInfo(INDEX, "toString"), null);
    assert.equal(P.countryNameHe(INDEX, "hasOwnProperty"), null);
    assert.deepEqual(P.findPlaces(T.tokenize("טיסות לאתונה"), {}), []);
  });
});
