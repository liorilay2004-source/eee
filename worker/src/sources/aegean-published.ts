import {aegeanCalendarUrl,type AegeanCalendarTrip,type AegeanCalendarFare} from "../aegean-lowfare";
import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
import {readAegeanCalendar,validateAegeanCalendar} from "../aegean-calendar-cache";
import {olderOf,sourceUpdatedTimestamp} from "../freshness";
import type {Leg,Offer} from "../types";
import type {QuoteQuery} from "../quotes";
export { matchPublishedTrip } from "./published-source";
const pages = [
  { origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens" },
  { origin: "ATH", destination: "TLV", sourceUrl: "https://flights.aegeanair.com/he/flights-from-athens-to-tel-aviv" },
  { origin: "TLV", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/en/flights-from-tel-aviv-to-athens" },
  { origin: "ATH", destination: "TLV", sourceUrl: "https://flights.aegeanair.com/en/flights-from-athens-to-tel-aviv" },
];
const romePages = [
  { origin: "ATH", destination: "FCO", sourceUrl: "https://flights.aegeanair.com/en/flights-from-athens-to-rome" },
  { origin: "FCO", destination: "ATH", sourceUrl: "https://flights.aegeanair.com/en/flights-from-rome-to-athens" },
];
const singleAdult=(q:QuoteQuery)=>q.party.adults===1&&!q.party.children&&!q.party.infants&&(q.adults===undefined||q.adults===1);

/** A selected contextual round trip, with no inferred operating airline or flight details. */
function calendarOffer(fare:AegeanCalendarFare):Offer {
  const leg=():Leg=>({departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]});
  const sourceUpdatedAt=olderOf(sourceUpdatedTimestamp(fare.outboundUpdatedAt,fare.checkedAt),sourceUpdatedTimestamp(fare.inboundUpdatedAt,fare.checkedAt));
  return {origin:fare.origin,destination:fare.destination,departDate:fare.departDate,returnDate:fare.returnDate,source:"aegean",priceAmount:fare.amount,priceCurrency:"EUR",ticketStructure:"roundtrip",outbound:leg(),inbound:leg(),includes:{},deeplink:fare.bookingUrl,verifyLink:null,checkedAt:fare.checkedAt,fareFoundAt:null,...(sourceUpdatedAt?{sourceUpdatedAt}:{}),extrasAmountIls:0,totalIls:null,tags:["published_advertisement"]};
}

function selectedCalendarLink(link:string|null):boolean {
  if(!link)return false;
  try{const url=new URL(link);return url.hostname==="en.aegeanair.com"&&url.pathname==="/flight-deals/low-fare-calendar/";}catch{return false;}
}

export function createAegeanPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache,db?:D1Database,onDemand?:(trip:AegeanCalendarTrip)=>Promise<AegeanCalendarFare|null>,clock:()=>Date=()=>now) {
  const base=createPublishedSource({ source: "aegean", airline: "A3", routes: { "TLV:ATH": pages, "ATH:TLV": pages, "ATH:FCO": romePages, "FCO:ATH": romePages } }, now, fetchFn, sharedCache);
  let coordinationCalls=0;
  return {...base,callCount:()=>base.callCount()+coordinationCalls,nextQuoteRequests:(q:Parameters<typeof base.quote>[0])=>(base.nextQuoteRequests?.(q)??0)+(onDemand?1:0),
    async quoteCached(q:QuoteQuery):Promise<Offer[]> {
      if(!singleAdult(q))return [];
      const fare=await readAegeanCalendar(sharedCache,q,clock(),undefined);
      return fare?[calendarOffer(fare)]:[];
    },
    async validatesStoredOffer(offer:Offer):Promise<boolean> {
      // The marketing-page adapter's behavior remains unchanged. Only selected calendar observations need this cache.
      if(!selectedCalendarLink(offer.deeplink))return true;
      if(offer.source!=="aegean"||offer.ticketStructure!=="roundtrip")return false;
      let expectedLink:string;try{expectedLink=aegeanCalendarUrl(offer);}catch{return false;}
      if(offer.deeplink!==expectedLink)return false;
      const fare=await readAegeanCalendar(sharedCache,offer,clock(),undefined);
      return !!fare&&offer.priceAmount===fare.amount&&offer.priceCurrency===fare.currency&&offer.checkedAt===fare.checkedAt;
    },
    async quote(q:QuoteQuery):Promise<Offer[]> {
      if(singleAdult(q)) {
        let fare=await readAegeanCalendar(sharedCache,q,clock(),db);
        if(!fare&&onDemand){coordinationCalls++;try{const collected=await onDemand(q);fare=validateAegeanCalendar(collected,q,clock());}catch{fare=null;}}
        if(fare)return [calendarOffer(fare)];
      }
      return base.quote(q);
    }
  };
}
