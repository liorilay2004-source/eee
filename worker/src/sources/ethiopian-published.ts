import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createEthiopianPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "ethiopian", airline: "ET", routes: {}, originPages: [
    { origin: "TLV", destination: "BKK", sourceUrl: "https://www.ethiopianairlines.com/en-il/", allDestinations: true },
  ] }, now, fetchFn, sharedCache);
}
