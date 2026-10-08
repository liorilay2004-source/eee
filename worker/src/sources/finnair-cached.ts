import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { FINNAIR_PAGE } from "../finnair-fares";
/** Synthetic per-destination cache keys are never fetched from the airline. */
export const finnairCacheKey=(destination:string,part:number)=>`${FINNAIR_PAGE}?destination=${destination}&part=${part}`;
export function createFinnairCachedSource(cache?:PublicFareCache):FareQuoteSource {
 return {name:"finnair",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,async quote(q){
 if(q.origin!=="HEL"||q.party.adults!==1||q.party.children||q.party.infants)return [];
 const fares:PublishedFare[]=[];
 for(let part=0;part<40;part++){const stored=await cache?.get<PublishedFare>(finnairCacheKey(q.destination,part));if(!stored)break;fares.push(...stored.fares);}
 return matchPublishedTrip(fares,q,{airline:"AY",source:"finnair"});
 }};
}
