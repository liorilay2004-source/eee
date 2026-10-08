import {readLhgSnapshot} from "../lhg-snapshots";
import type { FareQuoteSource, QuoteQuery } from "../quotes";
import type { Offer, Leg } from "../types";
import type { PublicFareCache } from "../public-fare-cache";
import { BRUSSELS_ATHENS_PAGE } from "../brussels-rendered";
import { parseBrusselsAdvertisements, type BrusselsAdvertisement } from "../brussels-advertisements";

export function brusselsOffers(fares: readonly BrusselsAdvertisement[], q: QuoteQuery): Offer[] {
  if (q.origin !== "BRU" || q.destination !== "ATH" || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
  const leg = (): Leg => ({ departTime:null, arriveTime:null, durationMin:null, stops:null, airlines:[] });
  return fares.filter(f => f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate && f.returnDate === q.returnDate).map(f => ({
    origin:f.origin, destination:f.destination, departDate:f.departDate, returnDate:f.returnDate,
    source:"brussels_airlines", priceAmount:f.amount, priceCurrency:f.currency, ticketStructure:"roundtrip",
    outbound:leg(), inbound:leg(), includes:{}, deeplink:f.bookingUrl, verifyLink:null,
    checkedAt:f.checkedAt, extrasAmountIls:0, totalIls:null, tags:["published_advertisement"],
  }));
}
/** Collected public data only: zero browser, network or database calls during a search. */
export function createBrusselsCachedSource(now: Date, cache?: PublicFareCache, db?: D1Database): FareQuoteSource {
  const pending=new Map<string,Promise<BrusselsAdvertisement[]>>();
  return {name:"brussels_airlines",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(q.origin!=="BRU"||q.destination!=="ATH"||q.party.adults!==1||q.party.children||q.party.infants)return [];
      const stored = await cache?.get<BrusselsAdvertisement>(BRUSSELS_ATHENS_PAGE);
      const month=q.departDate.slice(0,7);
      if(!stored && db && !pending.has(month)) pending.set(month,readLhgSnapshot(db,"brussels_airlines",month,now).catch(()=>[]));
      const valid = (stored?.fares ?? (pending.has(month)?await pending.get(month)!:[])).filter(f => {
        if (!f || typeof f.amount !== "number" || !Number.isFinite(f.amount) || f.amount <= 0 || typeof f.checkedAt !== "string" || f.currency !== "EUR" || f.pricing !== "published_advertisement" || f.carrier !== null) return false;
        const age = now.getTime() - Date.parse(f.checkedAt);
        if (!Number.isFinite(age) || age < 0 || age > 36*3_600_000) return false;
        const parsed = parseBrusselsAdvertisements([{text:`from ${f.amount} EUR`,url:f.bookingUrl}],{origin:"BRU",destination:"ATH"},now);
        return parsed.length === 1 && parsed[0]!.departDate === f.departDate && parsed[0]!.returnDate === f.returnDate;
      });
      return brusselsOffers(valid,q);
    },
  };
}
