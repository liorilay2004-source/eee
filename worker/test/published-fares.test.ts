import { describe, expect, it } from "vitest";
import { parsePublishedFares, publishedFareUrl } from "../src/sources/published-fares";
const query = { airline: "A3", origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens", now: new Date("2026-10-07T21:00:00Z") };
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "ATH", departureDate: "2027-08-29", returnDate: "", totalPrice: 58.63, currencyCode: "EUR", flightType: "ONE_WAY" };
const html = (nodes: unknown[]) => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { fares: nodes } } })}</script>`;
describe("published official airline page data", () => {
  it("extracts the observed dated Aegean fare rather than a cheaper headline for another route", () => {
    expect(parsePublishedFares(html([{ ...fare, originAirportCode: "AXD", totalPrice: 22.3 }, fare]), query)).toEqual([expect.objectContaining({ amount: 58.63, departDate: "2027-08-29", origin: "TLV", destination: "ATH", pricing: "published_advertisement", returnDate: null })]);
  });
  it("does not invent missing or expired prices", () => {
    expect(parsePublishedFares(html([{ ...fare, departureDate: "2026-01-01" }, { ...fare, totalPrice: null }, { ...fare, flightType: "UNKNOWN" }]), query)).toEqual([]);
  });
  it("deduplicates fares and keeps actual published dates", () => {
    expect(parsePublishedFares(html([fare, fare]), query)).toHaveLength(1);
  });
  it("rejects unknown hosts, credentials and malformed data", () => {
    expect(() => publishedFareUrl("https://flights.aegeanair.com.evil.test/", "A3")).toThrow();
    expect(() => publishedFareUrl("https://user:password@flights.aegeanair.com/", "A3")).toThrow();
    expect(() => parsePublishedFares('<script id="__NEXT_DATA__">not json</script>', query)).toThrow();
  });
});
