/**
 * Airline reference table (src/airlines) and the additive per-card fields `airlineNames` / `airlines` it feeds.
 * Also the airport Hebrew-name coverage of multi-airport cities (src/airports/cities.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import airlinesData from "../src/airlines/airlines.json";
import { AIRLINE_COUNT, airlineFieldsFor, airlineInfo, offerAirlineCodes } from "../src/airlines/lookup";
import citiesData from "../src/airports/cities.json";
import { normalizeQuery, resolveLocation, resolvePlace } from "../src/airports/resolve";
import type { CityRecord } from "../src/airports/types";
import bagFees from "../../config/bag_fees.json";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import * as entry from "../src/index";
import type { Env, Leg, SearchResponse } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const rows = airlinesData.airlines;
const HEBREW_LETTER = /[א-ת]/;
const leg = (airlines: unknown[]): Leg => ({ departTime: null, arriveTime: null, stops: null, durationMin: null, airlines: airlines as string[] });

describe("airlines.json: shape and sourcing", () => {
  it("has one row per valid, unique two-character IATA code, sorted", () => {
    const codes = rows.map((r) => r.iata);
    expect(new Set(codes).size).toBe(codes.length);
    expect(AIRLINE_COUNT).toBe(codes.length);
    for (const c of codes) expect(c, c).toMatch(/^(?=.*[A-Z])[A-Z0-9]{2}$/);
    expect(codes).toEqual([...codes].sort());
  });

  it("every row has trimmed English and Hebrew names, a boolean low-cost flag and a known Hebrew-name source", () => {
    for (const r of rows) {
      expect(Object.keys(r).sort(), r.iata).toEqual(["heSource", "iata", "lowCost", "nameEn", "nameHe"]);
      expect(r.nameEn.trim(), r.iata).toBe(r.nameEn);
      expect(r.nameEn.length, r.iata).toBeGreaterThan(1);
      expect(r.nameHe.trim(), r.iata).toBe(r.nameHe);
      expect(typeof r.lowCost, r.iata).toBe("boolean");
      expect(["hewiki", "transliteration"], r.iata).toContain(r.heSource);
      // Hebrew UI: a Hebrew name, except brands whose Hebrew Wikipedia title is itself Latin (KLM).
      if (r.iata !== "KL") expect(r.nameHe, r.iata).toMatch(HEBREW_LETTER);
      expect(r.nameHe, r.iata).not.toMatch(/[()]/); // disambiguation parentheses were removed
    }
  });

  it("names its sources and the date they were read", () => {
    expect(airlinesData.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const text = airlinesData.sources.join(" ");
    expect(text).toMatch(/Wikipedia/);
    expect(text).toMatch(/CC BY-SA/);
    expect(text).toMatch(/List of low-cost airlines/);
  });

  it("covers every airline of the bag-fee table, so a fee never belongs to a nameless carrier", () => {
    for (const code of Object.keys(bagFees.fees)) expect(airlineInfo(code), code).not.toBeNull();
  });

  it("covers the Israeli carriers and the ETM operators, with the right names", () => {
    expect(airlineInfo("LY")).toEqual({ nameHe: "אל על", nameEn: "El Al", lowCost: false });
    expect(airlineInfo("IZ")).toMatchObject({ nameHe: "ארקיע", nameEn: "Arkia" });
    expect(airlineInfo("6H")).toMatchObject({ nameHe: "ישראייר", nameEn: "Israir" });
    expect(airlineInfo("E2")).toMatchObject({ nameHe: "אייר חיפה", nameEn: "Air Haifa" });
  });

  it("flags the big European low-cost brands (and their sister codes) as low-cost, and flag carriers as not", () => {
    for (const c of ["W6", "W4", "W9", "FR", "RK", "MW", "LW", "U2", "EC", "VY", "HV", "TO", "PC", "FZ", "EW"]) expect(airlineInfo(c)?.lowCost, c).toBe(true);
    for (const c of ["LY", "IZ", "6H", "BA", "LH", "AF", "TK", "UA", "DL", "A3", "KL", "LX"]) expect(airlineInfo(c)?.lowCost, c).toBe(false);
  });
});

describe("airlineInfo", () => {
  it("returns null for unknown, malformed and non-string codes", () => {
    for (const bad of ["ZZ", "", " W6", "W6 ", "w6", "W", "W66", "12", "__proto__", "constructor", "toString", null, undefined, 6, {}, ["W6"]]) {
      expect(airlineInfo(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("returns a frozen entry: callers cannot corrupt the shared table", () => {
    const w6 = airlineInfo("W6")!;
    expect(Object.isFrozen(w6)).toBe(true);
    expect(() => {
      (w6 as { nameHe: string }).nameHe = "x";
    }).toThrow();
    expect(airlineInfo("W6")?.nameHe).toBe("ויז אייר");
  });
});

describe("offerAirlineCodes / airlineFieldsFor", () => {
  it("lists each code once, outbound first, in order of first appearance", () => {
    expect(offerAirlineCodes({ outbound: leg(["W6", "LY", "W6"]), inbound: leg(["VY", "LY"]) })).toEqual(["W6", "LY", "VY"]);
    expect(offerAirlineCodes({ outbound: leg([]), inbound: leg([]) })).toEqual([]);
  });

  it("tolerates junk in the legs (non-strings, missing arrays) without throwing", () => {
    expect(offerAirlineCodes({ outbound: leg([null, 5, "W6"]), inbound: { ...leg([]), airlines: undefined as unknown as string[] } })).toEqual(["W6"]);
    expect(airlineFieldsFor({ outbound: leg([{}, "FR"]), inbound: leg([]) })).toEqual({
      airlineNames: { FR: "ריינאייר" },
      airlines: { FR: { nameHe: "ריינאייר", nameEn: "Ryanair", lowCost: true } },
    });
  });

  it("maps known codes to names and leaves unknown codes out (never a guessed name)", () => {
    const got = airlineFieldsFor({ outbound: leg(["W6", "ZZ"]), inbound: leg(["LY"]) });
    expect(got.airlineNames).toEqual({ W6: "ויז אייר", LY: "אל על" });
    expect(got.airlines).toEqual({
      W6: { nameHe: "ויז אייר", nameEn: "Wizz Air", lowCost: true },
      LY: { nameHe: "אל על", nameEn: "El Al", lowCost: false },
    });
    expect(airlineFieldsFor({ outbound: leg(["ZZ"]), inbound: leg([]) })).toEqual({ airlineNames: {}, airlines: {} });
  });

  it("returns fresh objects on every call", () => {
    const a = airlineFieldsFor({ outbound: leg(["W6"]), inbound: leg([]) });
    a.airlines.W6!.nameHe = "changed";
    a.airlineNames.W6 = "changed";
    expect(airlineFieldsFor({ outbound: leg(["W6"]), inbound: leg([]) }).airlineNames.W6).toBe("ויז אייר");
  });
});

// --- through the Worker ----------------------------------------------------------------------------------

const NOW = new Date("2026-10-01T09:00:00.000Z");
const BODY = { origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Travelpayouts rows from the repo fixtures, each airline passed through `mapAirline`. */
function stub(mapAirline: (code: string) => string = (c) => c) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.travelpayouts.com") {
      const oneWay = url.searchParams.get("one_way") === "true";
      const body = structuredClone(oneWay ? onewayFixture : roundtripFixture) as { data: { origin: string; airline?: string }[] };
      if (oneWay) body.data = body.data.filter((d) => d.origin === url.searchParams.get("origin"));
      for (const row of body.data) if (typeof row.airline === "string") row.airline = mapAirline(row.airline);
      return json(body);
    }
    if (url.hostname === "boi.org.il") return json({ exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1 }, { key: "EUR", currentExchangeRate: 3.9, unit: 1 }] });
    throw new Error(`unexpected outbound call to ${url.hostname}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function search(env: Env): Promise<SearchResponse> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const req = new Request("https://api.example.test/api/search", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(BODY),
  });
  const res = await entry.default.fetch(req, env, ctx);
  await Promise.all(pending);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

const makeEnv = (): Env => ({ DB: createTestD1(), TRAVELPAYOUTS_TOKEN: "tp-token-0123456789abcdef", TRAVELPAYOUTS_MARKER: "12345" });

describe("search answer: airlineNames and airlines on every card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names exactly the airlines of each card's legs, on a fresh scan and again on a cache hit", async () => {
    stub();
    const env = makeEnv();
    const first = await search(env);
    expect(first.meta.fromCache).toBe(false);
    expect(first.cards.length).toBeGreaterThan(0);
    for (const card of [first.cards, (await search(env)).cards].flat()) {
      const codes = offerAirlineCodes(card.offer);
      expect(codes.length).toBeGreaterThan(0);
      expect(Object.keys(card.airlineNames).sort()).toEqual([...codes].sort()); // fixture codes W6, VY, LY are all in the table
      expect(Object.keys(card.airlines).sort()).toEqual([...codes].sort());
      for (const c of codes) {
        expect(card.airlineNames[c]).toBe(airlineInfo(c)!.nameHe);
        expect(card.airlines[c]).toEqual(airlineInfo(c));
      }
    }
    const second = await search(env);
    expect(second.meta.fromCache).toBe(true);
    expect(second.cards.map((c) => [c.airlineNames, c.airlines])).toEqual(first.cards.map((c) => [c.airlineNames, c.airlines]));
  });

  it("leaves an unknown airline code out: the maps are empty, the offer's codes are untouched", async () => {
    stub(() => "ZZ");
    const data = await search(makeEnv());
    expect(data.cards.length).toBeGreaterThan(0);
    for (const card of data.cards) {
      expect(card.offer.outbound.airlines).toContain("ZZ");
      expect(card.airlineNames).toEqual({});
      expect(card.airlines).toEqual({});
    }
  });

  it("adds only the two card fields: top level, meta and the ranking are what they were", async () => {
    stub();
    const data = await search(makeEnv());
    expect(Object.keys(data).sort()).toEqual(["cards", "meta"]);
    expect(Object.keys(data.meta).sort()).toEqual(["apiVersion", "candidatePairs", "fromCache", "fxDate", "fxSource", "generatedAt", "searchKey", "sources"]);
    for (const card of data.cards) {
      expect(Object.keys(card).sort()).toEqual(["ageHours", "airlineNames", "airlines", "kinds", "offer", "priceContext", "savingsVsRoundtripIls"]);
    }
    // Names are looked up after ranking: an unknown code everywhere yields the same cards at the same prices.
    stub(() => "ZZ");
    const other = await search(makeEnv());
    expect(other.cards.map((c) => [c.kinds, c.offer.totalIls])).toEqual(data.cards.map((c) => [c.kinds, c.offer.totalIls]));
  });
});

// --- airports: Hebrew names of airports in multi-airport cities -----------------------------------------

describe("cities.json: Hebrew airport names", () => {
  const cities = citiesData as CityRecord[];
  /** Kobe's Hebrew name, קובה, is also Cuba (an alias of Havana), so it stays unnamed rather than hijack that search. */
  const NO_HEBREW_NAME = new Set(["UKB"]);

  it("every airport of a multi-airport city has a Hebrew name (so the card can say which airport), with one documented exception", () => {
    const missing = cities.flatMap((c) => (c.airports.length > 1 ? c.airports.filter((a) => !a.nameHe && !NO_HEBREW_NAME.has(a.iata)).map((a) => a.iata) : []));
    expect(missing).toEqual([]);
  });

  it("Hebrew airport names are unique and never equal ANOTHER city's name or alias (which would steal that city's search)", () => {
    const cityOfName = new Map<string, string>();
    for (const c of cities) for (const n of [c.cityHe, ...(c.aliasesHe ?? [])].filter(Boolean)) cityOfName.set(normalizeQuery(n), c.cityIata);
    const seen = new Map<string, string>();
    for (const c of cities) {
      for (const a of c.airports) {
        if (!a.nameHe) continue;
        const n = normalizeQuery(a.nameHe);
        expect(seen.has(n), `${a.iata} duplicates ${seen.get(n)}`).toBe(false);
        seen.set(n, a.iata);
        expect(cityOfName.get(n) ?? c.cityIata, `${a.iata} ${a.nameHe}`).toBe(c.cityIata); // Ramon/Ovda are also Eilat aliases: fine
      }
    }
  });

  it("the new names resolve to their airport, and the city names still resolve to the whole city", () => {
    const airports: Array<[string, string, string]> = [
      ["זוונטם", "BRU", "BRU"],
      ["ג'ורג' בסט", "BFS", "BHD"],
      ["טנריף דרום", "TCI", "TFS"],
      ["טנריף צפון", "TCI", "TFN"],
      ["דובאי הבינלאומי", "DXB", "DXB"],
      ["גרדרמואן", "OSL", "OSL"],
      ["טורפ", "OSL", "TRF"],
      ["הונגצ'יאו", "SHA", "SHA"],
      ["סוקרנו-האטה", "JKT", "CGK"],
    ];
    for (const [q, city, airport] of airports) {
      expect(resolveLocation(q)[0], q).toMatchObject({ code: city, kind: "airport", airportCode: airport, airports: [airport] });
      expect(resolvePlace(q), q).toMatchObject({ code: city, airportCode: airport });
    }
    for (const [q, city] of [["בריסל", "BRU"], ["בלפסט", "BFS"], ["טנריף", "TCI"], ["דובאי", "DXB"], ["אוסלו", "OSL"], ["איסטנבול", "IST"], ["קובה", "HAV"], ["Dubai", "DXB"]] as const) {
      expect(resolveLocation(q)[0], q).toMatchObject({ code: city, kind: "city" });
      expect(resolvePlace(q), q).toMatchObject({ code: city, kind: "city" });
    }
  });
});
