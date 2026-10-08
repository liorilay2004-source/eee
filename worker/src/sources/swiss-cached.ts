import {readLhgSnapshot} from "../lhg-snapshots";
import type { FareQuoteSource, QuoteQuery } from "../quotes";
import type { Offer, Leg } from "../types";
import type { PublicFareCache } from "../public-fare-cache";
import { SWISS_TEL_AVIV_PAGE } from "../swiss-rendered";
import type { LhgAdvertisement } from "../brussels-advertisements";
import { parseSwissAdvertisements } from "../swiss-advertisements";

export function swissOffers(fares: readonly LhgAdvertisement<"CHF">[], q: QuoteQuery): Offer[] {
  if (q.origin !== "ZRH" || q.destination !== "TLV" || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
  const leg = (): Leg => ({ departTime:null, arriveTime:null, durationMin:null, stops:null, airlines:[] });
  return fares.filter(f => f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate && f.returnDate === q.returnDate).map(f => ({
    origin:f.origin, destination:f.destination, departDate:f.departDate, returnDate:f.returnDate,
    source:"swiss", priceAmount:f.amount, priceCurrency:f.currency, ticketStructure:"roundtrip",
    outbound:leg(), inbound:leg(), includes:{}, deeplink:f.bookingUrl, verifyLink:null,
    checkedAt:f.checkedAt, extrasAmountIls:0, totalIls:null, tags:["published_advertisement"],
  }));
}
/** Collected public data only: zero airline network calls; optional memoized monthly storage read during a search. */
export function createSwissCachedSource(now: Date, cache?: PublicFareCache, db?: D1Database): FareQuoteSource {
  const pending=new Map<string,Promise<LhgAdvertisement<"CHF">[]>>();
  return {name:"swiss",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if(q.origin!=="ZRH"||q.destination!=="TLV"||q.party.adults!==1||q.party.children||q.party.infants)return [];
      const stored = await cache?.get<LhgAdvertisement<"CHF">>(SWISS_TEL_AVIV_PAGE);
      const month=q.departDate.slice(0,7);
      if(!stored && db && !pending.has(month)) pending.set(month,readLhgSnapshot(db,"swiss",month,now).catch(()=>[]));
      const valid = (stored?.fares ?? (pending.has(month)?await pending.get(month)!:[])).filter(f => {
        if (!f || typeof f.amount !== "number" || !Number.isFinite(f.amount) || f.amount <= 0 || typeof f.checkedAt !== "string" || f.currency !== "CHF" || f.pricing !== "published_advertisement" || f.carrier !== null) return false;
        const age = now.getTime() - Date.parse(f.checkedAt);
        if (!Number.isFinite(age) || age < 0 || age > 36*3_600_000) return false;
        const parsed = parseSwissAdvertisements([{text:`from ${f.amount} CHF`,url:f.bookingUrl}],now);
        return parsed.length === 1 && parsed[0]!.departDate === f.departDate && parsed[0]!.returnDate === f.returnDate;
      });
      return swissOffers(valid,q);
    },
  };
}
