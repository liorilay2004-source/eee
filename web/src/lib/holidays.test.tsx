import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarDay, CalendarInsights } from "../api/contract";
import { CalendarInsightsBlock, HolidayCredit, TripHolidays } from "../components/Holidays";
import { CalendarLegend } from "../components/PriceCalendar";
import { buildCalendarGrid, cellLabel } from "./calendar";
import { holidayCreditText, insightLines, resultsNeedHolidayCredit, vacationDaysText } from "./holidays";

const insights: CalendarInsights = {
  byWeekday: [
    { weekday: 0, minIls: 900, medianIls: 1000, count: 3 },
    { weekday: 2, minIls: 700, medianIls: 800, count: 2 },
  ],
  byNights: [{ nights: 3, minIls: 750, count: 2 }, { nights: 5, minIls: 990, count: 4 }],
  cheapestWeekday: 2,
  cheapestNights: 3,
  savingVsDearestWeekdayPct: 20,
  summaryHe: "יציאה ביום ג׳ זולה בממוצע ב-20% מיציאה ביום א׳",
  labelHe: "לפי מחירים שנמצאו לאחרונה (מטמון, 2-7 ימים)",
  basis: "cached_fares",
};

describe("explore card holidays", () => {
  it("renders the holiday chip and the vacation days when present", () => {
    const html = renderToStaticMarkup(<TripHolidays holidayHe="חנוכה" vacationDaysUsed={3} />);
    expect(html).toContain("holiday-chip");
    expect(html).toContain("חנוכה");
    expect(html).toContain("ימי חופש נדרשים: 3");
  });

  it("renders only what is known", () => {
    const html = renderToStaticMarkup(<TripHolidays holidayHe={null} vacationDaysUsed={2} />);
    expect(html).not.toContain("holiday-chip");
    expect(html).toContain("ימי חופש נדרשים: 2");
    expect(renderToStaticMarkup(<TripHolidays holidayHe="סוכות" vacationDaysUsed={null} />)).not.toContain("ימי חופש");
  });

  it("renders nothing when both are null or absent", () => {
    expect(renderToStaticMarkup(<TripHolidays holidayHe={null} vacationDaysUsed={null} />)).toBe("");
    expect(renderToStaticMarkup(<TripHolidays />)).toBe("");
    expect(renderToStaticMarkup(<TripHolidays holidayHe="  " />)).toBe("");
  });

  it("words zero and one vacation days naturally", () => {
    expect(vacationDaysText(0)).toBe("בלי ימי חופש");
    expect(vacationDaysText(1)).toBe("יום חופש אחד");
    expect(vacationDaysText(2)).toBe("ימי חופש נדרשים: 2");
    expect(vacationDaysText(null)).toBeNull();
    expect(vacationDaysText(Number.NaN)).toBeNull();
  });
});

describe("holiday credit", () => {
  it("shows the Hebcal CC BY 4.0 credit from meta, with a fallback", () => {
    expect(renderToStaticMarkup(<HolidayCredit attribution="Hebcal.com, CC BY 4.0" />)).toContain("נתוני חגים: Hebcal.com, CC BY 4.0");
    expect(holidayCreditText(undefined)).toBe("נתוני חגים: Hebcal.com, CC BY 4.0");
  });
});

describe("calendar insights", () => {
  it("renders the summary and cheapest trip length as a labelled region, without repeating the weekday", () => {
    const html = renderToStaticMarkup(<CalendarInsightsBlock insights={insights} />);
    expect(html).toContain('<section class="pcal-insights" aria-label="תובנות מחיר">');
    expect(html).toContain(insights.summaryHe);
    expect(html).not.toContain("יום היציאה הזול ביותר");
    expect(html.match(/20%/g)).toHaveLength(1);
    expect(html).toContain("אורך הטיול הזול ביותר: 3 לילות, החל מ-₪750");
    expect(html).toContain(insights.labelHe);
  });

  it("falls back to a weekday line only when there is no summary", () => {
    const lines = insightLines({ ...insights, summaryHe: "", savingVsDearestWeekdayPct: 20.4 });
    expect(lines.map((l) => l.key)).toEqual(["weekday", "nights"]);
    expect(lines[0].text).toBe("יום היציאה הזול ביותר בממוצע: יום שלישי (חיסכון של כ-20% לעומת היום היקר)");
  });

  it("shows only the fields that exist", () => {
    const lines = insightLines({ ...insights, summaryHe: "", cheapestNights: null, savingVsDearestWeekdayPct: undefined });
    expect(lines.map((l) => l.key)).toEqual(["weekday"]);
    expect(lines[0].text).not.toContain("%");
  });

  it("never prints undefined when the label is missing", () => {
    const html = renderToStaticMarkup(<CalendarInsightsBlock insights={{ ...insights, labelHe: undefined as unknown as string }} />);
    expect(html).not.toContain("undefined");
    expect(html).toContain("לפי מחירים שנמצאו לאחרונה. לא התחייבות למחיר.");
  });

  it("renders nothing without insights", () => {
    expect(renderToStaticMarkup(<CalendarInsightsBlock insights={undefined} />)).toBe("");
    expect(insightLines(null)).toEqual([]);
  });
});

describe("holiday wiring", () => {
  it("shows the holiday legend item even in a month without price levels", () => {
    const html = renderToStaticMarkup(<CalendarLegend hasLevels={false} hasHolidays />);
    expect(html).toContain("pcal-holiday-dot is-legend");
    expect(html).toContain("חג");
    expect(html).not.toContain("lvl-low");
    expect(renderToStaticMarkup(<CalendarLegend hasLevels hasHolidays={false} />)).not.toContain("חג");
    expect(renderToStaticMarkup(<CalendarLegend hasLevels={false} hasHolidays={false} />)).toBe("");
  });

  it("asks for the Hebcal credit on explore results only when one shows holiday data", () => {
    expect(resultsNeedHolidayCredit([{ holidayHe: null, vacationDaysUsed: null }, {}])).toBe(false);
    expect(resultsNeedHolidayCredit([{ holidayHe: null, vacationDaysUsed: 0 }])).toBe(true);
    expect(resultsNeedHolidayCredit([{ holidayHe: "פסח" }])).toBe(true);
    expect(resultsNeedHolidayCredit([{ holidayHe: "  " }])).toBe(false);
  });
});

describe("calendar holiday days", () => {
  it("carries the holiday onto the cell and its label", () => {
    const days: CalendarDay[] = [
      { date: "2026-12-05", known: true, holidayHe: "חנוכה: נר 1", fare: null },
      { date: "2026-12-06", known: true, fare: null },
    ];
    const cells = buildCalendarGrid("2026-12", days, "2026-12-01").flat();
    const hol = cells.find((c) => c.date === "2026-12-05")!;
    expect(hol.holidayHe).toBe("חנוכה: נר 1");
    expect(cellLabel(hol)).toContain("(חנוכה: נר 1)");
    expect(cells.find((c) => c.date === "2026-12-06")!.holidayHe).toBeUndefined();
  });
});
