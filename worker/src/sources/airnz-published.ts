import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
/** Official US point-of-sale cash economy advertisements, per adult. */
export function createAirNzPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "air_new_zealand", airline: "NZ", routes: {}, originPages: [{ origin: "LAX", destination: "AKL", sourceUrl: "https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles", allDestinations: true }] }, now, fetchFn, sharedCache);
}
