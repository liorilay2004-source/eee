import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createTapPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "tap", airline: "TP", routes: {
    "TLV:LIS": [{ origin: "TLV", destination: "LIS", sourceUrl: "https://www.flytap.com/en_pt/flights-from-tel-aviv-to-lisbon" }],
  } }, now, fetchFn, sharedCache);
}
