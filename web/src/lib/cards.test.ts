import { describe, expect, it } from "vitest";
import type { CardView, SearchResponse } from "../api/contract";
import { demoResult } from "./demo";
import { airlineLabels, cardAirlines, freshnessLine, freshnessTone, isSuspicious, metaNotes, staleBadge } from "./cards";
import { toApiFailure } from "./failure";

const base: CardView = demoResult("2026-09-30").cards[0];

describe("card fields", () => {
  it("shows Hebrew airline names where known and bare codes otherwise, each once", () => {
    expect(airlineLabels(["LY", "w6", "LY", "ZZ"], { LY: "אל על", W6: "ויז אייר" })).toEqual([
      { code: "LY", name: "אל על" }, { code: "W6", name: "ויז אייר" }, { code: "ZZ", name: null },
    ]);
    expect(airlineLabels(["LY"], undefined)).toEqual([{ code: "LY", name: null }]);
    const card = { ...base, airlineNames: { XX: "חברה א׳" }, offer: { ...base.offer, outbound: { ...base.offer.outbound, airlines: ["XX"] }, inbound: { ...base.offer.inbound, airlines: ["YY", "XX"] } } };
    expect(cardAirlines(card).map((a) => a.name ?? a.code)).toEqual(["חברה א׳", "YY"]);
  });

  it("uses the API's age sentence and falls back to the generic line", () => {
    expect(freshnessLine({ ...base, ageLabelHe: "מחיר שמור, נמצא לפני כ־3 ימים" })).toBe("מחיר שמור, נמצא לפני כ־3 ימים");
    expect(freshnessLine({ offer: base.offer })).toContain("Aviasales");
    expect(freshnessLine({ ...base, ageLabelHe: "  " })).toContain("עשוי להשתנות");
    expect(freshnessTone({ freshness: "stale" })).toBe("warn");
    expect(freshnessTone({})).toBe("plain");
  });

  it("flags price_suspicious", () => {
    expect(isSuspicious(base)).toBe(false);
    expect(isSuspicious({ ...base, offer: { ...base.offer, tags: ["price_suspicious"] } })).toBe(true);
  });

  it("says 'updating in the background' only when the server is refreshing", () => {
    expect(staleBadge({})).toBeNull();
    const stale = { cachedAt: "2026-09-29T00:00:00Z", ageHours: 30, revalidating: true, messageHe: "התוצאות מחיפוש קודם." };
    expect(staleBadge({ stale })).toEqual({ badge: "תוצאות שמורות, מתעדכנות ברקע", detail: "התוצאות מחיפוש קודם." });
    expect(staleBadge({ stale: { ...stale, revalidating: false } })?.badge).toBe("תוצאות שמורות מסריקה קודמת");
  });

  it("adds price-guard and bag-gating notes when present", () => {
    const meta: Partial<SearchResponse["meta"]> = {
      priceGuard: { suspicious: 2, excluded: 1 },
      recommendations: { cheapest: { status: "shown", excludedForUnknownBagFee: 3 }, bestValue: { status: "shown" } },
    };
    const notes = metaNotes(meta);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("3 הצעות");
    expect(metaNotes({})).toEqual([]);
  });
});

describe("failure shape", () => {
  it("normalises request errors, network errors and offline", () => {
    expect(toApiFailure({ status: 429, code: "rate_limited", retryAfterSec: 12.2, fields: { a: "x", b: 3 } }, true))
      .toEqual({ type: "http", status: 429, code: "rate_limited", retryAfterSec: 13, fields: { a: "x" } });
    expect(toApiFailure({ status: 500 }, true)).toMatchObject({ code: "request_failed", retryAfterSec: null });
    expect(toApiFailure(new TypeError("Failed to fetch"), true)).toEqual({ type: "network" });
    expect(toApiFailure(new TypeError("Failed to fetch"), false)).toEqual({ type: "offline" });
  });
});
