import { describe, expect, it } from "vitest";
import { createRyanairDirectSource, fetchRyanairCalendar, parseRyanairCalendar, ryanairCalendarUrl } from "../src/sources/ryanair-direct";

const now = new Date("2026-10-07T21:00:00Z");
const row = { day: "2027-06-01", departureDate: "2027-06-01T20:05:00", arrivalDate: "2027-06-01T21:25:00", price: { value: 40.99, currencyCode: "EUR" }, soldOut: false, unavailable: false };
const parse = (rows: unknown[]) => parseRyanairCalendar({ outbound: { fares: rows } }, "STN", "DUB", "2027-06", now);

describe("official Ryanair fare calendar", () => {
  it("combines exact dates and shares complete monthly calendars across repeated searches", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ outbound: { fares: [row, { ...row, day: "2027-06-05", departureDate: "2027-06-05T20:05:00", arrivalDate: "2027-06-05T21:25:00" }] } }))) as typeof fetch;
    const q = { origin: "LTN", destination: "DUB", departDate: "2027-06-01", returnDate: "2027-06-05", party: { adults: 1, children: 0, infants: 0 } };
    const source = createRyanairDirectSource(now, fetchFn);
    const offers = await source.quote(q);
    expect(offers[0]).toMatchObject({ source: "ryanair", ticketStructure: "split", priceAmount: 81.98, departDate: q.departDate, returnDate: q.returnDate });
    expect(source.callCount()).toBe(2);
    await source.quote(q);
    expect(source.callCount()).toBe(2);
    const other = createRyanairDirectSource(now, fetchFn);
    await other.quote(q);
    expect(other.callCount()).toBe(0);
  });
  it("does not invent party prices from a single-adult calendar", async () => {
    const source = createRyanairDirectSource(now, (async () => { throw new Error("should not fetch"); }) as typeof fetch);
    expect(await source.quote({ origin: "STN", destination: "DUB", departDate: "2027-06-01", returnDate: "2027-06-05", party: { adults: 2, children: 0, infants: 0 } })).toEqual([]);
    expect(source.callCount()).toBe(0);
  });
  it("reads observed one-adult website prices with provenance", () => {
    expect(parse([row])[0]).toMatchObject({ amount: 40.99, currency: "EUR", date: "2027-06-01", airline: "FR", pricing: "advertised_one_adult", checkedAt: now.toISOString() });
  });
  it("never invents prices for unavailable days", () => {
    expect(parse([{ ...row, unavailable: true }, { ...row, soldOut: true }, { ...row, price: null }])).toEqual([]);
  });
  it("rejects wrong dates, currencies and malformed amounts", () => {
    expect(parse([{ ...row, day: "2027-07-01" }, { ...row, price: { value: -1, currencyCode: "EUR" } }, { ...row, price: { value: 40, currencyCode: "USD" } }, { ...row, departureDate: "2027-06-02T20:05:00" }])).toEqual([]);
  });
  it("restricts requests to validated official calendar URLs", () => {
    expect(() => ryanairCalendarUrl("https://evil", "DUB", "2027-06")).toThrow();
    expect(() => ryanairCalendarUrl("STN", "DUB", "2027-13")).toThrow();
  });
  it("drops invalid calendar days without failing the entire source", () => {
    expect(parse([{ ...row, day: "2027-06-99" }, row])).toHaveLength(1);
  });
  it("fetches once and never follows redirects", async () => {
    let calls = 0;
    const fetchFn = (async (_url, init) => { calls++; expect(init?.redirect).toBe("error"); return new Response(JSON.stringify({ outbound: { fares: [row] } })); }) as typeof fetch;
    expect(await fetchRyanairCalendar("STN", "DUB", "2027-06", now, fetchFn)).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
