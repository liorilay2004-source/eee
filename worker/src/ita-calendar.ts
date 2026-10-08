/** ITA's public calendar is a seller quote; it can include Lufthansa Group partners. */
export interface ItaCalendarPrice {originCity:string;destinationCity:string;departDate:string;returnDate:string;amount:number;currency:"EUR";seller:"ITA Airways";carrier:null;pricing:"published_advertisement";checkedAt:string}
const date=(value:unknown):string|null=>{
 if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T00:00:00\.000\+00:00$/.test(value))return null;
 const day=value.slice(0,10);return Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day?day:null;
};
/** Exact return-day responses only; monthly minimums and departure-only arrays are not complete trips. */
export function parseItaReturnPrices(data:unknown,query:{originCity:string;destinationCity:string;departDate:string},now:Date):ItaCalendarPrice[]{
 if(!data||typeof data!=="object"||Array.isArray(data))return [];
 const body=data as Record<string,unknown>;
 if(query.originCity!=="ROM"||query.destinationCity!=="SAO"||body.originCityNameUrl!=="rome"||body.destinationCityNameUrl!=="sao+paulo"||body.countryCode!=="IT"||body.currency!=="EUR"||!Array.isArray(body.farePerReturnDates))return [];
 if(body.farePerReturnDates.length>400)throw new Error("Calendar response too large");
 const depart=date(`${query.departDate}T00:00:00.000+00:00`);if(!depart||depart<now.toISOString().slice(0,10))return [];
 const prices=new Map<string,ItaCalendarPrice>();
 for(const row of body.farePerReturnDates){
 if(!row||typeof row!=="object")continue;const v=row as Record<string,unknown>;const ret=date(v.returnDate);
 if(!ret||ret<=depart||typeof v.price!=="number"||!Number.isFinite(v.price)||v.price<=0)continue;
 const previous=prices.get(ret);if(previous&&previous.amount<=v.price)continue;
 prices.set(ret,{...query,returnDate:ret,amount:v.price,currency:"EUR",seller:"ITA Airways",carrier:null,pricing:"published_advertisement",checkedAt:now.toISOString()});
 }
 return [...prices.values()];
}
