import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export { matchPublishedTrip } from "./published-source";
const pages = [
  { origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens" },
  { origin: "ATH", destination: "TLV", sourceUrl: "https://flights.aegeanair.com/he/flights-from-athens-to-tel-aviv" },
];
export function createAegeanPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "aegean", airline: "A3", routes: { "TLV:ATH": pages, "ATH:TLV": pages } }, now, fetchFn, sharedCache);
}