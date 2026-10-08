import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { AVIANCA_PAGE } from "../avianca-card";
/** User searches never launch a browser. Background data and D1 supply prices. */
export function createAviancaCachedSource(cache?: PublicFareCache): FareQuoteSource {
  return { name:"avianca",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(q.origin!=="MIA" || q.party.adults!==1 || q.party.children || q.party.infants) return [];
      const stored=await cache?.get<PublishedFare>(AVIANCA_PAGE);
      return matchPublishedTrip(stored?.fares ?? [],q,{airline:"AV",source:"avianca"});
    }
  };
}
