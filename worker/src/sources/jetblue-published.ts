import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
const forward={origin:"JFK",origins:["JFK","LGA"],destination:"MCO",sourceUrl:"https://www.jetblue.com/en/flights-from-new-york",allDestinations:true};
const reverse={origin:"MCO",destination:"JFK",sourceUrl:"https://www.jetblue.com/en/flights-from-orlando-to-new-york"};
export function createJetBluePublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  return createPublishedSource({source:"jetblue",airline:"B6",routes:{"JFK:MCO":[forward,reverse],"MCO:JFK":[forward,reverse]},originPages:[forward,{...forward,origin:"LGA"},reverse]},now,fetchFn,sharedCache);
}
