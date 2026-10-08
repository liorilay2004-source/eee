import { describe, expect, it } from "vitest";
import { parseBrusselsAdvertisements } from "../src/brussels-advertisements";
const now = new Date("2026-10-08T03:40:00Z");
const route = { origin: "BRU", destination: "ATH" };
const url = "/aircore/deeplink/redirect/en/be/BRU/ATH/04.06.2027/18.06.2027/RT";
describe("dated Brussels advertisements", () => {
  it("preserves the observed June date pair and official handoff", () => {
    expect(parseBrusselsAdvertisements([{ text: "from   184 €     Jun.   4 Jun.", url }], route, now)).toEqual([
      { ...route, departDate: "2027-06-04", returnDate: "2027-06-18", amount: 184, currency: "EUR",
        bookingUrl: `https://www.brusselsairlines.com${url}`, checkedAt: now.toISOString(),
        pricing: "published_advertisement", carrier: null },
    ]);
  });
  it("cannot answer TLV–ATH with a BRU–ATH advertisement", () => {
    expect(parseBrusselsAdvertisements([{ text: "from 184 €", url }], { ...route, origin: "TLV" }, now)).toEqual([]);
  });
  it.each(["https://evil.example" + url, url + "?token=x", url.replace("04.06", "31.06"), url.replace("/RT", "/OW")])("rejects invalid or unrelated links %s", (bad) => {
    expect(parseBrusselsAdvertisements([{ text: "from 184 €", url: bad }], route, now)).toEqual([]);
  });
  it.each(["from 184.50 €", "from 184 USD", "View offer", "from 0 €", "from 184 € from 200 €"])("rejects unsupported price text %s", text => {
    expect(parseBrusselsAdvertisements([{ text, url }], route, now)).toEqual([]);
  });
  it("rejects conflicting advertisements rather than choosing the cheaper claim", () => {
    expect(parseBrusselsAdvertisements([{text:"from 150 €",url},{text:"from 151 EUR",url}],route,now)).toEqual([]);
  });
});
