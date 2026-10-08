import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EEE } from "./helpers.mjs";
import "../lib/site-observer.js";

const parse = EEE.siteObserver.parsePage;

describe("airline site event observation", () => {
  it("extracts the route and exact dates from Lufthansa's route/departure/return URL", () => {
    const rows = parse(
      "https://www.lufthansa.com/il/en/flight-search?route=TLVFRA&departure=20270601&return=20270622",
      ["Total price USD 1,234.50"],
    );
    assert.deepEqual(rows[0], {
      origin: "TLV", destination: "FRA", departDate: "2027-06-01", returnDate: "2027-06-22", priceAmount: 1234.5, currency: "USD",
    });
  });

  it("parses prices displayed in European separators and dates in common written form", () => {
    const rows = parse("https://www.klm.com/booking?from=TLV&to=AMS&departureDate=01/06/2027&returnDate=20270622", ["€ 1.234,50"]);
    assert.deepEqual(rows[0], {
      origin: "TLV", destination: "AMS", departDate: "2027-06-01", returnDate: "2027-06-22", priceAmount: 1234.5, currency: "EUR",
    });
  });

  it("returns a visible price candidate when route fields are missing without inventing route or dates", () => {
    assert.deepEqual(parse("https://www.ryanair.com/", ["₪ 799"]), [{
      origin: null, destination: null, departDate: null, returnDate: null, priceAmount: 799, currency: "ILS",
    }]);
  });

  it("does not inspect non-HTTPS URLs or treat an uncurrency-marked number as a fare", () => {
    assert.deepEqual(parse("http://www.example.com/?route=TLVFRA", ["USD 800"]), []);
    assert.deepEqual(parse("https://www.lufthansa.com/?route=TLVFRA", ["Flight 800"]), []);
  });
});
