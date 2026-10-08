import type {AegeanCalendarTrip,AegeanCalendarFare} from "../aegean-lowfare";
import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource } from "./published-source";
import {readAegeanCalendar} from "../aegean-calendar-cache";
import type {Leg,Offer} from "../types";
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
export function createAegeanPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache,db?:D1Database,onDemand?:(trip:AegeanCalendarTrip)=>Promise<AegeanCalendarFare|null>) {
  const base=createPublishedSource({ source: "aegean", airline: "A3", routes: { "TLV:ATH": pages, "ATH:TLV": pages, "ATH:FCO": romePages, "FCO:ATH": romePages } }, now, fetchFn, sharedCache);
  let coordinationCalls=0;
  return {...base,callCount:()=>base.callCount()+coordinationCalls,nextQuoteRequests:(q:Parameters<typeof base.quote>[0])=>(base.nextQuoteRequests?.(q)??0)+(onDemand?1:0),async quote(q:Parameters<typeof base.quote>[0]):Promise<Offer[]> {
    if(q.party.adults===1&&!q.party.children&&!q.party.infants&&(q.adults===undefined||q.adults===1)) {
      let fare=await readAegeanCalendar(sharedCache,q,now,db);
      if(!fare&&onDemand){coordinationCalls++;try{fare=await onDemand(q);}catch{fare=null;}}
      if(fare){const leg=():Leg=>({departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]});
        return [{origin:fare.origin,destination:fare.destination,departDate:fare.departDate,returnDate:fare.returnDate,source:"aegean",priceAmount:fare.amount,priceCurrency:"EUR",ticketStructure:"roundtrip",outbound:leg(),inbound:leg(),includes:{},deeplink:fare.bookingUrl,verifyLink:null,checkedAt:fare.checkedAt,extrasAmountIls:0,totalIls:null,tags:["published_advertisement"]}];
      }
    }
    return base.quote(q);
  }};
}
