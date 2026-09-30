import { describe, expect, it, vi } from "vitest";
import { createQuoteSource } from "../src/quotes";
import { createDuffelSource, duffelAdapter, DUFFEL_QUOTA } from "../src/sources/duffel";
import type { QuoteQuery } from "../src/quotes";
import { createTestD1 } from "./helpers/d1";
import { createRepo } from "../src/db";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const Q: QuoteQuery = { origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18", party: { adults: 1, children: 0, infants: 0 } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function offer(over: Record<string, unknown> = {}) {
  const segment = (from: string, to: string, date: string, dep: string, arr: string, code = "LY") => ({
    origin: { iata_code: from },
    destination: { iata_code: to },
    departing_at: `${date}T${dep}:00`,
    arriving_at: `${date}T${arr}:00`,
    duration: "PT4H50M",
    marketing_carrier: { iata_code: code, name: "El Al" },
    operating_carrier: { iata_code: code, name: "El Al" },
    marketing_carrier_flight_number: "395",
    passengers: [{ baggages: [{ type: "checked", quantity: 1 }] }],
  });
  return {
    partial: false,
    total_amount: "123.45",
    total_currency: "USD",
    slices: [
      { duration: "PT4H50M", segments: [segment("TLV", "BCN", "2026-11-12", "08:05", "12:55")] },
      { duration: "PT4H30M", segments: [segment("BCN", "TLV", "2026-11-18", "15:30", "20:00")] },
    ],
    ...over,
  };
}

describe("Duffel source", () => {
  it("builds the documented Duffel v2 offer request without putting the token in the URL", () => {
    const req = duffelAdapter.request(Q, "duffel_test_SECRET");
    expect(req.url).toBe("https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=10000&view=offers");
    expect(req.url).not.toContain("duffel_test_SECRET");
    expect(req.method).toBe("POST");
    expect(req.headers).toMatchObject({ Authorization: "Bearer duffel_test_SECRET", "Duffel-Version": "v2", "Content-Type": "application/json" });
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      data: {
        cabin_class: "economy",
        passengers: [{ type: "adult" }],
        slices: [
          { origin: "TLV", destination: "BCN", departure_date: "2026-11-12" },
          { origin: "BCN", destination: "TLV", departure_date: "2026-11-18" },
        ],
      },
    });
  });

  it("reads total price, carriers, stops and baggage from Duffel offers", async () => {
    const source = createQuoteSource(duffelAdapter, {
      key: "duffel_test_SECRET",
      repo: createRepo(createTestD1()),
      now: NOW,
      marker: "12345",
      fetchFn: vi.fn(async () => json({ data: { offers: [offer(), offer({ total_amount: "120.00", slices: [
        { duration: "PT6H00M", segments: [
          { origin: { iata_code: "TLV" }, destination: { iata_code: "ATH" }, departing_at: "2026-11-12T07:00:00", arriving_at: "2026-11-12T09:10:00", duration: "PT2H10M", marketing_carrier: { iata_code: "A3" }, passengers: [{ baggages: [] }] },
          { origin: { iata_code: "ATH" }, destination: { iata_code: "BCN" }, departing_at: "2026-11-12T10:00:00", arriving_at: "2026-11-12T13:00:00", duration: "PT3H00M", marketing_carrier: { iata_code: "A3" }, passengers: [{ baggages: [] }] },
        ] },
        { duration: "PT4H30M", segments: [{ origin: { iata_code: "BCN" }, destination: { iata_code: "TLV" }, departing_at: "2026-11-18T15:30:00", arriving_at: "2026-11-18T20:00:00", duration: "PT4H30M", marketing_carrier: { iata_code: "LY" }, passengers: [{ baggages: [] }] }] },
      ] })] } })) as unknown as typeof fetch,
    });
    const offers = await source.quote(Q);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ source: "duffel", priceAmount: 120, priceCurrency: "USD", ticketStructure: "roundtrip" });
    expect(offers[0]?.outbound).toMatchObject({ departTime: "07:00", arriveTime: "13:00", stops: 1, durationMin: 360, airlines: ["A3"] });
    expect(offers[0]?.inbound).toMatchObject({ departTime: "15:30", arriveTime: "20:00", stops: 0, airlines: ["LY"] });
    expect(offers[0]?.includes.checkedBag).toBe(false);
    expect(offers[1]?.includes.checkedBag).toBe(true);
    expect(offers[0]?.deeplink).toMatch(/marker=12345/);
  });

  it("is inert for live tokens unless DUFFEL_ALLOW_LIVE is enabled", () => {
    const repo = createRepo(createTestD1());
    const blocked = createDuffelSource({ apiToken: "duffel_live_SECRET", repo, now: NOW });
    const allowed = createDuffelSource({ apiToken: "duffel_live_SECRET", allowLive: true, repo, now: NOW });
    const test = createDuffelSource({ apiToken: "duffel_test_SECRET", repo, now: NOW });
    expect(blocked.configured).toBe(false);
    expect(allowed.configured).toBe(true);
    expect(test.configured).toBe(true);
    expect(blocked.quota).toEqual(DUFFEL_QUOTA);
  });

  it("drops partial, mismatched, one-way, currencyless and malformed offers", () => {
    const fares = duffelAdapter.parse({ data: { offers: [offer({ partial: true }), offer({ total_currency: "" }), offer({ slices: [offer().slices[0]] }), offer({ slices: [{ duration: "PT1H", segments: [{ origin: { iata_code: "XXX" }, destination: { iata_code: "BCN" }, departing_at: "2026-11-12T01:00:00" }] }, offer().slices[1]] }), offer()] } }, Q);
    expect(fares).toHaveLength(1);
    expect(fares[0]?.price).toBe(123.45);
  });
});
