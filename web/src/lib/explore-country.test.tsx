import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExploreResult } from "../api/contract";
import { ExploreCard } from "../pages/ExplorePage";
import { destinationName, destinationTitle } from "./explore";

function result(destination: Partial<ExploreResult["destination"]> = {}): ExploreResult {
  return {
    destination: { code: "ATH", nameHe: "אתונה", nameEn: "Athens", countryCode: "GR", category: "city", ...destination },
    departDate: "2026-11-10", returnDate: "2026-11-13", nights: 3,
    price: { amount: 200, currency: "USD", ils: 740 },
    stops: 0, departTime: "08:15", foundAt: null, expiresAt: null,
    links: { book: null },
    search: { origin: "TLV", destination: "ATH", windowStart: "2026-11-10", windowEnd: "2026-11-13", stayMin: 3, stayMax: 3 },
    score: { total: 80, price: 100, weather: 80, attractiveness: null, flightTime: 100, weights: { price: 0.55, weather: 0.25, attractiveness: 0.15, flightTime: 0.05 } },
    climate: null,
  };
}

describe("destination title with the Hebrew country (countryHe, Unicode CLDR)", () => {
  it("shows \"עיר, מדינה\" when countryHe is present", () => {
    expect(destinationTitle(result({ countryHe: "יוון" }).destination)).toBe("אתונה, יוון");
    expect(destinationTitle(result({ nameHe: null, countryHe: "יוון" }).destination)).toBe("Athens, יוון");
  });

  it("is absence-safe for older API deploys: missing, null or blank countryHe -> city alone", () => {
    expect(destinationTitle(result().destination)).toBe("אתונה");
    expect(destinationTitle(result({ countryHe: null }).destination)).toBe("אתונה");
    expect(destinationTitle(result({ countryHe: "  " }).destination)).toBe("אתונה");
  });

  it("does not repeat a city-state's name (סינגפור, סינגפור)", () => {
    expect(destinationTitle(result({ code: "SIN", nameHe: "סינגפור", countryHe: "סינגפור" }).destination)).toBe("סינגפור");
  });

  it("does not repeat the city when the country name contains it, or the other way round", () => {
    expect(destinationTitle(result({ code: "SEZ", nameHe: "סיישל", countryHe: "איי סיישל" }).destination)).toBe("סיישל");
    expect(destinationTitle(result({ code: "HKG", nameHe: "הונג קונג", countryHe: "הונג קונג (אזור מנהלי מיוחד של סין)" }).destination)).toBe("הונג קונג");
    expect(destinationTitle(result({ code: "KWI", nameHe: "כווית סיטי", countryHe: "כווית" }).destination)).toBe("כווית סיטי");
    expect(destinationTitle(result({ code: "RGN", nameHe: "יאנגון", countryHe: "מיאנמר (בורמה)" }).destination)).toBe("יאנגון, מיאנמר (בורמה)");
  });

  it("destinationName (used for the search hand-over) stays the city alone", () => {
    expect(destinationName(result({ countryHe: "יוון" }).destination)).toBe("אתונה");
  });

  it("the explore card's heading shows city and country; the fill button names the city only", () => {
    const html = renderToStaticMarkup(<ExploreCard result={result({ countryHe: "יוון" })} rank={1} now={new Date("2026-10-01T00:00:00Z")} onFill={() => {}} />);
    const h3 = html.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1] ?? "";
    expect(h3).toContain("אתונה, יוון");
    expect(html).toContain("מלאו את החיפוש עם אתונה</button>");
    const old = renderToStaticMarkup(<ExploreCard result={result()} rank={1} now={new Date("2026-10-01T00:00:00Z")} onFill={() => {}} />);
    expect(old.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1] ?? "").not.toContain(",");
  });
});
