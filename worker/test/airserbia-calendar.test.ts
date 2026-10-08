import { describe, expect, it } from "vitest";
import { parseAirSerbiaCalendar } from "../src/airserbia-calendar";
const q = { origin: "BEG", destination: "ATH", year: 2027, month: 1, now: new Date("2026-10-08T00:00:00Z") };
const price = { price: 60.36, currency: "EUR", direct: null, soldOut: false };
const data = { origin: "BEG", destination: "ATH", year: 2027, month: 1, source: "db", prices: { "2027-01-04": price } };
describe("Air Serbia public dated calendar", () => {
  it("retains exact one-way cash amounts and airports without inferred flight details", () => {
    expect(parseAirSerbiaCalendar(data, q)).toMatchObject([{ airline: "JU", origin: "BEG", destination: "ATH", date: "2027-01-04", amount: 60.36, currency: "EUR" }]);
    expect(parseAirSerbiaCalendar(data, q)[0]).not.toHaveProperty("leg");
  });
  it("rejects mismatched route, month and unobserved price provenance", () => {
    expect(parseAirSerbiaCalendar({ ...data, origin: "ATH" }, q)).toEqual([]);
    expect(parseAirSerbiaCalendar({ ...data, month: 2 }, q)).toEqual([]);
    expect(parseAirSerbiaCalendar({ ...data, source: "unknown" }, q)).toEqual([]);
  });
  it("rejects unavailable, missing, non-cash and invalid calendar days", () => {
    const invalid = { "2027-01-05": { ...price, soldOut: true }, "2027-01-06": { ...price, price: null }, "2027-01-07": { ...price, currency: "MILES" }, "2027-01-32": price, "2027-02-01": price };
    expect(parseAirSerbiaCalendar({ ...data, prices: invalid }, q)).toEqual([]);
  });
});
