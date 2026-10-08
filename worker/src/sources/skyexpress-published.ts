import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createSkyExpressPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "sky_express", airline: "GQ", routes: {}, originPages: [
    { origin: "ATH", destination: "FCO", sourceUrl: "https://www.skyexpress.gr/en/flights-from-athens", allDestinations: true },
  ] }, now, fetchFn, sharedCache);
}
