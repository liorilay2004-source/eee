import { describe, expect, it } from "vitest";
import type { CalendarDay } from "../api/contract";
import {
  LEVEL_LABELS, buildCalendarGrid, calendarFailureText, calendarKey, calendarParams, calendarStatusText, cellLabel, datesForCell, initialCalendarMonth, shiftMonth,
} from "./calendar";
import { toApiFailure } from "./failure";

const fare = (priceIls: number, level: "low" | "mid" | "high" | null, returnDate: string, nights: number): NonNullable<CalendarDay["fare"]> => ({
  priceIls, priceAmount: priceIls / 3.7, priceCurrency: "USD", returnDate, nights, stops: 0, returnStops: 0, airlines: ["LY"],
  departTime: null, returnTime: null, deeplink: null, checkedAt: "2026-09-30T00:00:00Z", level,
});

describe("calendar request", () => {
  it("is asked only with both places chosen (and different)", () => {
    const form = { origin: "TLV", destination: "ATH", stayMin: 3, stayMax: 5 };
    expect(calendarParams(form, "2026-11")).toEqual({ origin: "TLV", destination: "ATH", month: "2026-11", minNights: "3", maxNights: "5" });
    expect(calendarParams({ ...form, destination: "" }, "2026-11")).toBeNull();
    expect(calendarParams({ ...form, destination: "tlv" }, "2026-11")).toBeNull();
    expect(calendarParams(form, "2026-13")).toBeNull();
  });

  it("keys the cache by every parameter", () => {
    const a = calendarParams({ origin: "TLV", destination: "ATH", stayMin: 3, stayMax: 5 }, "2026-11")!;
    const b = calendarParams({ origin: "TLV", destination: "ATH", stayMin: 3, stayMax: 6 }, "2026-11")!;
    expect(calendarKey(a)).not.toBe(calendarKey(b));
  });

  it("opens on the chosen month, the chosen dates, or the first month offered", () => {
    expect(initialCalendarMonth({ windowStart: "2026-12-01", windowEnd: "2026-12-31" }, "2026-09-30", "2026-10")).toBe("2026-12");
    expect(initialCalendarMonth({ windowStart: "2027-02-10", windowEnd: "2027-02-14" }, "2026-09-30", "2026-10")).toBe("2027-02");
    expect(initialCalendarMonth({ windowStart: "", windowEnd: "" }, "2026-09-30", "2026-10")).toBe("2026-10");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  });
});

describe("heat-map grid", () => {
  // November 2026 starts on a Sunday: no leading padding.
  const days: CalendarDay[] = [
    { date: "2026-11-02", known: true, fare: fare(820, "low", "2026-11-06", 4) },
    { date: "2026-11-03", known: true, fare: null },
    { date: "2026-11-04", known: false, fare: null },
    { date: "2026-11-05", known: true, fare: fare(1500, "high", "2026-11-09", 4) },
  ];
  const grid = buildCalendarGrid("2026-11", days, "2026-11-02", "2026-11-02");

  it("lays out Sunday-first weeks of seven", () => {
    expect(grid.every((w) => w.length === 7)).toBe(true);
    expect(grid[0][0].date).toBe("2026-11-01");
    expect(grid.flat().filter((c) => c.kind !== "pad")).toHaveLength(30);
  });

  it("tells past, no cached fare, not loaded and priced apart", () => {
    const byDate = new Map(grid.flat().filter((c) => c.date).map((c) => [c.date, c]));
    expect(byDate.get("2026-11-01")?.kind).toBe("past");
    expect(byDate.get("2026-11-02")).toMatchObject({ kind: "priced", level: "low", cheapest: true, priceIls: 820 });
    expect(byDate.get("2026-11-03")?.kind).toBe("none");
    expect(byDate.get("2026-11-04")?.kind).toBe("unknown");
    expect(byDate.get("2026-11-05")).toMatchObject({ kind: "priced", level: "high", cheapest: false });
  });

  it("pads a month that starts mid-week", () => {
    const dec = buildCalendarGrid("2026-12", [], "2026-11-02");
    expect(dec[0].slice(0, 2).every((c) => c.kind === "pad")).toBe(true); // Dec 1 2026 is a Tuesday
    expect(dec[0][2].date).toBe("2026-12-01");
  });

  it("words every level (never colour alone) and every day for screen readers", () => {
    expect(LEVEL_LABELS).toEqual({ low: "זול", mid: "בינוני", high: "יקר" });
    const cells = grid.flat();
    const priced = cells.find((c) => c.date === "2026-11-02")!;
    expect(cellLabel(priced)).toBe("יום שני, 2 בנובמבר: ₪820, זול, הזול בחודש, חזרה 06/11, 4 לילות");
    expect(cellLabel(cells.find((c) => c.date === "2026-11-03")!)).toContain("אין מחיר שמור");
    expect(cellLabel(cells.find((c) => c.date === "2026-11-04")!)).toContain("לא הצלחנו לטעון");
  });

  it("a tapped day sets exactly that fare's dates; other days set nothing", () => {
    const cells = grid.flat();
    expect(datesForCell(cells.find((c) => c.date === "2026-11-02")!)).toEqual({ windowStart: "2026-11-02", windowEnd: "2026-11-06", stayMin: 4, stayMax: 4 });
    expect(datesForCell(cells.find((c) => c.date === "2026-11-03")!)).toBeNull();
  });

  it("fails with a calm line that never blocks", () => {
    expect(calendarFailureText(toApiFailure({ status: 429, code: "rate_limited", retryAfterSec: 30 }, true))).toContain("פחות מדקה");
    expect(calendarFailureText(toApiFailure({ status: 503, code: "source_unavailable" }, true))).toContain("אפשר להמשיך");
    expect(calendarFailureText(toApiFailure(new Error("x"), false))).toContain("אין חיבור");
  });
});

describe("calendar live region", () => {
  it("names the month and what it holds, for every state", () => {
    expect(calendarStatusText("מרץ 2027", { status: "loading" })).toBe("מרץ 2027: טוענים מחירים…");
    expect(calendarStatusText("מרץ 2027", { status: "done", priced: 21 })).toBe("מרץ 2027: 21 ימים עם מחיר שמור.");
    expect(calendarStatusText("מרץ 2027", { status: "done", priced: 1 })).toBe("מרץ 2027: יום אחד עם מחיר שמור.");
    expect(calendarStatusText("מרץ 2027", { status: "done", priced: 0 })).toBe("מרץ 2027: אין ימים עם מחיר שמור.");
    expect(calendarStatusText("מרץ 2027", { status: "failed", text: "לוח המחירים לא זמין כרגע." })).toBe("מרץ 2027: לוח המחירים לא זמין כרגע.");
  });
});
