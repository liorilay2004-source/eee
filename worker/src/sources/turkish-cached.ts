import {readTurkishFares} from "../turkish-cache";
import type {PublicFareCache} from "../public-fare-cache";
import type {FareQuoteSource} from "../quotes";
import type {Offer,Leg} from "../types";
/** Only observed exact round trips for one adult. No inference of operating carriers or bag allowance. */
export function createTurkishCachedSource(now:Date,cache?:PublicFareCache):FareQuoteSource {
 let pending:ReturnType<typeof readTurkishFares>|undefined;
 return {name:"turkish",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
  async quote(q):Promise<Offer[]> {
   if(q.origin!=="IST"||q.destination!=="ATH"||q.party.adults!==1||q.party.children||q.party.infants||q.adults!==undefined&&q.adults!==1)return [];
   const leg=():Leg=>({departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]});
   return (await (pending??=readTurkishFares(cache,now))).filter(f=>f.departDate===q.departDate&&f.returnDate===q.returnDate).map(f=>({origin:f.origin,destination:f.destination,departDate:f.departDate,returnDate:f.returnDate!,source:"turkish",priceAmount:f.amount,priceCurrency:f.currency,ticketStructure:"roundtrip",outbound:leg(),inbound:leg(),includes:{},deeplink:f.sourceUrl,verifyLink:null,checkedAt:f.checkedAt,extrasAmountIls:0,totalIls:null,tags:["published_advertisement"]}));
  }};
}
