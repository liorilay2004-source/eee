import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export const GOL_ORIGINS = ["CGH", "GRU", "SAO"] as const;
export const GOL_PAGE = "https://www.voegol.com.br/en/flights-from-sao-paulo";
export function createGolPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({ source: "gol", airline: "G3", routes: {}, originPages:
    GOL_ORIGINS.map(origin => ({ origin, destination: "GIG", sourceUrl: GOL_PAGE, allDestinations: true, origins: GOL_ORIGINS })),
  }, now, fetchFn, sharedCache);
}
