import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createVirginPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "virgin_atlantic", airline: "VS", routes: {}, originPages: [{ origin: "TLV", destination: "JFK", sourceUrl: "https://flights.virginatlantic.com/en-il/flights-from-tel-aviv", allDestinations: true }] }, now, fetchFn, sharedCache);
}
