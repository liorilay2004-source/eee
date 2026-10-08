import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export const AERLINGUS_PAGE = "https://www.aerlingus.com/en-ie/flights-from-dublin";
export function createAerLingusPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "aer_lingus", airline: "EI", routes: {}, originPages:
    [{ origin: "DUB", destination: "AMS", sourceUrl: AERLINGUS_PAGE, allDestinations: true }],
  }, now, fetchFn, sharedCache);
}
