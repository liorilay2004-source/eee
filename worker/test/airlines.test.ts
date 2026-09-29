/** Airline names on cards (WEB_APP_SPEC §7.2 `airlineNames`, §7.7 gap 7): Hebrew, additive, never guessed. */
import { describe, expect, it } from "vitest";
import bagFees from "../../config/bag_fees.json";
import onewayFixture from "./fixtures/tp_oneway.json";
import roundtripFixture from "./fixtures/tp_roundtrip.json";
import { AIRLINES, airlineNameHe, airlineNamesFor } from "../src/airlines";
import { createRepo } from "../src/db";
import { runSearch } from "../src/pipeline";
import type { Leg, Offer, SearchRequest, TravelpayoutsClient } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const HEBREW = /[֐-׿]/;
const leg = (airlines: string[]): Leg => ({ departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines });

describe("the airline table", () => {
  it("keys are two-character IATA designators and every entry has a non-blank Hebrew and English name", () => {
    for (const [code, names] of Object.entries(AIRLINES)) {
      expect(code, code).toMatch(/^[A-Z0-9]{2}$/);
      expect(code, code).not.toMatch(/^\d\d$/); // an IATA designator is never two digits
      expect(names.he.trim(), code).not.toBe("");
      expect(names.en.trim(), code).not.toBe("");
      expect(names.he, code).toBe(names.he.trim());
    }
  });

  it("names the Israeli carriers in Hebrew letters", () => {
    expect(airlineNameHe("LY")).toBe("אל על");
    expect(airlineNameHe("IZ")).toBe("ארקיע");
    expect(airlineNameHe("6H")).toBe("ישראייר");
    for (const code of ["LY", "IZ", "6H", "W6", "FR", "U2", "A3", "TK", "LH", "BA", "AZ"]) expect(airlineNameHe(code), code).toMatch(HEBREW);
  });

  it("covers every carrier code of the bag-fee table and of the Travelpayouts fixtures", () => {
    const codes = new Set<string>([
      ...Object.keys((bagFees as { fees: Record<string, unknown> }).fees),
      ...[...roundtripFixture.data, ...onewayFixture.data].map((r) => (r as { airline: string }).airline),
    ]);
    for (const code of codes) expect(airlineNameHe(code), code).not.toBeNull();
  });

  it("every AOC code of a low-cost group carries the group's name", () => {
    for (const code of ["W6", "W4", "W9", "5W"]) expect(airlineNameHe(code)).toBe("וויז אייר");
    for (const code of ["U2", "EC", "DS"]) expect(airlineNameHe(code)).toBe("איזיג'ט");
    for (const code of ["FR", "RK", "AL"]) expect(airlineNameHe(code)).toBe("ריינאייר");
  });

  it("unknown, malformed or inherited keys give no name", () => {
    for (const code of ["ZZ", "", "  ", "constructor", "__proto__", "toString", "LYX"]) expect(airlineNameHe(code), code).toBeNull();
    expect(airlineNameHe(" ly ")).toBe("אל על"); // normalised lookup
  });
});

describe("airlineNamesFor", () => {
  it("maps every known code of both legs once, keyed as in the offer, and leaves unknown codes out", () => {
    expect(airlineNamesFor({ outbound: leg(["W6", "ZZ"]), inbound: leg(["VY", "W6"]) })).toEqual({ W6: "וויז אייר", VY: "וואלינג" });
  });

  it("is an empty object when no code is known or no leg states a carrier", () => {
    expect(airlineNamesFor({ outbound: leg([]), inbound: leg([]) })).toEqual({});
    expect(airlineNamesFor({ outbound: leg(["ZZ"]), inbound: leg(["__proto__"]) })).toEqual({});
  });
});

describe("cards carry airlineNames", () => {
  const NOW = new Date("2026-11-01T12:00:00.000Z");
  const req: SearchRequest = {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7, adults: 1, children: 0, infants: 0,
    cabin: "economy", checkedBag: false, outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
  };
  const offer = (price: number, airline: string): Offer => ({
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", priceAmount: price, priceCurrency: "USD",
    source: "travelpayouts", ticketStructure: "roundtrip", outbound: leg([airline]), inbound: leg([airline]), includes: {},
    deeplink: "https://www.aviasales.com/search/TLV1211BCN1811?marker=m", verifyLink: null, checkedAt: NOW.toISOString(),
    extrasAmountIls: 0, totalIls: null, tags: [],
  });
  const tp = (offers: Offer[]): TravelpayoutsClient => ({
    configured: true,
    callCount: () => 0,
    roundTrips: async (o, d) => (o === "TLV" && d === "BCN" ? offers.map((x) => structuredClone(x)) : []),
    oneWays: async () => [],
  });

  it("each card names the carriers of its own offer, and an unknown carrier stays a bare code", async () => {
    const deps = { repo: createRepo(createTestD1()), tp: tp([offer(100, "ZZ"), offer(150, "LY")]), fx: { date: "2026-11-01", source: "t", ratesToIls: { ILS: 1, USD: 3 } }, now: NOW };
    const res = await runSearch(deps, req);
    expect(res.cards.length).toBeGreaterThan(0);
    for (const card of res.cards) {
      const code = card.offer.outbound.airlines[0];
      expect(card.airlineNames).toEqual(code === "LY" ? { LY: "אל על" } : {});
      expect(card.offer.outbound.airlines).toEqual([code]); // the codes themselves are unchanged
    }
  });
});
