import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createAirEuropaPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "air_europa", airline: "UX", routes: {}, originPages: [{ origin: "TLV", destination: "MAD", sourceUrl: "https://www.aireuropa.com/en-il/flight-deals-from-tel-aviv-to-spain", allDestinations: true }] }, now, fetchFn, sharedCache);
}
