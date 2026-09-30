import type { CardView, SearchRequest } from "../api/contract";
import { addDays } from "./builder";

/**
 * Illustrative data for the idle "show me an example" button. It is never sent anywhere, carries NO booking
 * links, and every screen that shows it is labelled as an example, not a price.
 */
export function demoResult(today: string): { request: SearchRequest; cards: CardView[] } {
  const start = addDays(today, 30);
  const request: SearchRequest = {
    origin: "TLV", destination: "ATH", windowStart: start, windowEnd: addDays(start, 30),
    stayMin: 3, stayMax: 5, adults: 2, children: 0, infants: 0, cabin: "economy", checkedBag: false,
    outHours: null, retHours: null, maxStops: null, nearbyAirports: false,
  };
  const leg = (departTime: string | null, arriveTime: string | null, stops: number | null, durationMin: number | null, airlines: string[]) =>
    ({ departTime, arriveTime, stops, durationMin, airlines });
  const card = (depart: number, nights: number, total: number, kinds: CardView["kinds"], split = false): CardView => ({
    kinds,
    savingsVsRoundtripIls: null,
    priceContext: null,
    ageHours: 0,
    offer: {
      origin: "TLV", destination: "ATH", departDate: addDays(start, depart), returnDate: addDays(start, depart + nights),
      priceAmount: total, priceCurrency: "ILS", source: "travelpayouts", ticketStructure: split ? "split" : "roundtrip",
      outbound: split ? leg("06:40", "09:05", 0, 145, ["XX"]) : leg(null, null, 0, 140, ["XX"]),
      inbound: split ? leg("21:10", "23:30", 0, 140, ["YY"]) : leg(null, null, 0, 150, ["XX"]),
      includes: {}, deeplink: null, returnDeeplink: null, verifyLink: null, checkedAt: `${today}T00:00:00Z`,
      extrasAmountIls: 0, totalIls: total, tags: [],
    },
  });
  return {
    request,
    cards: [
      card(4, 4, 1234, ["cheapest"]),
      card(9, 4, 1456, ["best_value"], true),
      card(12, 5, 1678, ["my_times"]),
    ],
  };
}
