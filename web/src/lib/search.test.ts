import { describe, expect, it } from "vitest";
import { emptyForm, countValidPairs, formatILS, hoursFor, trustedBookingUrl, validateForm } from "./search";

describe("search helpers", () => {
  it("counts only date pairs that fit the date and stay windows", () => {
    expect(countValidPairs("2026-11-10", "2026-11-25", 5, 7)).toBe(30);
    expect(countValidPairs("2026-11-10", "2026-11-12", 5, 7)).toBe(0);
  });

  it("accepts a valid search and rejects passenger and date errors", () => {
    const valid = { ...emptyForm(), origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25" };
    expect(validateForm(valid)).toEqual({});
    expect(validateForm({ ...valid, adults: 1, infants: 2 }).infants).toBeTruthy();
    expect(validateForm({ ...valid, stayMin: 8, stayMax: 5 }).stay).toBeTruthy();
  });

  it("rounds ILS up and refuses untrusted booking destinations", () => {
    expect(formatILS(968.01)).toBe("₪969");
    expect(trustedBookingUrl("https://www.aviasales.com/search/TLVBCN")).toContain("aviasales.com");
    expect(trustedBookingUrl("https://aviasales.com.attacker.example/redirect")).toBeNull();
    expect(trustedBookingUrl("javascript:alert(1)")).toBeNull();
  });

  it("preserves custom departure-hour windows", () => {
    expect(hoursFor("custom", [6, 14], true)).toEqual([6, 14]);
    expect(hoursFor("none", [6, 14], false)).toBeNull();
  });
});
