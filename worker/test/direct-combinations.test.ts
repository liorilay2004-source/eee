import { describe, it, expect } from "vitest";
import { combineDirectDirections, type PricedDirection } from "../src/direct-combinations";
const q = { origin: "TLV", destination: "ATH", departDate: "2027-06-01", returnDate: "2027-06-05", adults: 1, children: 0, infants: 0 };
const out: PricedDirection = { source: "aegean", airline: "A3", origin: "TLV", destination: "ATH", date: q.departDate, amount: 58.63, currency: "EUR", checkedAt: "2026-10-08T01:00:00Z", bookingUrl: "https://en.aegeanair.com/" };
const back: PricedDirection = { ...out, source: "ryanair", airline: "FR", origin: "ATH", destination: "TLV", date: q.returnDate, amount: 44.21, checkedAt: "2026-10-08T00:55:00Z", bookingUrl: "https://www.ryanair.com/" };
describe("separate official one-way combinations", () => {
  it("adds both real prices, retains both links and the older check time", () => {
    expect(combineDirectDirections([out, back], q)).toMatchObject([{ amount: 102.84, currency: "EUR", checkedAt: back.checkedAt, outbound: out, inbound: back, separateTickets: true }]);
  });
  it("does not infer a missing return or substitute dates and airports", () => {
    for (const f of [{ ...back, date: "2027-06-06" }, { ...back, destination: "ETM" }, { ...back, amount: NaN }]) expect(combineDirectDirections([out, f], q)).toEqual([]);
    expect(combineDirectDirections([out], q)).toEqual([]);
  });
  it("does not scale advertisements or add unlike currencies", () => {
    expect(combineDirectDirections([out, back], { ...q, adults: 2 })).toEqual([]);
    expect(combineDirectDirections([out, { ...back, currency: "USD" }], q)).toEqual([]);
  });
  it("deduplicates repeated records and sorts only within their currency", () => {
    const result = combineDirectDirections([out, out, back, { ...back, amount: 100 }], q);
    expect(result.map(f => f.amount)).toEqual([102.84, 158.63]);
  });
});
