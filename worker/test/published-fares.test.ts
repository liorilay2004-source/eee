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
  const day = { departureDate: "2026-11-06", journeyType: "ONE_WAY", outboundFlight: { fareClass: "ECONOMY", departureAirportIataCode: "TLV", arrivalAirportIataCode: "ATH" }, priceSpecification: { totalPrice: 119.44, currencyCode: "EUR" }, airline: { iataCode: "A3" }, isPastDay: false };
  it("reads a fully specified daily calendar cash fare with exact airports", () => {
    expect(parsePublishedFares(html([day, day]), query)).toMatchObject([{ amount: 119.44, currency: "EUR", departDate: day.departureDate, structure: "oneway", returnDate: null }]);
    expect(parsePublishedFares(html([{ ...day, outboundFlight: { ...day.outboundFlight, arrivalAirportIataCode: "FCO" } }]), query)).toEqual([]);
  });
  it("rejects month minima, missing dates, other carriers, premium cabins and redemptions", () => {
    const invalid = [ { ...day, journeyType: "ROUND_TRIP" }, { ...day, departureDate: null }, { ...day, airline: { iataCode: "FR" } }, { ...day, outboundFlight: { ...day.outboundFlight, fareClass: "BUSINESS" } }, { ...day, redemption: { unit: "MILES" } }, { ...day, isPastDay: true }, { ...day, priceSpecification: { totalPrice: null, currencyCode: "EUR" } } ];
    expect(parsePublishedFares(html(invalid), query)).toEqual([]);
  });
});

describe("Aer Lingus explicitly one-way published cash fares", () => {
  const ei = { ...query, airline: "EI", origin: "DUB", destination: "AMS", sourceUrl: "https://www.aerlingus.com/en-ie/flights-from-dublin" };
  const oneWay = { ...fare, originAirportCode: "DUB", destinationAirportCode: "AMS", departureDate: "2027-01-26", totalPrice: 41.45, travelClass: "low" };
  it("retains the exact observed dated one-way amount", () => {
    expect(parsePublishedFares(html([oneWay]), ei)).toMatchObject([{ airline: "EI", origin: "DUB", destination: "AMS", departDate: "2027-01-26", amount: 41.45, currency: "EUR", structure: "oneway", returnDate: null }]);
  });
  it("rejects every round-trip record because visible fares can be per direction", () => {
    expect(parsePublishedFares(html([ ...["low", "saver", "ECONOMY", null].map(travelClass => ({ ...oneWay, flightType: "ROUND_TRIP", returnDate: "2027-01-30", travelClass })) ]), ei)).toEqual([]);
  });
  it("does not accept unrelated routes, premium cabins or malformed returns", () => {
    expect(parsePublishedFares(html([{ ...oneWay, originAirportCode: "ORK" }, { ...oneWay, travelClass: "BUSINESS" }, { ...oneWay, returnDate: "2027-01-30" }]), ei)).toEqual([]);
  });
});

describe("American Airlines exact published round-trip fares", () => {
  const aa = { ...query, airline: "AA", origin: "LAX", destination: "MEX", sourceUrl: "https://www.aa.com/en-us/flights-from-los-angeles-to-mexico-city" };
  const observed = { ...fare, originAirportCode: "LAX", destinationAirportCode: "MEX", departureDate: "2027-01-20", returnDate: "2027-01-27", flightType: "ROUND_TRIP", travelClass: "ECONOMY", totalPrice: 451.63, currencyCode: "USD" };
  it("retains both observed dates and the unrounded cash amount", () => {
    expect(parsePublishedFares(html([observed, observed]), aa)).toMatchObject([{ airline: "AA", origin: "LAX", destination: "MEX", departDate: "2027-01-20", returnDate: "2027-01-27", amount: 451.63, currency: "USD", structure: "roundtrip" }]);
  });
  it("accepts the observed larger official page while bounding parsing", () => {
    expect(parsePublishedFares(" ".repeat(2_170_000) + html([observed]), aa)).toHaveLength(1);
    expect(() => parsePublishedFares(" ".repeat(3_000_001), aa)).toThrow("too large");
    expect(() => parsePublishedFares(" ".repeat(2_000_001), query)).toThrow("too large");
  });
  it("does not turn monthly minima, miles or incomplete fares into cash trips", () => {
    expect(parsePublishedFares(html([{ totalPrice: 451.63, currencyCode: "USD" }, { ...observed, redemption: { unit: "MILES" } }, { ...observed, returnDate: null }]), aa)).toEqual([]);
  });
});

describe("KLM browser-rendered official dated fare data", () => {
  const kl = { ...query, airline: "KL", origin: "TLV", destination: "AMS", sourceUrl: "https://www.klm.co.il/en-il/flights-from-tel-aviv", allDestinations: true };
  const observed = { ...fare, departureDate: "2026-12-07", returnDate: "2026-12-14", flightType: "ROUND_TRIP", travelClass: "ECONOMY", totalPrice: 419.17, currencyCode: "USD", destinationAirportCode: "AMS" };
  it("extracts the exact observed round-trip and retains other actual destinations", () => {
    expect(parsePublishedFares(html([observed,{ ...observed,destinationAirportCode:"GOT",totalPrice:341.17 }]),kl)).toMatchObject([{airline:"KL",destination:"GOT",amount:341.17},{airline:"KL",destination:"AMS",amount:419.17,departDate:"2026-12-07",returnDate:"2026-12-14"}]);
  });
  it("ignores incomplete headline and premium records",()=>{
    expect(parsePublishedFares(html([{totalPrice:419.17,currencyCode:"USD"},{...observed,travelClass:"BUSINESS"}]),kl)).toEqual([]);
  });
});
