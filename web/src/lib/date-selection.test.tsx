import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VacationDates } from "../components/VacationDates";
import { emptyForm, toRequest } from "./search";
import { selectVacationDate, nightsBetween } from "./date-selection";

describe("vacation dates", () => {
  it("asks for a return date after the first click", () => {
    expect(selectVacationDate(emptyForm(), "2027-06-01", false)).toEqual({ windowStart: "2027-06-01", windowEnd: "" });
  });
  it("sends an exact pair instead of searching unrelated dates", () => {
    const form = { ...emptyForm(), destination: "ATH", windowStart: "2027-06-01" };
    const chosen = { ...form, ...selectVacationDate(form, "2027-06-15", false) };
    expect(toRequest(chosen)).toMatchObject({ windowStart: "2027-06-01", windowEnd: "2027-06-15", stayMin: 14, stayMax: 14 });
  });
  it("keeps stay preferences for a flexible window", () => {
    const form = { ...emptyForm(), windowStart: "2027-06-01" };
    expect(selectVacationDate(form, "2027-07-31", true)).toEqual({ windowEnd: "2027-07-31" });
  });
  it("restarts for earlier or overlong exact dates", () => {
    const form = { ...emptyForm(), windowStart: "2027-06-01" };
    expect(selectVacationDate(form, "2027-05-31", false).windowEnd).toBe("");
    expect(selectVacationDate(form, "2027-07-02", false).windowEnd).toBe("");
  });
  it("counts calendar nights across leap years and month boundaries", () => {
    expect(nightsBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
  it("renders real days with past days disabled and no month shortcut cards", () => {
    const html = renderToStaticMarkup(<VacationDates form={emptyForm()} patch={() => {}} today="2026-10-07" />);
    expect(html).toContain('aria-label="7 באוקטובר 2026"');
    expect(html).toContain('disabled="" aria-label="6 באוקטובר 2026"');
    expect(html).not.toContain("בחודש הקרוב");
  });
});
