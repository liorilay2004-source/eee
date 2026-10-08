import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { FINNAIR_PAGE } from "../finnair-fares";
import { readFinnairSnapshot } from "../finnair-snapshots";
/** Synthetic per-destination cache keys are never fetched from the airline. */
export const finnairCacheKey=(destination:string,part:number)=>`${FINNAIR_PAGE}?destination=${destination}&part=${part}`;
export function createFinnairCachedSource(cache?:PublicFareCache,db?:D1Database,now=new Date()):FareQuoteSource {
 const pending=new Map<string,Promise<PublishedFare[]>>();
 return {name:"finnair",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,async quote(q){
 if(q.origin!=="HEL"||q.party.adults!==1||q.party.children||q.party.infants)return [];
 const fares:PublishedFare[]=[];
 for(let part=0;part<40;part++){const stored=await cache?.get<PublishedFare>(finnairCacheKey(q.destination,part));if(!stored)break;fares.push(...stored.fares);}
 const hot=matchPublishedTrip(fares,q,{airline:"AY",source:"finnair"});if(hot.length)return hot;
 if(db){const key=`${q.destination}|${q.departDate.slice(0,7)}`;if(!pending.has(key))pending.set(key,readFinnairSnapshot(db,q.destination,q.departDate.slice(0,7),now).catch(()=>[]));const stored=await pending.get(key)!;if(stored.length)return matchPublishedTrip(stored,q,{airline:"AY",source:"finnair"});}
 return matchPublishedTrip(fares,q,{airline:"AY",source:"finnair"});
 }};
}
