import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export const AMERICAN_PAGE = "https://www.aa.com/en-us/flights-from-los-angeles-to-mexico-city";
export function createAmericanPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "american", airline: "AA", routes: {
    "LAX:MEX": [{ origin: "LAX", destination: "MEX", sourceUrl: AMERICAN_PAGE }],
  } }, now, fetchFn, sharedCache);
}
