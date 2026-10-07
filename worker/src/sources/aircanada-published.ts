import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
// Toronto's page heading uses YTO, but its dated fares specify YYZ.
export function createAirCanadaPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "air_canada", airline: "AC", routes: {
    "TLV:YYZ": [{ origin: "TLV", destination: "YYZ", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto" }],
    "TLV:YUL": [{ origin: "TLV", destination: "YUL", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv", allDestinations: true }],
    "TLV:ORD": [{ origin: "TLV", destination: "ORD", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv", allDestinations: true }],
  } }, now, fetchFn, sharedCache);
}