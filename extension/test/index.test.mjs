/**
 * The bundled place index (data/index.json) and the icons are generated: the committed files must equal a fresh
 * build, so they can never go stale against the Worker's datasets. Also the country ordering rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { EEE, EXT, INDEX, read } from "./helpers.mjs";
import { ENGLISH_NAMES, MAX_BYTES, buildIndex, extractAliases, generate } from "../scripts/gen-index.mjs";
import { SIZES, renderIcon } from "../scripts/gen-icons.mjs";

describe("data/index.json", () => {
  it("equals a fresh generation from the Worker's datasets (run `node scripts/gen-index.mjs` if not)", () => {
    assert.equal(read("data/index.json"), generate());
  });

  it(`stays under ${MAX_BYTES} bytes`, () => {
    assert.ok(Buffer.byteLength(read("data/index.json"), "utf8") < MAX_BYTES);
  });

  it("every name points at something that exists", () => {
    for (const [name, target] of Object.entries(INDEX.n)) {
      const t = /** @type {string} */ (target);
      if (t.startsWith("@")) assert.ok(INDEX.k[t.slice(1)], name);
      else if (t.startsWith("#")) assert.ok(INDEX.a[t.slice(1)], name);
      else assert.ok(INDEX.c[t], name);
      assert.equal(EEE.text.normalizeName(name), name, `not normalized: ${name}`);
    }
  });

  it("every country of the city dataset is there, its top airport is in that country, Israel points at TLV", () => {
    const cities = JSON.parse(read("../worker/src/airports/cities.json"));
    const closed = new Set(JSON.parse(read("../worker/src/airports/served.json")).noScheduledService);
    for (const cc of new Set(cities.map((/** @type {any} */ c) => c.countryCode))) {
      assert.ok(ENGLISH_NAMES[/** @type {string} */ (cc)], `${cc} has no English name`);
      const open = cities.filter((/** @type {any} */ c) => c.countryCode === cc).flatMap((/** @type {any} */ c) => c.airports).filter((/** @type {any} */ a) => !closed.has(a.iata));
      // Like the website's country search: a country whose every airport has no scheduled service is not offered.
      assert.equal(Boolean(INDEX.k[/** @type {string} */ (cc)]), open.length > 0, `${cc}`);
    }
    for (const [cc, [, top, city]] of Object.entries(INDEX.k)) {
      if (cc === "IL") continue;
      assert.equal(EEE.places.cityInfo(INDEX, city)?.cc, cc, `${cc}: ${top}`);
      assert.ok(top === city || INDEX.a[top] === city, `${cc}: ${top} is not an airport of ${city}`);
    }
    assert.deepEqual(INDEX.k.IL.slice(1), ["TLV", "TLV"]);
  });

  it("the website's country aliases (worker/src/countries/search.ts) all resolve to that country", () => {
    const source = read("../worker/src/countries/search.ts");
    const he = extractAliases(source, "HEBREW_ALIASES");
    const en = extractAliases(source, "ENGLISH_ALIASES");
    assert.ok(he.US?.includes('ארה"ב'));
    assert.ok(en.TR?.includes("Turkey"));
    for (const [cc, names] of [...Object.entries(he), ...Object.entries(en)]) {
      for (const name of names) {
        const place = EEE.places.placeOfName(INDEX, EEE.text.normalizeName(name));
        assert.equal(place?.cc, cc, `${name} -> ${place?.cc}`);
      }
    }
    assert.throws(() => extractAliases("const OTHER = {};", "HEBREW_ALIASES"), /not found/);
    assert.throws(() => extractAliases('const HEBREW_ALIASES: X = {\n  US: oops,\n};', "HEBREW_ALIASES"), /unexpected line/);
  });

  it("country order: a direct flight from TLV first, then city popularity, then dataset order; closed airports skipped", () => {
    const cities = [
      { cityIata: "AAA", cityEn: "Alpha", cityHe: "אלפא", countryCode: "XA", popularity: 90, airports: [{ iata: "AAA", nameEn: "Alpha" }] },
      { cityIata: "BBB", cityEn: "Beta", cityHe: "בטא", countryCode: "XA", popularity: 40, airports: [{ iata: "BBB", nameEn: "Beta" }] },
      { cityIata: "CCC", cityEn: "Gamma", cityHe: "גמא", countryCode: "XB", popularity: 50, airports: [{ iata: "CCX", nameEn: "Gamma Closed" }, { iata: "CCY", nameEn: "Gamma Two" }] },
      { cityIata: "DDD", cityEn: "Delta", cityHe: "דלתא", countryCode: "XC", popularity: 30, airports: [{ iata: "DDD", nameEn: "Delta" }] },
      { cityIata: "EEE", cityEn: "Epsilon", cityHe: "אפסילון", countryCode: "XC", popularity: 30, airports: [{ iata: "EEE", nameEn: "Epsilon" }] },
      { cityIata: "TLV", cityEn: "Tel Aviv", cityHe: "תל אביב", countryCode: "IL", popularity: 100, airports: [{ iata: "TLV", nameEn: "Ben Gurion" }] },
    ];
    const countries = { XA: { nameHe: "ארץ א" }, XB: { nameHe: "ארץ ב" }, XC: { nameHe: "ארץ ג (שם ארוך)" }, IL: { nameHe: "ישראל" } };
    for (const cc of ["XA", "XB", "XC"]) ENGLISH_NAMES[cc] = [`Land ${cc}`];
    try {
      const index = buildIndex({ cities, served: { directFrom: { TLV: ["BBB"] }, noScheduledService: ["CCX"] }, countries, heAliases: {}, enAliases: {} });
      assert.deepEqual(index.k.XA, ["ארץ א", "BBB", "BBB"]); // direct beats more popular
      assert.deepEqual(index.k.XB, ["ארץ ב", "CCY", "CCC"]); // closed airport skipped; the city is asked for
      assert.deepEqual(index.k.XC, ["ארץ ג", "DDD", "DDD"]); // a tie keeps dataset order; the bracket part dropped
      assert.deepEqual(index.k.IL, ["ישראל", "TLV", "TLV"]);
      assert.equal(index.n[EEE.text.normalizeName("ארץ ג")], "@XC");
      assert.equal(index.n[EEE.text.normalizeName("Land XA")], "@XA");
      assert.equal(index.a.CCY, "CCC");
    } finally {
      for (const cc of ["XA", "XB", "XC"]) delete ENGLISH_NAMES[cc];
    }
  });
});

describe("icons", () => {
  /** @param {Buffer} png */
  function pixels(png) {
    /** @type {Buffer[]} */
    const idat = [];
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      const type = png.toString("latin1", at + 4, at + 8);
      if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
      at += 12 + len;
    }
    return inflateSync(Buffer.concat(idat));
  }

  it("the committed PNGs have exactly the pixels a fresh render gives", () => {
    for (const size of SIZES) {
      const raw = pixels(readFileSync(new URL(`icons/icon${size}.png`, EXT)));
      const fresh = renderIcon(size);
      assert.equal(raw.length, size * (size * 4 + 1));
      for (let row = 0; row < size; row++) {
        assert.equal(raw[row * (size * 4 + 1)], 0, "filter byte");
        const line = raw.subarray(row * (size * 4 + 1) + 1, (row + 1) * (size * 4 + 1));
        assert.deepEqual([...line], [...fresh.subarray(row * size * 4, (row + 1) * size * 4)], `icon${size} row ${row}`);
      }
    }
  });
});
