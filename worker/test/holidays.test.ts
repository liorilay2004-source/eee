/** holidays.ts: pure lookups over a fixture table, and sanity of the bundled src/holidays.json (Hebcal, CC BY 4.0). */
import { describe, expect, it } from "vitest";
import raw from "../src/holidays.json";
import { buildHolidayIndex, bundledHolidays, holidayBaseName, HOLIDAYS_ATTRIBUTION } from "../src/holidays";

const h = (date: string, titleHe: string, yomtov = false, category = "major") => ({ date, titleHe, yomtov, category });

/** Pesach 2027 in Israel (dates as Hebcal gives them) plus Yom HaAtzmaut, and some junk rows. */
const FIXTURE = {
  range: { start: "2027-04-01", end: "2027-05-31" },
  holidays: [
    h("2027-04-21", "ערב פסח"),
    h("2027-04-22", "פסח א׳", true),
    h("2027-04-23", "פסח ב׳ (חוה״מ)"),
    h("2027-04-24", "פסח ג׳ (חוה״מ)"),
    h("2027-04-25", "פסח ד׳ (חוה״מ)"),
    h("2027-04-26", "פסח ה׳ (חוה״מ)"),
    h("2027-04-27", "פסח ו׳ (חוה״מ)"),
    h("2027-04-28", "פסח ז׳", true),
    h("2027-05-11", "יום הזכרון", false, "modern"),
    h("2027-05-12", "יום העצמאות", false, "modern"),
    h("2027-05-12", "חג בדיקה", false, "minor"),
    h("2027-06-11", "שבועות", true), // outside the range: ignored
    { date: "2027-02-30", titleHe: "תאריך לא קיים" },
    { date: "2027-04-10", titleHe: "  " },
    "junk",
  ],
};
const idx = buildHolidayIndex(FIXTURE);

describe("holidayBaseName", () => {
  it.each([
    ["סוכות ה׳ (חוה״מ)", "סוכות"],
    ["סוכות ז׳ (הושענא רבה)", "סוכות"],
    ["פסח א׳", "פסח"],
    ["חנוכה: ג׳ נרות", "חנוכה"],
    ["חנוכה: יום ח׳", "חנוכה"],
    ["ראש השנה 5788", "ראש השנה"],
    ["ראש השנה ב׳", "ראש השנה"],
    ["ט״ו בשבט", "ט״ו בשבט"],
    ["יום ז׳בוטינסקי", "יום ז׳בוטינסקי"],
    ["שמיני עצרת", "שמיני עצרת"],
  ])("%s -> %s", (title, base) => expect(holidayBaseName(title)).toBe(base));
});

describe("buildHolidayIndex (fixture)", () => {
  it("keeps the range and drops malformed rows and rows outside the range", () => {
    expect(idx.range).toEqual({ start: "2027-04-01", end: "2027-05-31" });
    expect(idx.on("2027-06-11")).toEqual([]);
    expect(idx.on("2027-04-10")).toEqual([]);
    expect(idx.on("2027-04-22")).toEqual([h("2027-04-22", "פסח א׳", true)]);
  });

  it("holidayHeOn: the day's titles joined, null on a plain day or a malformed date", () => {
    expect(idx.holidayHeOn("2027-04-23")).toBe("פסח ב׳ (חוה״מ)");
    expect(idx.holidayHeOn("2027-05-12")).toBe("יום העצמאות, חג בדיקה");
    expect(idx.holidayHeOn("2027-04-15")).toBeNull();
    expect(idx.holidayHeOn("2027-4-22")).toBeNull();
    expect(idx.holidayHeOn("nonsense")).toBeNull();
  });

  it("holidayHeBetween: distinct names in date order, erev dropped when the chag is listed, inclusive ends", () => {
    expect(idx.holidayHeBetween("2027-04-20", "2027-04-29")).toBe("פסח");
    expect(idx.holidayHeBetween("2027-04-19", "2027-04-21")).toBe("ערב פסח"); // the chag itself is after the trip
    expect(idx.holidayHeBetween("2027-04-28", "2027-05-12")).toBe("פסח, יום הזכרון, יום העצמאות, חג בדיקה");
    expect(idx.holidayHeBetween("2027-05-12", "2027-05-12")).toBe("יום העצמאות, חג בדיקה");
    expect(idx.holidayHeBetween("2027-04-01", "2027-04-20")).toBeNull();
    expect(idx.holidayHeBetween("2027-04-29", "2027-04-20")).toBeNull();
  });

  it("vacationDaysUsed: Sunday-Thursday days of the trip, both ends included, yom tov not counted", () => {
    // Tue 20, Wed 21 (erev: counted), Thu 22 yom tov, Fri, Sat, Sun-Tue chol hamoed (counted), Wed 28 yom tov, Thu 29.
    expect(idx.vacationDaysUsed("2027-04-20", "2027-04-29")).toBe(6);
    expect(idx.vacationDaysUsed("2027-04-22", "2027-04-22")).toBe(0); // yom tov only
    expect(idx.vacationDaysUsed("2027-04-23", "2027-04-24")).toBe(0); // Friday and Saturday
    expect(idx.vacationDaysUsed("2027-05-02", "2027-05-08")).toBe(5); // a plain Sunday-Saturday week
    expect(idx.vacationDaysUsed("2027-05-12", "2027-05-12")).toBe(1); // not yom tov (see the field's doc)
  });

  it("vacationDaysUsed: null outside the range, on malformed dates and on a reversed trip", () => {
    expect(idx.vacationDaysUsed("2027-05-30", "2027-06-02")).toBeNull();
    expect(idx.vacationDaysUsed("2027-03-30", "2027-04-02")).toBeNull();
    expect(idx.vacationDaysUsed("2027-04-29", "2027-04-20")).toBeNull();
    expect(idx.vacationDaysUsed("2027-02-30", "2027-04-20")).toBeNull();
  });

  it("an empty or malformed table knows nothing and never guesses", () => {
    for (const bad of [null, {}, { holidays: "x" }, { range: { start: "2027-05-01", end: "2027-04-01" }, holidays: FIXTURE.holidays }]) {
      const empty = buildHolidayIndex(bad);
      expect(empty.range).toBeNull();
      expect(empty.holidayHeOn("2027-04-22")).toBeNull();
      expect(empty.vacationDaysUsed("2027-04-20", "2027-04-29")).toBeNull();
    }
  });
});

describe("bundled holidays.json (scripts/gen-holidays.mjs)", () => {
  const data = raw as { _about: { attribution: string; licence: string }; range: { start: string; end: string }; holidays: { date: string; titleHe: string; yomtov: boolean; category: string }[] };

  it("credits Hebcal under CC BY 4.0, the same text the API responses carry", () => {
    expect(HOLIDAYS_ATTRIBUTION).toBe("Hebcal.com, CC BY 4.0");
    expect(data._about.attribution).toBe(HOLIDAYS_ATTRIBUTION);
    expect(data._about.licence).toMatch(/CC BY 4\.0/);
  });

  it("covers about 24 months, sorted, every row well formed and inside the range", () => {
    const days = (Date.parse(data.range.end) - Date.parse(data.range.start)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(700);
    expect(bundledHolidays.range).toEqual(data.range);
    const dates = data.holidays.map((x) => x.date);
    expect([...dates].sort()).toEqual(dates);
    for (const x of data.holidays) {
      expect(x.date >= data.range.start && x.date <= data.range.end, x.date).toBe(true);
      expect(x.titleHe).toMatch(/[א-ת]/);
      expect(x.titleHe).not.toMatch(/[֑-ֽֿׁׂׄ-ׇ]/); // niqqud stripped
      expect(typeof x.yomtov).toBe("boolean");
      expect(["major", "minor", "modern", "fast", "shabbat", "holiday"]).toContain(x.category);
    }
  });

  it("holds the Israeli yom tov days of each Hebrew year it spans (one-day chagim, Israel schedule)", () => {
    const yomtov = data.holidays.filter((x) => x.yomtov).map((x) => holidayBaseName(x.titleHe));
    for (const name of ["ראש השנה", "יום כיפור", "שמיני עצרת", "פסח", "שבועות"]) expect(yomtov, name).toContain(name);
    // Israel: Shavuot is one day, never "שבועות ב׳".
    expect(data.holidays.some((x) => x.titleHe === "שבועות ב׳")).toBe(false);
    expect(bundledHolidays.holidayHeOn(data.holidays[0]?.date as string)).toContain(data.holidays[0]?.titleHe as string);
  });
});
