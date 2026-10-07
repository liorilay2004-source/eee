import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createTapPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  const originPage = { origin: "TLV", destination: "LIS", sourceUrl: "https://www.flytap.com/en_il/flights-from-tel-aviv", allDestinations: true };
  return createPublishedSource({ source: "tap", airline: "TP", routes: {
    "TLV:LIS": [{ origin: "TLV", destination: "LIS", sourceUrl: "https://www.flytap.com/en_pt/flights-from-tel-aviv-to-lisbon" }, originPage],
  }, originPages: [originPage] }, now, fetchFn, sharedCache);
}
