import type {PublicFareCache} from "../public-fare-cache";
import type {FareQuoteSource} from "../quotes";
import type {PublishedFare} from "./published-fares";
import {matchPublishedTrip} from "./published-source";
import {singaporeCacheKey} from "./singapore-fares";
/** Only authenticated external snapshots; user searches never fetch this airline. */
export function createSingaporeCachedSource(cache?:PublicFareCache):FareQuoteSource{
 return {name:"singapore",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
 async quote(q){if(q.origin!=="SIN"||!["HND","NRT"].includes(q.destination)||q.party.adults!==1||q.party.children||q.party.infants)return [];const duration=(Date.parse(q.returnDate)-Date.parse(q.departDate))/86400000+1;if(duration!==7&&duration!==14)return [];const stored=await cache?.get<PublishedFare>(singaporeCacheKey(duration));return matchPublishedTrip(stored?.fares??[],q,{airline:"SQ",source:"singapore"});}};
}
