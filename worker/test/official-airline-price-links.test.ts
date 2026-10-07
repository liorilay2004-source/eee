import { describe, expect, it } from "vitest";
import { airlinePriceLinks } from "../src/airlines/official-links";
import type { Offer } from "../src/types";
const offer: Offer = {
  origin: "ATH", destination: "FCO", departDate: "2027-01-25", returnDate: "2027-01-29",
  source: "direct_combination", priceAmount: 83.43, priceCurrency: "EUR", totalIls: 286.67,
  ticketStructure: "split", outbound: { airlines: ["A3"], departTime: null, arriveTime: null, durationMin: null, stops: null },
  inbound: { airlines: ["FR"], departTime: null, arriveTime: null, durationMin: null, stops: null },
  includes: {}, deeplink: null, verifyLink: null, checkedAt: "2026-10-08T00:00:00Z", extrasAmountIls: 0, tags: [],
};
describe("official airline links retain total itinerary price context", () => {
  it("identifies all carriers when the amount includes another airline's ticket", () => {
    expect(airlinePriceLinks([offer])).toMatchObject([
      { code: "A3", priceIls: 286.67, participatingAirlines: ["A3", "FR"] },
      { code: "FR", priceIls: 286.67, participatingAirlines: ["A3", "FR"] },
    ]);
  });
  it("does not attach a mixed itinerary label to one carrier", () => {
    const links = airlinePriceLinks([{ ...offer, inbound: offer.outbound }]);
    expect(links).toHaveLength(1);
    expect(links[0]?.participatingAirlines).toBeUndefined();
  });
  it("uses the context of the cheapest itinerary for each airline", () => {
    const links = airlinePriceLinks([offer, { ...offer, inbound: offer.outbound, totalIls: 200 }]);
    expect(links[0]).toMatchObject({ code: "A3", priceIls: 200 });
    expect(links[0]?.participatingAirlines).toBeUndefined();
    expect(links[1]?.participatingAirlines).toEqual(["A3", "FR"]);
  });
});
