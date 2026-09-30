import { describe, expect, it } from "vitest";
import type { DealsResponse, RouteDealsView } from "../api/contract";
import { checkedAgoText, dealSearchHref, describeDealsFailure, emptyStateLines, readinessOf, routeName, sortRoutes, statusCounts, statusLabel } from "./deals";
import { toApiFailure } from "./failure";
import { parseSearchParams } from "./search";

const thresholds: DealsResponse["thresholds"] = { dealDropPct: 30, errorDropPct: 50, minSamples: 12, minSpanDays: 7, minDistinctDays: 5, liveWithinHours: 48 };

function route(destination: string, status: RouteDealsView["status"], readiness: RouteDealsView["readiness"] = null): RouteDealsView {
  return { origin: "TLV", destination, status, labelHe: "", computedAt: null, deals: [], buckets: null, readiness, truncated: false, fx: null };
}

describe("deals", () => {
  it("puts deals first, then the routes closest to enough history", () => {
    const sorted = sortRoutes([
      route("ATH", "not_computed"),
      route("BCN", "insufficient_data", { sampleSize: 3, spanDays: 2 }),
      route("ROM", "deals"),
      route("LON", "insufficient_data", { sampleSize: 10, spanDays: 6 }),
      route("PAR", "no_deal"),
    ], thresholds);
    expect(sorted.map((r) => r.destination)).toEqual(["ROM", "LON", "BCN", "PAR", "ATH"]);
  });

  it("measures readiness against the detector's thresholds, capped at 100%", () => {
    expect(readinessOf(route("BCN", "insufficient_data", { sampleSize: 6, spanDays: 9 }), thresholds)).toEqual({
      samples: { have: 6, need: 12, pct: 50 }, span: { have: 7, need: 7, pct: 100 }, overallPct: 50,
    });
    expect(readinessOf(route("BCN", "no_deal", { sampleSize: 6, spanDays: 9 }), thresholds)).toBeNull();
  });

  it("counts statuses and falls back to local Hebrew labels", () => {
    const counts = statusCounts([route("A", "deals"), route("B", "deals"), route("C", "stale")]);
    expect(counts.deals).toBe(2);
    expect(counts.stale).toBe(1);
    expect(statusLabel({ status: "insufficient_data", labelHe: "" })).toContain("היסטוריית מחירים");
    expect(statusLabel({ status: "deals", labelHe: "מהשרת" })).toBe("מהשרת");
    expect(routeName("TLV", "LON")).toBe("תל אביב – לונדון");
    expect(routeName("ETM", "SOF")).toBe("אילת – סופיה");
  });

  it("links a deal to a search of exactly its dates", () => {
    const href = dealSearchHref({ origin: "TLV", destination: "LHR", departDate: "2026-11-10", returnDate: "2026-11-15" }, "TLV", "LON");
    const form = parseSearchParams(href.slice(1));
    expect(form).toMatchObject({ origin: "TLV", destination: "LHR", destinationLabel: "לונדון", windowStart: "2026-11-10", windowEnd: "2026-11-15", stayMin: 5, stayMax: 5 });
  });

  it("words ages and failures in Hebrew", () => {
    expect(checkedAgoText(0.2)).toBe("נבדק לפני פחות משעה");
    expect(checkedAgoText(5)).toBe("נבדק לפני 5 שעות");
    expect(checkedAgoText(72)).toBe("נבדק לפני 3 ימים");
    expect(describeDealsFailure(toApiFailure({ status: 503, code: "deals_unavailable" }, true)).title).toBe("המבצעים לא זמינים כרגע");
  });
});

describe("deals empty state", () => {
  const counts = (c: Partial<ReturnType<typeof statusCounts>>) => ({ ...statusCounts([]), ...c });

  it("never calls stale routes 'checked, nothing unusual'", () => {
    const lines = emptyStateLines(counts({ stale: 4 }), thresholds);
    expect(lines).toEqual(["בכל 4 המסלולים הבדיקה האחרונה ישנה מדי, ולכן לא מוצגים מבצעים עד הבדיקה הבאה."]);
    expect(lines.join(" ")).not.toContain("מחיר חריג");
  });

  it("gives counts instead of 'most', and keeps 'nothing unusual' for judged routes", () => {
    const lines = emptyStateLines(counts({ not_computed: 1, no_deal: 4 }), thresholds);
    expect(lines).toEqual([
      "במסלול אחד מתוך 5 עוד לא בוצעה בדיקה.",
      "ב־4 מתוך 5 מסלולים לא נמצא מחיר חריג בבדיקה האחרונה. זה מצב רגיל: מבצעים אמיתיים נדירים.",
    ]);
    expect(lines.join(" ")).not.toContain("ברוב");
  });

  it("keeps missing recent prices apart from missing history", () => {
    const lines = emptyStateLines(counts({ no_recent_data: 2 }), thresholds);
    expect(lines).toEqual(["בכל 2 המסלולים אין מחירים עדכניים, ולכן אין למה להשוות."]);
    expect(lines.join(" ")).not.toContain("היסטוריה");
    const history = emptyStateLines(counts({ insufficient_data: 3, no_recent_data: 1 }), thresholds);
    expect(history[0]).toContain("ב־3 מתוך 4 מסלולים עדיין אין מספיק היסטוריה");
    expect(history[0]).toContain("12 בדיקות");
    expect(history[1]).toBe("במסלול אחד מתוך 4 אין מחירים עדכניים, ולכן אין למה להשוות.");
  });

  it("drops the 'that's normal' reassurance while any check is stale", () => {
    const lines = emptyStateLines(counts({ stale: 1, no_deal: 2 }), thresholds);
    expect(lines[1]).toBe("ב־2 מתוך 3 מסלולים לא נמצא מחיר חריג בבדיקה האחרונה.");
    expect(emptyStateLines(counts({}), thresholds)).toEqual(["עדיין אין מסלולים במעקב."]);
  });
});
