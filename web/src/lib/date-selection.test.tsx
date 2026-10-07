import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VacationDates } from "../components/VacationDates";
import { countValidPairs, emptyForm, toRequest } from "./search";
import { selectVacationDate, nightsBetween, exactVacationForm } from "./date-selection";

describe("vacation dates", () => {
  it("asks for a return date after the first click", () => {
    expect(selectVacationDate(emptyForm(), "2027-06-01")).toEqual({ windowStart: "2027-06-01", windowEnd: "" });
  });
  it("sends an exact pair instead of searching unrelated dates", () => {
    const form = { ...emptyForm(), destination: "ATH", windowStart: "2027-06-01" };
    const chosen = { ...form, ...selectVacationDate(form, "2027-06-15") };
    expect(toRequest(chosen)).toMatchObject({ windowStart: "2027-06-01", windowEnd: "2027-06-15", stayMin: 14, stayMax: 14 });
  });
  it("replaces legacy flexible nights with the two chosen dates", () => {
    const form = exactVacationForm({ ...emptyForm(), windowStart: "2027-06-01", windowEnd: "2027-06-22", stayMin: 3, stayMax: 5 });
    expect(form.stayMin).toBe(21);
    expect(form.stayMax).toBe(21);
    expect(countValidPairs(form.windowStart, form.windowEnd, form.stayMin, form.stayMax)).toBe(1);
  });  it("restarts for earlier or overlong exact dates", () => {
    const form = { ...emptyForm(), windowStart: "2027-06-01" };
    expect(selectVacationDate(form, "2027-05-31").windowEnd).toBe("");
    expect(selectVacationDate(form, "2027-07-02").windowEnd).toBe("");
  });
  it("counts calendar nights across leap years and month boundaries", () => {
    expect(nightsBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
  it("renders real days with past days disabled and no month shortcut cards", () => {
    const html = renderToStaticMarkup(<VacationDates form={emptyForm()} patch={() => {}} today="2026-10-07" />);
    expect(html).toContain('aria-label="7 באוקטובר 2026"');
    expect(html).toContain('disabled="" aria-label="6 באוקטובר 2026"');
    expect(html).not.toContain("בחודש הקרוב");
    expect(html).not.toContain("התאריכים שלי גמישים");
  });
  it("marks only departure and return, without selecting intermediate dates", () => {
    const form = exactVacationForm({ ...emptyForm(), windowStart: "2027-06-01", windowEnd: "2027-06-22" });
    const html = renderToStaticMarkup(<VacationDates form={form} patch={() => {}} today="2026-10-07" />);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).not.toContain("in-range");
    expect(html).toContain("רק בתאריכים האלה");
  });
});
