import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
export function createJetBluePublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({source:"jetblue",airline:"B6",routes:{},originPages:["JFK","LGA"].map(origin=>({origin,origins:["JFK","LGA"],destination:"MCO",sourceUrl:"https://www.jetblue.com/en/flights-from-new-york",allDestinations:true}))},now,fetchFn,sharedCache);
}
