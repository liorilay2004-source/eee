import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
/** Advertised total excludes applicable Philippine Travel Tax; the UI discloses this. */
export function createPhilippinePublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "philippine", airline: "PR", routes: { "MNL:BKK": [{ origin: "MNL", destination: "BKK", sourceUrl: "https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok" }] } }, now, fetchFn, sharedCache);
}
