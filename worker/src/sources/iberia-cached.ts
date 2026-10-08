import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { IBERIA_PAGE } from "../iberia-fares";
/** User searches never launch a browser. Background data and D1 supply prices. */
export function createIberiaCachedSource(cache?: PublicFareCache): FareQuoteSource {
  return { name:"iberia",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(q.origin!=="MAD" || q.party.adults!==1 || q.party.children || q.party.infants) return [];
      const stored=await cache?.get<PublishedFare>(IBERIA_PAGE);
      return matchPublishedTrip(stored?.fares ?? [],q,{airline:"IB",source:"iberia"});
    }
  };
}

