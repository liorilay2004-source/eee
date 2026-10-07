import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export { matchPublishedTrip } from "./published-source";
const pages = [
  { origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens" },
  { origin: "ATH", destination: "TLV", sourceUrl: "https://flights.aegeanair.com/he/flights-from-athens-to-tel-aviv" },
  { origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/en/flights-from-tel-aviv-to-athens" },
  { origin: "ATH", destination: "TLV", sourceUrl: "https://flights.aegeanair.com/en/flights-from-athens-to-tel-aviv" },
];
const romePages = [
  { origin: "ATH", destination: "FCO", sourceUrl: "https://flights.aegeanair.com/en/flights-from-athens-to-rome" },
  { origin: "FCO", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/en/flights-from-rome-to-athens" },
];
export function createAegeanPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "aegean", airline: "A3", routes: { "TLV:ATH": pages, "ATH:TLV": pages, "ATH:FCO": romePages, "FCO:ATH": romePages } }, now, fetchFn, sharedCache);
}
