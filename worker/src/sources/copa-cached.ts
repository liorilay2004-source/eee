import type { PublicFareCache } from "../public-fare-cache";
import type { FareQuoteSource, QuoteQuery } from "../quotes";
import type { PublishedFare } from "./published-fares";
import { matchPublishedTrip } from "./published-source";
import { EXTERNAL_PUBLISHED_PAGES } from "../external-published-catalog";
import { COPA_PAGE } from "../copa-rendered";
/** User searches never launch a browser. Background data and D1 supply prices. */
export function createCopaCachedSource(cache?: PublicFareCache): FareQuoteSource {
  async function fares(q: QuoteQuery): Promise<PublishedFare[]> {
    if(q.party.adults!==1 || q.party.children || q.party.infants) return [];
    const pages=EXTERNAL_PUBLISHED_PAGES.filter(p=>p.airline==="CM"&&!p.allDestinations&&(p.origin===q.origin&&p.destination===q.destination||p.origin===q.destination&&p.destination===q.origin)).map(p=>p.sourceUrl);
    if(q.origin==="PTY") pages.push(COPA_PAGE);
    const values=await Promise.allSettled([...new Set(pages)].map(url=>cache?.get<PublishedFare>(url)));
    return [...new Map(values.flatMap(v=>v.status==="fulfilled"?v.value?.fares??[]:[]).map(f=>[JSON.stringify(f),f])).values()];
  }
  return { name:"copa",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      return matchPublishedTrip(await fares(q),q,{airline:"CM",source:"copa"});
    }
  };
}
