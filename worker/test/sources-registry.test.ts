import { describe, expect, it } from "vitest";
import { QUOTE_SOURCE_NAMES } from "../src/quotes";
import { SOURCE_REGISTRY, sourceRegistry } from "../src/source-registry";

const OWNER_REQUESTED = [
  "El Al",
  "Arkia",
  "Israir",
  "Lufthansa",
  "SWISS",
  "Austrian Airlines",
  "British Airways",
  "Air France",
  "KLM",
  "ITA Airways",
  "Iberia",
  "TAP Air Portugal",
  "Turkish Airlines",
  "Pegasus Airlines",
  "Aegean Airlines",
  "Ryanair",
  "easyJet",
  "Wizz Air",
  "Vueling",
  "LOT Polish Airlines",
  "SAS",
  "Finnair",
  "Norwegian",
  "Icelandair",
  "Aer Lingus",
  "Brussels Airlines",
  "Eurowings",
  "Air Europa",
  "Emirates",
  "Qatar Airways",
  "Etihad Airways",
  "flydubai",
  "Air Arabia",
  "Gulf Air",
  "Oman Air",
  "Saudia",
  "Royal Jordanian",
  "Kuwait Airways",
  "EgyptAir",
  "Ethiopian Airlines",
  "Kenya Airways",
  "South African Airways",
  "Royal Air Maroc",
  "Air Canada",
  "American Airlines",
  "Delta Air Lines",
  "United Airlines",
  "Southwest Airlines",
  "Alaska Airlines",
  "JetBlue",
  "Spirit Airlines",
  "Frontier Airlines",
  "Hawaiian Airlines",
  "Aeromexico",
  "LATAM Airlines",
  "Avianca",
  "Copa Airlines",
  "Azul",
  "GOL",
  "Air China",
  "China Eastern Airlines",
  "China Southern Airlines",
  "Hainan Airlines",
  "Cathay Pacific",
  "Singapore Airlines",
  "Scoot",
  "Malaysia Airlines",
  "Thai Airways",
  "Vietnam Airlines",
  "Philippine Airlines",
  "Garuda Indonesia",
  "Japan Airlines",
  "ANA",
  "Korean Air",
  "Asiana Airlines",
  "EVA Air",
  "China Airlines",
  "Air India",
  "IndiGo",
  "Qantas",
  "Virgin Australia",
  "Air New Zealand",
  "Virgin Atlantic",
  "Air Serbia",
  "Croatia Airlines",
  "TAROM",
  "Bulgaria Air",
  "Georgian Airways",
  "Azerbaijan Airlines",
  "Uzbekistan Airways",
  "Air Astana",
  "Ukraine International Airlines",
  "Smartwings",
  "Transavia",
  "SunExpress",
  "Jet2",
  "Volotea",
  "Air Baltic",
];

describe("source registry", () => {
  it("contains every airline the owner asked to make part of the engine", () => {
    const names = new Set(SOURCE_REGISTRY.map((s) => s.name));
    for (const name of OWNER_REQUESTED) expect(names.has(name), name).toBe(true);
  });

  it("keeps stable ids, official URLs and no duplicate entries", () => {
    const ids = new Set<string>();
    for (const source of SOURCE_REGISTRY) {
      expect(source.id).toMatch(/^[a-z0-9_]+$/);
      expect(ids.has(source.id), source.id).toBe(false);
      ids.add(source.id);
      expect(source.homeUrl, source.id).toMatch(/^https:\/\/[^/?#]+/);
      expect(source.homeUrl, source.id).not.toMatch(/token|api[_-]?key|secret|password/i);
      expect(source.priority, source.id).toBeGreaterThanOrEqual(0);
      expect(source.markets.length, source.id).toBeGreaterThan(0);
      expect(source.noteHe.trim(), source.id).not.toBe("");
    }
  });

  it("does not pretend planned airlines are live price adapters", () => {
    for (const source of SOURCE_REGISTRY) {
      if (source.kind !== "airline") continue;
      if (source.id === "elal") {
        expect(source.status).toBe("active");
        expect(source.capabilities).toMatchObject({ livePrice: false, cachedPrice: true, bookingLink: false, combinations: false });
      } else {
        expect(source.status === "active" || source.status === "api", source.id).toBe(false);
        expect(source.capabilities.livePrice, source.id).toBe(false);
        expect(source.capabilities.cachedPrice, source.id).toBe(false);
      }
    }
  });

  it("keeps live quote source ids limited to the existing adapter set", () => {
    const adapterIds = new Set([...QUOTE_SOURCE_NAMES, "travelpayouts"]);
    const live = SOURCE_REGISTRY.filter((s) => s.capabilities.livePrice).map((s) => s.id);
    expect(live.every((id) => adapterIds.has(id as (typeof QUOTE_SOURCE_NAMES)[number] | "travelpayouts"))).toBe(true);
  });

  it("returns defensive copies", () => {
    const copy = sourceRegistry();
    copy[0]!.markets.push("MUTATED");
    copy[0]!.capabilities.livePrice = false;
    expect(sourceRegistry()[0]!.markets).not.toContain("MUTATED");
    expect(sourceRegistry()[0]!.capabilities.livePrice).toBe(SOURCE_REGISTRY[0]!.capabilities.livePrice);
  });
});
