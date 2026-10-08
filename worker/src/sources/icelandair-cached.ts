import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { ICELANDAIR_PAGE } from "../icelandair-rendered";
import { matchPublishedTrip } from "./published-source";
/** Search reads collected prices; it never launches a browser or calls the airline. */
export function createIcelandairCachedSource(cache?: PublicFareCache): FareQuoteSource {
  return {name:"icelandair",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(!["LHR","LGW"].includes(q.origin)||q.destination!=="KEF"||q.party.adults!==1||q.party.children||q.party.infants)return [];
      const stored=await cache?.get<PublishedFare>(ICELANDAIR_PAGE);
      return matchPublishedTrip(stored?.fares??[],q,{airline:"FI",source:"icelandair"});
    }
  };
}
