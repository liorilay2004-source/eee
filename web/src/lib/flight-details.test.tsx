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
  it("shows Norwegian as the price source without inventing its operating carrier", () => {
    const { card, request } = fixture();
    card.offer.source = "norwegian";
    card.offer.outbound.airlines = []; card.offer.inbound.airlines = [];
    card.airlineNames = {};
    card.offer.ticketStructure = "split";
    card.offer.deeplink = "https://www.norwegian.com/en/low-fare-calendar/Athens-OsloGardermoen";
    card.offer.returnDeeplink = card.offer.deeplink;
    card.offer.tags = ["published_advertisement"];
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="אתונה" destinationLabel="אוסלו" />);
    expect(details).toContain("Norwegian");
    expect(details).toContain("חברת התעופה המפעילה והכבודה לא נמסרו");
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink += "?untrusted=1"; card.offer.returnDeeplink = card.offer.deeplink;
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("shows Eurowings calendar totals with the official link and no invented flight details", () => {
    const {card,request}=fixture();
    card.offer.source="eurowings";card.offer.outbound.airlines=[];card.offer.inbound.airlines=[];
    card.offer.outbound.stops=null;card.offer.inbound.stops=null;
    card.offer.tags=["published_advertisement","advertised_calendar_price"];
    card.offer.deeplink="https://www.eurowings.com/en/booking/flights/low-fare-calendar.html";
    const details=renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="Heathrow" destinationLabel="Dusseldorf" />);
    expect(details).toContain("Eurowings");
    expect(details).toContain("בלי הנחת מועדון");
    expect(details).toContain("שעות הטיסה, העצירות והכבודה לא נמסרו");
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink+="?untrusted=1";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("opens the dated Brussels booking link without claiming a saved booking", () => {
    const {card}=fixture();card.offer.source="brussels_airlines";
    card.offer.outbound.airlines=[];card.offer.inbound.airlines=[];
    card.offer.deeplink="https://www.brusselsairlines.com/aircore/deeplink/redirect/en/be/BRU/ATH/04.06.2027/18.06.2027/RT";
    const markup=renderToStaticMarkup(<BookingActions card={card} />);
    expect(markup).toContain(card.offer.deeplink);
    expect(markup).toContain("קישור רשמי עם תאריכי הלוך וחזור");
    card.offer.deeplink+="?untrusted=1";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("opens only the observed dated Lufthansa seller link", () => {
    const {card}=fixture();card.offer.source="lufthansa";
    card.offer.outbound.airlines=[];card.offer.inbound.airlines=[];
    card.offer.deeplink="https://www.lufthansa.com/aircore/deeplink/redirect/en/gr/ATH/TLV/05.06.2027/19.06.2027/RT";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink+="?untrusted=1";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("opens only the observed Swiss dated official booking link",()=>{
    const {card}=fixture();card.offer.source="swiss";
    card.offer.deeplink="https://www.swiss.com/aircore/deeplink/redirect/en/ch/ZRH/TLV/01.06.2027/15.06.2027/RT";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink+="?untrusted=1";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("opens only the observed official Icelandair fare page", () => {
    const {card}=fixture();card.offer.source="icelandair";card.offer.outbound.airlines=["FI"];card.offer.inbound.airlines=["FI"];
    card.offer.deeplink="https://www.icelandair.com/en-gb/flights/flights-from-london-to-iceland";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink+="?untrusted=1";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("labels imported EL AL advertisements and validates the official page", () => {
    const { card, request } = fixture();
    card.offer.source = "elal";
    card.offer.deeplink = "https://www.elal.com/flight-deals/en-il/";
    card.offer.priceAmount = 159;
    card.offer.priceCurrency = "USD";
    card.offer.tags = [];
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="תל אביב" destinationLabel="אתונה" />);
    expect(details).toContain("159 USD");
    expect(details).toContain("בבדיקה נקודתית");
    expect(details).toContain("תנאי המזוודה לא נמסרו במקור");
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink += "?api_key=secret";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("api_key");
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
  it("links a published price to the validated official route page", () => {
    const { card, request } = fixture();
    card.offer.source = "air_canada";
    card.offer.deeplink = "https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto";
    card.offer.outbound.airlines = card.offer.inbound.airlines = ["AC"];
    const html = renderToStaticMarkup(<BookingActions card={card} />);
    expect(html).toContain('href="https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto"');
    expect(html).toContain("הקישור אינו הזמנה שמורה");
    card.offer.priceAmount = 1009;
    card.offer.priceCurrency = "CAD";
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="תל אביב" destinationLabel="טורונטו" />);
    expect(details).toContain("1,009 CAD");
    card.offer.deeplink = "https://www.aircanada.com.evil.test/en-ca/flights-from-tel-aviv-to-toronto";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("evil.test");
  });
  it("keeps validated links for mixed directions beyond Aegean and Ryanair", () => {
    const { card } = fixture();
    card.offer.source = "direct_combination";
    card.offer.ticketStructure = "split";
    card.offer.outbound.airlines = ["AC"];
    card.offer.inbound.airlines = ["TP"];
    card.offer.deeplink = "https://www.aircanada.com/en-ca/flights-from-tel-aviv";
    card.offer.returnDeeplink = "https://www.flytap.com/en_il/flights-from-tel-aviv";
    const html = renderToStaticMarkup(<BookingActions card={card} />);
    expect(html).toContain(card.offer.deeplink);
    expect(html).toContain(card.offer.returnDeeplink);
    expect(html.match(/href=/g)).toHaveLength(2);
    card.offer.returnDeeplink = "https://www.aircanada.com/en-ca/flights-from-tel-aviv";
    expect(renderToStaticMarkup(<BookingActions card={card} />).match(/href=/g)).toHaveLength(1);
  });
  it("shows the Air NZ dated original fare and only the verified official page", () => {
    const { card, request } = fixture();
    card.offer.source = "air_new_zealand";
    card.offer.deeplink = "https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles";
    card.offer.priceAmount = 911.53;
    card.offer.priceCurrency = "USD";
    card.offer.tags = []; // API normalization may remove adapter-only tags.
    card.offer.outbound.airlines = card.offer.inbound.airlines = ["NZ"];
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain('href="https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles"');
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="לוס אנג׳לס" destinationLabel="אוקלנד" />);
    expect(details).toContain("911.53 USD");
    expect(details).toContain("תנאי המזוודה לא נמסרו במקור");
    expect(details).not.toContain("המחיר בלי מזוודה נגררת");
    expect(details).toContain("מחיר הלוך ושוב שפורסם באתר Air New Zealand למבוגר אחד");
    card.offer.deeplink = "https://www.airnewzealand.com.evil.test/flights/en-us/flights-from-los-angeles";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("evil.test");
  });
  it("hands off a TAP origin-page fare only to the verified public page", () => {
    const { card } = fixture();
    card.offer.source = "tap";
    card.offer.deeplink = "https://www.flytap.com/en_il/flights-from-tel-aviv";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain('href="https://www.flytap.com/en_il/flights-from-tel-aviv"');
    card.offer.deeplink += "?api_key=untrusted";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("shows the dated airBaltic fare, unknown baggage and the verified official page", () => {
    const { card, request } = fixture();
    card.offer.source = "air_baltic";
    card.offer.deeplink = "https://www.airbaltic.com/en/flight-deals/flights-from-israel";
    card.offer.outbound.airlines = card.offer.inbound.airlines = ["BT"];
    card.offer.priceAmount = 298.55;
    card.offer.priceCurrency = "EUR";
    card.offer.tags = [];
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="תל אביב" destinationLabel="ריגה" />);
    expect(details).toContain("298.55 EUR");
    expect(details).toContain("מחיר שפורסם באתר airBaltic למבוגר אחד");
    expect(details).toContain("תנאי המזוודה לא נמסרו במקור");
    card.offer.deeplink = "https://www.airbaltic.com.evil.test/en/flight-deals/flights-from-israel";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("evil.test");
  });
  it("opens the verified SKY express fare page and rejects unrelated page parameters", () => {
    const { card } = fixture();
    card.offer.source = "sky_express";
    card.offer.deeplink = "https://www.skyexpress.gr/en/flights-from-athens";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink += "?api_key=untrusted";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("opens only the verified GOL origin page for a published fare", () => {
    const { card } = fixture();
    card.offer.source = "gol";
    card.offer.deeplink = "https://www.voegol.com.br/en/flights-from-sao-paulo";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain(card.offer.deeplink);
    card.offer.deeplink = "https://www.voegol.com.br.evil.test/en/flights-from-sao-paulo";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("evil.test");
  });
  it("discloses excluded Philippine travel tax beside the advertised fare", () => {
    const { card, request } = fixture();
    card.offer.source = "philippine";
    card.offer.deeplink = "https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok";
    card.offer.outbound.airlines = card.offer.inbound.airlines = ["PR"];
    const details = renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="מנילה" destinationLabel="בנגקוק" />);
    expect(details).toContain("אינו כולל מס נסיעות פיליפיני למי שחייב בו");
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain('href="https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok"');
  });
  it("allows the verified Air Canada origin fare page", () => {
    const { card } = fixture();
    card.offer.source = "air_canada";
    card.offer.outbound.airlines = card.offer.inbound.airlines = ["AC"];
    card.offer.deeplink = "https://www.aircanada.com/en-ca/flights-from-tel-aviv";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).toContain('href="https://www.aircanada.com/en-ca/flights-from-tel-aviv"');
    card.offer.deeplink += "?token=untrusted";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("untrusted");
  });
  it("keeps separate official booking links for both mixed-airline directions", () => {
    const { card, request } = fixture();
    card.offer.source = "direct_combination";
    card.offer.ticketStructure = "split";
    card.offer.outbound.airlines = ["A3"];
    card.offer.inbound.airlines = ["FR"];
    card.offer.deeplink = "https://flights.aegeanair.com/en/flights-from-rome-to-athens";
    card.offer.returnDeeplink = "https://www.ryanair.com/";
    const html = renderToStaticMarkup(<BookingActions card={card} />);
    expect(html).toContain("לאתר החברה · הלוך");
    expect(html).toContain("לאתר החברה · חזור");
    expect(html).toContain(card.offer.deeplink);
    expect(html).toContain(card.offer.returnDeeplink);
    expect(html).toContain("שני כרטיסים נפרדים");
    expect(renderToStaticMarkup(<FlightDetailsCard card={card} request={request} originLabel="רומא" destinationLabel="אתונה" />)).toContain("שילוב שני מחירי כיוון אחד");
    card.offer.returnDeeplink = "https://www.ryanair.com.evil.test/";
    expect(renderToStaticMarkup(<BookingActions card={card} />)).not.toContain("evil.test");
  });
});
