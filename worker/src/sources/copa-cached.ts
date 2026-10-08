import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { COPA_PAGE } from "../copa-rendered";
/** User searches never launch a browser. Background data and D1 supply prices. */
export function createCopaCachedSource(cache?: PublicFareCache): FareQuoteSource {
  return { name:"copa",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(q.origin!=="PTY" || q.party.adults!==1 || q.party.children || q.party.infants) return [];
      const stored=await cache?.get<PublishedFare>(COPA_PAGE);
      return matchPublishedTrip(stored?.fares ?? [],q,{airline:"CM",source:"copa"});
    }
  };
}
