import { describe, expect, it } from "vitest";
import { parseExploreQuery } from "../src/explore-text";

const NOW = new Date("2026-09-29T10:00:00Z"); // September 2026

const read = (text: string, now = NOW) => parseExploreQuery(text, now);

describe("parseExploreQuery: the owner's example", () => {
  it('"יש לי 4 ימים בנובמבר" -> 3 nights in November 2026', () => {
    expect(read("יש לי 4 ימים בנובמבר")).toEqual({ ok: true, nights: { min: 3, max: 3 }, month: "2026-11", missing: [], message: null, invalidNights: false });
  });
});

describe("parseExploreQuery: trip length", () => {
  it.each([
    ["4 לילות בנובמבר", 4, 4],
    ["5 ימים באוקטובר", 4, 4],
    ["ארבעה ימים בדצמבר", 3, 3],
    ["שלושה לילות בנובמבר", 3, 3],
    ["שני לילות בנובמבר", 2, 2],
    ["לילה אחד בנובמבר", 1, 1],
    ["יומיים בנובמבר", 1, 1],
    ["שבוע בנובמבר", 7, 7],
    ["שבוע וחצי בדצמבר", 10, 10],
    ["שבועיים בינואר", 14, 14],
    ["3-5 לילות בנובמבר", 3, 5],
    ["בין 3 ל-5 לילות בנובמבר", 3, 5],
    ["4 עד 6 ימים בנובמבר", 3, 5],
    ["סופ״ש בנובמבר", 2, 3],
    ['סופ"ש בנובמבר', 2, 3],
    ["סופש בנובמבר", 2, 3],
    ["סוף שבוע בנובמבר", 2, 3],
    ["סוף-שבוע בנובמבר", 2, 3],
    ["3 שבועות בדצמבר", 21, 21],
    ["שלושה שבועות בדצמבר", 21, 21],
    ["4 שבועות בדצמבר", 28, 28],
  ])("%s -> %i-%i nights", (text, min, max) => {
    const r = read(text);
    expect(r.nights).toEqual({ min, max });
    expect(r.ok).toBe(true);
  });

  it('"סוף שבוע" is a weekend, never read as a 7-night "שבוע"', () => {
    expect(read("סוף שבוע בחודש הבא").nights).toEqual({ min: 2, max: 3 });
  });

  it("refuses lengths that make no trip instead of guessing", () => {
    for (const text of ["יום אחד בנובמבר", "1 ימים בנובמבר", "40 לילות בנובמבר", "0 לילות בנובמבר", "5 שבועות בנובמבר"]) {
      const r = read(text);
      expect(r.invalidNights, text).toBe(true);
      expect(r.nights, text).toBeNull();
      expect(r.missing, text).toContain("nights");
      expect(r.message, text).toMatch(/בין 1 ל-30 לילות/);
    }
  });
});

describe("parseExploreQuery: month", () => {
  it.each([
    ["4 לילות בינואר", "2027-01"], // January already passed this year -> next January
    ["4 לילות בפברואר", "2027-02"],
    ["4 לילות במרץ", "2027-03"],
    ["4 לילות במרס", "2027-03"],
    ["4 לילות באפריל", "2027-04"],
    ["4 לילות במאי", "2027-05"],
    ["4 לילות ביוני", "2027-06"],
    ["4 לילות ביולי", "2027-07"],
    ["4 לילות באוגוסט", "2027-08"],
    ["4 לילות בספטמבר", "2026-09"], // this month counts
    ["4 לילות באוקטובר", "2026-10"],
    ["4 לילות לנובמבר", "2026-11"],
    ["4 לילות בדצמבר", "2026-12"],
    ["4 לילות בחודש הבא", "2026-10"],
    ["4 לילות החודש", "2026-09"],
    ["4 לילות בעוד חודש", "2026-10"],
  ])("%s -> %s", (text, month) => {
    expect(read(text).month).toBe(month);
  });

  it('"בחודש הבא" in December is January of the next year', () => {
    expect(read("סופ״ש בחודש הבא", new Date("2026-12-15T10:00:00Z")).month).toBe("2027-01");
  });

  it("a month name inside another word is not a month", () => {
    // "מאיר" contains "מאי"; "יוניון" contains "יוני".
    expect(read("4 לילות עם מאיר").month).toBeNull();
    expect(read("4 לילות ביוניון").month).toBeNull();
  });
});

describe("parseExploreQuery: says so when it cannot tell", () => {
  it("nothing recognised -> ok false and a Hebrew message", () => {
    const r = read("משהו זול בבקשה");
    expect(r).toMatchObject({ ok: false, nights: null, month: null, missing: ["nights", "month"] });
    expect(r.message).toMatch(/לא הצלחנו להבין/);
  });

  it("only a month -> ok, nights reported missing", () => {
    const r = read("משהו בנובמבר");
    expect(r).toMatchObject({ ok: true, nights: null, month: "2026-11", missing: ["nights"], invalidNights: false });
    expect(r.message).toMatch(/לכמה לילות/);
  });

  it("only a length -> ok, month reported missing", () => {
    const r = read("4 לילות");
    expect(r).toMatchObject({ ok: true, nights: { min: 4, max: 4 }, month: null, missing: ["month"] });
    expect(r.message).toMatch(/באיזה חודש/);
  });

  it("empty, whitespace and non-string input are 'not understood', never a throw", () => {
    for (const v of ["", "   ", undefined as unknown as string, 42 as unknown as string]) expect(read(v).ok).toBe(false);
  });

  it("tolerates bidi marks and typographic quotes", () => {
    expect(read("‏סופ״ש‏ בנובמבר").nights).toEqual({ min: 2, max: 3 });
    expect(read("סופ”ש בנובמבר").nights).toEqual({ min: 2, max: 3 });
  });

  it("very long input is cut, not rejected with a throw", () => {
    expect(() => read("א".repeat(10_000))).not.toThrow();
  });
});
