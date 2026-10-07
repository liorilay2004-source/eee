import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingActions, FlightDetailsCard } from "../components/OfferCards";
import { demoResult } from "./demo";

describe("flight details and official airline handoff", () => {
  const fixture = () => {
    const { cards, request } = demoResult("2026-10-07");
    const card = cards[0];
    card.offer.outbound.airlines = ["LY"];
    card.offer.inbound.airlines = ["LY"];
    card.airlineNames = { LY: "אל על" };
    card.offer.deeplink = "https://www.aviasales.com/search/TLVATH";
    return { card, request };
  };
  it("hands off to the official carrier rather than mislabeling an aggregator URL", () => {
    const { card } = fixture();
    const html = renderToStaticMarkup(<BookingActions card={card} />);
    expect(html).toContain('href="https://www.elal.com/"');
    expect(html).not.toContain("aviasales.com");
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain("יש לבחור שם את המסלול והתאריכים");
  });
  it("shows the returned fare and marks missing flight times instead of inventing them", () => {
    const { card, request } = fixture();
    const html = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="תל אביב" destinationLabel="אתונה" />);
    expect(html).toContain("אל על");
    expect(html).toContain("תל אביב");
    expect(html).toContain("אתונה");
    expect(html).toContain("1,234");
    expect(html).toContain("השעה תופיע באתר ההזמנה");
    expect(html).not.toContain("06:40");
  });
  it("does not invent an official link when the source gives an unknown airline", () => {
    const { card } = fixture();
    card.offer.outbound.airlines = ["XX"];
    card.offer.inbound.airlines = ["XX"];
    const html = renderToStaticMarkup(<BookingActions card={card} />);
    expect(html).not.toContain("href=");
    expect(html).toContain("המקור לא מסר");
  });
});
