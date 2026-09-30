/** When: month names (Hebrew and English), numeric day-first dates, ranges, years, defaults and the API's limits. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE, TODAY, analyze, summary } from "./helpers.mjs";

const D = EEE.dates;
const when = (/** @type {string} */ q, today = TODAY) => {
  const w = D.parseWhen(EEE.text.lightText(q), today);
  return w.invalid ? "invalid" : [w.month, w.depart, w.ret].filter(Boolean).join(" ") || "none";
};

describe("months", () => {
  it("Hebrew month names with the usual prefixes, the next time the month comes", () => {
    assert.equal(when("בנובמבר"), "2026-11");
    assert.equal(when("לנובמבר"), "2026-11");
    assert.equal(when("ובדצמבר"), "2026-12");
    assert.equal(when("נובמבר"), "2026-11");
    assert.equal(when("בספטמבר"), "2026-09"); // this month counts
    assert.equal(when("באוגוסט"), "2027-08"); // already gone this year
    assert.equal(when("בינואר"), "2027-01");
    assert.equal(when("במרץ"), "2027-03");
    assert.equal(when("במרס"), "2027-03");
    assert.equal(when("במאי"), "2027-05");
    assert.equal(when("בנובמבר 2026"), "2026-11");
  });

  it("English month names and abbreviations", () => {
    assert.equal(when("november"), "2026-11");
    assert.equal(when("Nov"), "2026-11");
    assert.equal(when("in December"), "2026-12");
    assert.equal(when("sept"), "2026-09"); // this month counts
    assert.equal(when("aug"), "2027-08");
    assert.equal(when("jan 2027"), "2027-01");
  });

  it('"may" is a month only where it can be one', () => {
    assert.equal(when("in may"), "2027-05");
    assert.equal(when("may 2027"), "2027-05");
    assert.equal(when("10 may"), "2027-05 2027-05-10");
    assert.equal(when("flights may be cheaper"), "none");
  });

  it("relative months", () => {
    assert.equal(when("בחודש הבא"), "2026-10");
    assert.equal(when("החודש"), "2026-09");
    assert.equal(when("next month"), "2026-10");
    assert.equal(when("this month"), "2026-09");
    assert.equal(when("מחר"), "2026-10"); // tomorrow is 1 October
    assert.equal(when("היום"), "2026-09");
  });

  it("11/2026 is a month", () => {
    assert.equal(when("11/2026"), "2026-11");
  });
});

describe("exact dates", () => {
  it("numeric dates are day first", () => {
    assert.equal(when("10/11"), "2026-11 2026-11-10");
    assert.equal(when("10.11"), "2026-11 2026-11-10");
    assert.equal(when("10.11.2026"), "2026-11 2026-11-10");
    assert.equal(when("10/11/26"), "2026-11 2026-11-10");
    assert.equal(when("5/1"), "2027-01 2027-01-05"); // January has passed this year
  });

  it("ranges and two dates: departure and return", () => {
    assert.equal(when("10-17/11"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("10-17.11"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("10/11-17/11"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("28/12 - 3/1"), "2026-12 2026-12-28 2027-01-03");
    assert.equal(when("10-17 בנובמבר"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("10 עד 17 לנובמבר"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("november 10-17"), "2026-11 2026-11-10 2026-11-17");
    assert.equal(when("2026-11-10 through 2026-11-17"), "2026-11 2026-11-10 2026-11-17");
  });

  it("day and month name", () => {
    assert.equal(when("10 בנובמבר"), "2026-11 2026-11-10");
    assert.equal(when("10 לנובמבר"), "2026-11 2026-11-10");
    assert.equal(when("10th of november"), "2026-11 2026-11-10");
    assert.equal(when("november 10, 2026"), "2026-11 2026-11-10");
    assert.equal(when("nov 3"), "2026-11 2026-11-03");
  });

  it("a return more than 30 nights later is not one trip", () => {
    assert.equal(when("1/11 - 20/12"), "2026-11 2026-11-01");
  });

  it("a date that does not exist, or is written month first, silences the query rather than being guessed", () => {
    // (Before review these fell back to "next month", which priced a month the user never asked for.)
    assert.equal(when("31/11"), "invalid");
    assert.equal(when("29/2"), "invalid"); // 2027 is not a leap year
    assert.equal(when("35 בנובמבר"), "invalid");
    assert.equal(when("12/25"), "invalid"); // month first (December 25): not the Israeli way, not guessed
    assert.equal(when("99.99"), "none"); // not a date at all: ignored
    assert.equal(summary(analyze("flights to rome 12/25")), "null");
    assert.equal(summary(analyze("טיסה לרומא 31/11")), "null");
  });

  it("ranges written the ways people write them", () => {
    assert.equal(when("מה-5 עד ה-12 בנובמבר"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("בין ה-5 ל-12 בנובמבר"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("5 ל-12 בנובמבר"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("5 to 12 november"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("between 5 and 12 november"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("from the 5th to the 12th of november"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("nov 5 to 12"), "2026-11 2026-11-05 2026-11-12");
    assert.equal(when("november 28 to december 3"), "2026-11 2026-11-28 2026-12-03");
    assert.equal(when("טיסה ל-5 לילות בנובמבר"), "2026-11"); // "5 ל..." without a second number is not a range
  });

  it("ISO dates with slashes or dots, full-width digits", () => {
    assert.equal(when("2026/11/10"), "2026-11 2026-11-10");
    assert.equal(when("2026.11.10"), "2026-11 2026-11-10");
    assert.equal(when("１０/１１"), "2026-11 2026-11-10");
  });
});

describe("numbers that are not dates", () => {
  it("a decimal with a unit is an amount, a duration or a rating", () => {
    for (const q of ["3.5 אלף", "2.5 שעות", "1.5k", "4.5 כוכבים", "₪2.5", "3.5 שקל"]) assert.equal(when(q), "none", q);
    assert.equal(when("10.11 בערב"), "2026-11 2026-11-10"); // a real date is still a date
  });

  it("24/7 is 'always'", () => {
    assert.equal(when("24/7"), "none");
    assert.equal(when("cheap flights 24/7"), "none");
  });
});

describe("Hebrew abbreviations, seasons, relative months, years", () => {
  it("month abbreviations with a geresh", () => {
    assert.equal(when("בנוב'"), "2026-11");
    assert.equal(when("בדצמ׳"), "2026-12");
    assert.equal(when("10 בנוב'"), "2026-11 2026-11-10");
    assert.equal(when("ינו' 2027"), "2027-01");
  });

  it("a season is its first month from next month on", () => {
    assert.equal(when("בקיץ"), "2027-06");
    assert.equal(when("חופשת קיץ 2027"), "2027-06");
    assert.equal(when("בחורף"), "2026-12");
    assert.equal(when("באביב"), "2027-03");
    assert.equal(when("בסתיו"), "2026-10");
    assert.equal(when("החופש הגדול"), "2027-07");
    assert.equal(when("in the summer"), "2027-06");
    assert.equal(when("winter"), "2026-12");
    assert.equal(when("in the fall"), "2026-10");
    assert.equal(when("fall"), "none"); // the verb
    assert.equal(when("summer 2026"), "invalid"); // over already
  });

  it("'אביב' and 'סתיו' are also names: Tel Aviv is not spring", () => {
    assert.equal(when("תל אביב"), "none");
    assert.equal(when("טיסות מתל אביב"), "none");
    assert.equal(when("תל-אביב באביב"), "2027-03");
    assert.equal(when("עם סתיו"), "none");
  });

  it("relative months", () => {
    assert.equal(when("בעוד חודשיים"), "2026-11");
    assert.equal(when("בעוד 3 חודשים"), "2026-12");
    assert.equal(when("בעוד שלושה חודשים"), "2026-12");
    assert.equal(when("in two months"), "2026-11");
    assert.equal(when("in 3 months"), "2026-12");
    assert.equal(when("בעוד שנה"), "2027-09");
  });

  it("'next year' is not one month; a bare year must be the year shown", () => {
    assert.equal(when("next year"), "invalid");
    assert.equal(when("בשנה הבאה"), "invalid");
    assert.equal(summary(analyze("טיסות לאתונה 2027")), "null");
    assert.equal(summary(analyze("טיסות לאתונה 2026")), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(analyze("טיסות לאתונה עד 2030 שקל")), "ROUTE TLV-ATH 2026-10"); // money, not a year
  });
});

describe("today and tomorrow", () => {
  it("are flagged, so a query without a cue word reads as the departures board", () => {
    const w = D.parseWhen(EEE.text.lightText("טיסות היום"), TODAY);
    assert.equal(w.relativeDay, true);
    assert.equal(D.parseWhen(EEE.text.lightText("טיסות בנובמבר"), TODAY).relativeDay, false);
    assert.equal(summary(analyze("טיסות היום")), "null");
    assert.equal(summary(analyze("טיסות זולות היום")), "EXPLORE TLV 2026-09");
  });
});

describe("what is not read", () => {
  it("holidays and weekends say nothing about the month", () => {
    assert.equal(when("בחנוכה"), "none");
    assert.equal(when("בפסח"), "none");
    assert.equal(when('סופ"ש'), "none");
    assert.equal(when("weekend"), "none");
  });

  it("no date at all -> next month from today", () => {
    assert.equal(summary(analyze("טיסות לאתונה")), "ROUTE TLV-ATH 2026-10");
    assert.equal(summary(analyze("טיסות לאתונה", { today: "2026-12-15", defaultOrigin: "TLV" })), "ROUTE TLV-ATH 2027-01");
  });
});

describe("the API's limits", () => {
  it("a month that has ended or starts more than 365 days ahead is refused (silence)", () => {
    assert.equal(when("בנובמבר 2027"), "invalid");
    assert.equal(when("בספטמבר 2027"), "2027-09");
    assert.equal(when("2025-11-10"), "invalid");
    assert.equal(when("10/11/2025"), "invalid");
    assert.equal(D.monthInRange("2026-09", TODAY), true);
    assert.equal(D.monthInRange("2026-08", TODAY), false);
    assert.equal(D.monthInRange("2027-10", TODAY), false);
  });

  it("date helpers", () => {
    assert.equal(D.addMonths("2026-12", 1), "2027-01");
    assert.equal(D.addMonths("2026-01", -1), "2025-12");
    assert.equal(D.monthEnd("2028-02"), "2028-02-29");
    assert.equal(D.addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(D.isIsoDay("2026-02-30"), false);
    assert.equal(D.monthLabelHe("2026-11"), "נובמבר 2026");
    assert.equal(D.localToday(new Date(2026, 8, 30, 23, 59)), "2026-09-30");
  });
});
