import { describe, expect, it } from "vitest";
import { parseTicketPrices } from "../src/ticket-prices";
import { sanitizeOffers } from "../src/pipeline";
import type { Offer } from "../src/types";
const prices = { outbound: { amount: 49.44, currency: "EUR", airline: "A3" }, inbound: { amount: 33.99, currency: "EUR", airline: "FR" } };
const leg = { departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: ["A3"] };
const offer: Offer = { origin: "ATH", destination: "FCO", departDate: "2027-01-25", returnDate: "2027-01-29", source: "direct_combination", priceAmount: 83.43, priceCurrency: "EUR", ticketStructure: "split", outbound: leg, inbound: { ...leg, airlines: ["FR"] }, includes: {}, deeplink: null, verifyLink: null, checkedAt: "2026-10-08T00:00:00Z", extrasAmountIls: 0, totalIls: null, tags: [], ticketPrices: prices };
describe("original separate ticket amounts", () => {
  it("keeps the real amounts through offer normalization", () => {
    expect(parseTicketPrices(prices, offer)).toEqual(prices);
    expect(sanitizeOffers([offer], ["direct_combination"])[0]?.ticketPrices).toEqual(prices);
  });
  it("rejects inconsistent totals, currencies, carriers and non-finite values", () => {
    for (const change of [{ amount: 30 }, { amount: NaN }, { amount: -1 }, { currency: "USD" }, { airline: "LY" }]) {
      expect(parseTicketPrices({ ...prices, inbound: { ...prices.inbound, ...change } }, offer)).toBeUndefined();
    }
    expect(parseTicketPrices(prices, { ...offer, ticketStructure: "roundtrip" })).toBeUndefined();
  });
});
