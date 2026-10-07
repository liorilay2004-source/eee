import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
/** Official dated cash economy advertisements; never a whole-party reserved fare. */
export function createAirBalticPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  const originPage = { origin: "TLV", destination: "RIX", sourceUrl: "https://www.airbaltic.com/en/flight-deals/flights-from-israel", allDestinations: true };
  const rigaPage = { origin: "RIX", destination: "TLV", sourceUrl: "https://www.airbaltic.com/en/flight-deals/flights-from-riga-to-tel-aviv" };
  const pages = [originPage, rigaPage];
  return createPublishedSource({ source: "air_baltic", airline: "BT", routes: { "TLV:RIX": pages, "RIX:TLV": pages }, originPages: [originPage] }, now, fetchFn, sharedCache);
}
