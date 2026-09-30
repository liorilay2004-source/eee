import { describe, expect, it } from "vitest";
import type { ExploreResult } from "../api/contract";
import {
  buildExploreParams, climateText, describeExploreFailure, destinationName, emptyExploreInput, exploreMonths, foundAgeText, monthName,
  prefillFromExplore, previewText, scoreParts, sortFailureText, sortResults, understoodSummary,
} from "./explore";
import { monthOptions } from "./builder";
import { parseExploreParams } from "../../../worker/src/explore";
import { toApiFailure } from "./failure";
import { emptyForm, fillSearchHref, isFillOnly, parseSearchParams } from "./search";

function result(code: string, ils: number, total: number, extra: Partial<ExploreResult> = {}): ExploreResult {
  return {
    destination: { code, nameHe: code === "ATH" ? "אתונה" : null, nameEn: code === "ATH" ? "Athens" : `City ${code}`, countryCode: "GR", category: "city" },
    departDate: "2026-11-10", returnDate: "2026-11-13", nights: 3,
    price: { amount: ils / 3.7, currency: "USD", ils },
    stops: 0, departTime: "08:15", foundAt: null, expiresAt: null,
    links: { book: "https://www.aviasales.com/search/TLV1011ATH13111" },
    search: { origin: "TLV", destination: code, windowStart: "2026-11-10", windowEnd: "2026-11-13", stayMin: 3, stayMax: 3 },
    score: { total, price: 100, weather: 80, attractiveness: null, flightTime: 100, weights: { price: 0.55, weather: 0.25, attractiveness: 0.15, flightTime: 0.05 } },
    climate: { month: 11, tmaxC: 19.6, rainDays: 6.2, approximate: true },
    ...extra,
  };
}

describe("explore query", () => {
  it("sends free text, origin, sort and limit, and leaves unset filters out", () => {
    const built = buildExploreParams({ ...emptyExploreInput(), text: "  יש לי 4 ימים בנובמבר " }, "price");
    expect(built).toEqual({ ok: true, params: { origin: "TLV", sort: "price", limit: "20", q: "יש לי 4 ימים בנובמבר" } });
  });

  it("adds explicit month, nights and a cleaned budget", () => {
    const built = buildExploreParams({ text: "", origin: "ETM", month: "2026-12", nights: "3-5", maxPrice: "₪1,200" }, "score");
    expect(built).toEqual({ ok: true, params: { origin: "ETM", sort: "score", limit: "20", month: "2026-12", nights: "3-5", maxPrice: "1200" } });
  });

  it("asks for a month or text, and refuses a bad budget, before calling the API", () => {
    const none = buildExploreParams(emptyExploreInput(), "price");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.month).toBeTruthy();
    const badBudget = buildExploreParams({ ...emptyExploreInput(), month: "2026-11", maxPrice: "12.5" }, "price");
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) expect(badBudget.errors.maxPrice).toBeTruthy();
    const tooBig = buildExploreParams({ ...emptyExploreInput(), month: "2026-11", maxPrice: "100001" }, "price");
    expect(tooBig.ok).toBe(false);
    const long = buildExploreParams({ ...emptyExploreInput(), text: "א".repeat(201) }, "price");
    expect(long.ok).toBe(false);
  });
});

describe("understood query", () => {
  it("summarises what the server read", () => {
    expect(understoodSummary({ nights: { min: 3, max: 3 }, month: "2026-11" })).toBe("3 לילות · נובמבר 2026");
    expect(understoodSummary({ nights: { min: 2, max: 3 }, month: null })).toBe("2–3 לילות");
    expect(understoodSummary({ nights: null, month: null })).toBe("");
  });

  it("previews the same parser locally, with the Hebrew note when the length is missing", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(previewText("יש לי 4 ימים בנובמבר", now)).toEqual({ summary: "3 לילות · נובמבר 2026", message: null });
    const noLength = previewText("משהו בדצמבר", now);
    expect(noLength?.summary).toBe("דצמבר 2026");
    expect(noLength?.message).toContain("לא הבנו לכמה לילות");
    expect(previewText("   ", now)).toBeNull();
  });

  it("names months with their year", () => {
    expect(monthName("2027-01")).toBe("ינואר 2027");
    expect(exploreMonths("2026-09-05", 3).map((m) => m.key)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("never offers a month that is over, or nearly over (same rule as the month chips)", () => {
    // The last day of a month: the Worker's window starts tomorrow, so this month would be refused as "in the past".
    expect(exploreMonths("2026-09-30", 3).map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(exploreMonths("2026-12-31", 2).map((m) => m.key)).toEqual(["2027-01", "2027-02"]);
    expect(exploreMonths("2026-09-25")[0].key).toBe("2026-10");
    expect(exploreMonths("2026-09-30")[0].key).toBe(monthOptions("2026-09-30")[0].key);
    expect(exploreMonths("2026-09-05")[0].key).toBe(monthOptions("2026-09-05")[0].key);
  });

  it("offers only months the Worker accepts, on every day of a year (checked against its own parser)", () => {
    for (let day = 0; day < 366; day += 1) {
      const now = new Date(Date.UTC(2026, 0, 1, 10) + day * 86_400_000);
      const today = now.toISOString().slice(0, 10);
      for (const { key } of exploreMonths(today)) {
        const parsed = parseExploreParams(new URLSearchParams({ origin: "TLV", month: key }), now);
        expect(parsed.ok, `${today} ${key}`).toBe(true);
      }
    }
  });

  it("stops at the Worker's 365-day limit", () => {
    const months = exploreMonths("2026-09-30", 24);
    expect(months.at(-1)?.key).toBe("2027-09");
    expect(exploreMonths("2026-01-22", 12).at(-1)?.key).toBe("2027-01");
  });
});

describe("explore errors", () => {
  const http = (status: number, code: string, fields: Record<string, string> = {}, retryAfterSec?: number) =>
    toApiFailure({ status, code, fields, retryAfterSec }, true);

  it("shows the server's Hebrew reason for query_not_understood", () => {
    const notice = describeExploreFailure(http(400, "query_not_understood", { q: "לא הצלחנו להבין כמה זמן ובאיזה חודש." }));
    expect(notice.title).toBe("לא הבנו את הבקשה");
    expect(notice.body).toBe("לא הצלחנו להבין כמה זמן ובאיזה חודש.");
    expect(notice.canRetry).toBe(false);
  });

  it("never shows English field messages", () => {
    const notice = describeExploreFailure(http(400, "invalid_request", { month: "the window is in the past", maxPrice: "must be a whole number" }));
    expect(notice.lines).toHaveLength(2);
    expect(notice.lines.join(" ")).not.toMatch(/[a-z]{3}/);
  });

  it("maps 429 with the server's wait, and 503 honestly", () => {
    const limited = describeExploreFailure(http(429, "rate_limited", {}, 90));
    expect(limited.retryAfterSec).toBe(90);
    expect(limited.body).toContain("2 דקות");
    expect(describeExploreFailure(http(503, "source_unavailable")).title).toBe("מקור המחירים לא זמין כרגע");
    expect(describeExploreFailure(http(503, "fx_unavailable")).title).toContain("לשקלים");
    expect(describeExploreFailure(toApiFailure(new TypeError("fetch failed"), false)).title).toBe("אין חיבור לאינטרנט");
  });
});

describe("explore results", () => {
  it("sorts by price or by score, with a stable tie-break", () => {
    const list = [result("BCN", 900, 70), result("ATH", 700, 60), result("ROM", 900, 95)];
    expect(sortResults(list, "price").map((r) => r.destination.code)).toEqual(["ATH", "BCN", "ROM"]);
    expect(sortResults(list, "score").map((r) => r.destination.code)).toEqual(["ROM", "BCN", "ATH"]);
  });

  it("breaks the score into four labelled parts with weights; unknown stays unknown", () => {
    const parts = scoreParts(result("ATH", 700, 60).score);
    expect(parts.map((p) => p.label)).toEqual(["מחיר", "מזג אוויר", "אטרקטיביות", "שעת טיסה"]);
    expect(parts.map((p) => p.weightPct)).toEqual([55, 25, 15, 5]);
    expect(parts[2].value).toBeNull();
  });

  it("prefers the Hebrew city name", () => {
    expect(destinationName(result("ATH", 1, 1).destination)).toBe("אתונה");
    expect(destinationName(result("XYZ", 1, 1).destination)).toBe("City XYZ");
    expect(destinationName({ code: "QQQ", nameHe: null, nameEn: null, countryCode: null, category: null })).toBe("QQQ");
  });

  it("says how old the source's fare is only when the source said so", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(foundAgeText(null, now)).toBeNull();
    expect(foundAgeText("2026-09-30T09:00:00Z", now)).toBe("המחיר נמצא לפני כ־3 שעות");
    expect(foundAgeText("2026-09-27T12:00:00Z", now)).toBe("המחיר נמצא לפני כ־3 ימים");
    expect(climateText(result("ATH", 1, 1).climate)).toContain("כ־20°");
  });

  it("fills the main search with the destination and exact dates, keeping who travels", () => {
    const base = { ...emptyForm(), adults: 2, children: 1, checkedBag: true };
    const form = prefillFromExplore(result("ATH", 700, 60), base, "תל אביב");
    expect(form).toMatchObject({
      origin: "TLV", originLabel: "תל אביב", destination: "ATH", destinationLabel: "אתונה",
      windowStart: "2026-11-10", windowEnd: "2026-11-13", stayMin: 3, stayMax: 3, adults: 2, children: 1, checkedBag: true,
    });
  });
});

describe("explore re-sort and hand-over", () => {
  it("words a failed re-sort as an inline note that keeps the results", () => {
    const busy = sortFailureText(toApiFailure({ status: 503, code: "source_unavailable", fields: {} }, true), "score");
    expect(busy).toContain("לא הצלחנו לסדר לפי ציון כרגע");
    expect(busy).toContain("התוצאות שלמטה נשארו");
    expect(busy).not.toContain("אין לנו כרגע מחירים");
    expect(sortFailureText(toApiFailure({ status: 429, code: "rate_limited", fields: {}, retryAfterSec: 120 }, true), "score")).toContain("כ־2 דקות");
    expect(sortFailureText({ type: "offline" }, "score")).toContain("אין חיבור לאינטרנט");
  });

  it("hands the filled search over in the URL, marked fill-only", () => {
    const form = prefillFromExplore(result("ATH", 538, 81), emptyForm(), "תל אביב");
    const href = fillSearchHref(form);
    expect(href.startsWith("/?")).toBe(true);
    const search = href.slice(1);
    expect(isFillOnly(search)).toBe(true);
    expect(parseSearchParams(search)).toMatchObject({
      origin: "TLV", destination: "ATH", destinationLabel: "אתונה", windowStart: "2026-11-10", windowEnd: "2026-11-13", stayMin: 3, stayMax: 3,
    });
    expect(isFillOnly("?o=TLV&d=ATH")).toBe(false);
  });
});
