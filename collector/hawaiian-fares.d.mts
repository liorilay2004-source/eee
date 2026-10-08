export interface HawaiianAdvertisement {
 origin:string; destination:string; departDate:string; returnDate:string|null;
 amount:number; currency:string; structure:'oneway'|'roundtrip'; sourceUrl:string;
 fetchedAt:string; upstreamPriceAge:{value:number;unit:'minutes'|'hours'|'days'}|null;
 operator:null; checkoutVerified:false; pricing:'published_advertisement';
}
export function hawaiianFares(observation:{page:string;fetchedAt:string;records:unknown[];error?:string}):HawaiianAdvertisement[];
