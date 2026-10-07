import { describe, expect, it } from "vitest";
import { emptyForm, countValidPairs, formatILS, formatShortDate, hoursFor, parseSearchParams, sanitizeForm, searchParamsFor, toRequest, trustedBookingUrl, validateForm } from "./search";

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
    expect(trustedBookingUrl("https://www.elal.com/flight-deals/en-il/flights-from-tel-aviv-to-athens")).toContain("elal.com");
    expect(trustedBookingUrl("https://elal.com.attacker.example/flight-deals")).toBeNull();
    expect(trustedBookingUrl("https://aviasales.com.attacker.example/redirect")).toBeNull();
    expect(trustedBookingUrl("javascript:alert(1)")).toBeNull();
  });

  it("preserves custom departure-hour windows", () => {
    expect(hoursFor("custom", [6, 14], true)).toEqual([6, 14]);
    expect(hoursFor("none", [6, 14], false)).toBeNull();
  });

  it("starts from Tel Aviv with a week-long stay and asks for the rest", () => {
    const form = emptyForm();
    expect([form.origin, form.originLabel, form.stayMin, form.stayMax]).toEqual(["TLV", "תל אביב", 6, 8]);
    const errors = validateForm(form, "2026-09-29");
    expect(Object.keys(errors).sort()).toEqual(["dates", "destination"]);
  });

  it("blocks more than 400 date pairs and trips that cannot fit", () => {
    const valid = { ...emptyForm(), destination: "ATH", windowStart: "2026-11-01", windowEnd: "2026-12-31" };
    expect(validateForm({ ...valid, stayMin: 1, stayMax: 30 }, "2026-09-29").dates).toContain("400");
    expect(validateForm({ ...valid, windowEnd: "2026-11-03" }, "2026-09-29").stay).toBeTruthy();
    expect(validateForm({ ...valid, windowStart: "2026-09-01" }, "2026-09-29").windowStart).toBeTruthy();
  });

  it("round-trips a search through the shareable URL", () => {
    const form = { ...emptyForm(), destination: "LCA", destinationLabel: "לרנקה", windowStart: "2026-11-01", windowEnd: "2026-11-30", adults: 2, infants: 1, checkedBag: true, outHoursPreset: "morning", maxStops: 0 };
    const parsed = parseSearchParams(`?${searchParamsFor(form).toString()}`)!;
    expect(toRequest(parsed)).toEqual(toRequest(form));
    expect(parsed.destinationLabel).toBe("לרנקה");
    expect(parseSearchParams("?utm=1")).toBeNull();
  });

  it("sanitises stored or shared data instead of trusting it", () => {
    const form = sanitizeForm({ origin: 42, adults: "9", infants: -1, stayMin: 0, windowStart: "tomorrow", maxStops: 7, outHoursPreset: "__proto__" });
    expect(form.origin).toBe("TLV");
    expect(form.adults).toBe(1);
    expect(form.infants).toBe(0);
    expect(form.stayMin).toBe(6);
    expect(form.windowStart).toBe("");
    expect(form.outHoursPreset).toBe("none");
    expect(form.maxStops).toBeNull();
    expect(formatShortDate("2026-11-05")).toBe("05/11");
  });
});
