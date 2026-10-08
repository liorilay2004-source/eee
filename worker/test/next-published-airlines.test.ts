import {describe,expect,it} from 'vitest';
import {parsePublishedFares,publishedFareUrl} from '../src/sources/published-fares';
const now=new Date('2026-10-08T12:28:13.221Z');
const examples=[
 {airline:'AT',origin:'CMN',destination:'BCN',sourceUrl:'https://www.royalairmaroc.com/fr/vols-au-depart-de-casablanca',depart:'2026-12-05',back:'2026-12-07',amount:159.8,currency:'EUR',raw:'eco',formatted:'Économique'},
 {airline:'CI',origin:'TPE',destination:'NRT',sourceUrl:'https://flights.china-airlines.com/en-tw/flights-from-taipei-to-tokyo',depart:'2027-06-04',back:'2027-06-11',amount:16274,currency:'TWD',raw:'經濟艙 基本',formatted:'Economy'},
 {airline:'KE',origin:'LAX',destination:'ICN',sourceUrl:'https://www.koreanair.com/flights/en-us/flights-from-los-angeles-to-seoul',depart:'2027-08-17',back:'2027-08-24',amount:1865.19,currency:'USD',raw:'Y',formatted:'Economy Class'},
];
const html=(fares:unknown[])=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{fares}}})}</script>`;
describe.each(examples)('$airline observed public cash economy signature',example=>{
 const query={airline:example.airline,origin:example.origin,destination:example.destination,sourceUrl:example.sourceUrl,now};
 const fare={__typename:'Fare',originAirportCode:example.origin,destinationAirportCode:example.destination,
  departureDate:example.depart,returnDate:example.back,totalPrice:example.amount,currencyCode:example.currency,flightType:'ROUND_TRIP',
  travelClass:example.raw,farenetTravelClass:'ECONOMY',formattedTravelClass:example.formatted,promoCode:'',redemption:null,
  priceLastSeen:{value:'1',unit:'day'},usdTotalPrice:1};
 it('preserves actual native amount, airports, dates, original capture and normalized upstream age',()=>{
  expect(parsePublishedFares(html([fare,fare]),query)).toEqual([{airline:example.airline,origin:example.origin,destination:example.destination,
   departDate:example.depart,returnDate:example.back,amount:example.amount,currency:example.currency,structure:'roundtrip',
   sourceUrl:example.sourceUrl,checkedAt:now.toISOString(),pricing:'published_advertisement',upstreamPriceAge:{value:1,unit:'days'}}]);
 });
 it('rejects wrong, unknown, empty or inconsistent cabins and noncash/promotion records',()=>{
  const bad=[{travelClass:'BUSINESS'},{travelClass:'ECONOMY'},{travelClass:''},{travelClass:null},{travelClass:undefined},
   {farenetTravelClass:'BUSINESS'},{farenetTravelClass:null},{farenetTravelClass:undefined},
   {formattedTravelClass:'Business'},{formattedTravelClass:''},{formattedTravelClass:undefined},
   {redemption:{unit:'MILES'}},{redemption:undefined},{promoCode:'MEMBER'},{promoCode:undefined},{totalPrice:1e9+1}];
  for(const patch of bad)expect(parsePublishedFares(html([{...fare,...patch}]),query),JSON.stringify(patch)).toEqual([]);
 });
 it('rejects missing returns, invalid dates, foreign airports, malformed prices and undated headline minima',()=>{
  for(const patch of [{returnDate:null},{returnDate:fare.departureDate},{departureDate:'2027-02-30'},{departureDate:'2025-01-01'},
   {originAirportCode:'TYO'},{destinationAirportCode:'TYO'},{totalPrice:null},{totalPrice:0},{currencyCode:'USD?'},{flightType:'UNKNOWN'}]){
   expect(parsePublishedFares(html([{...fare,...patch}]),query)).toEqual([]);
  }
  expect(parsePublishedFares(html([{__typename:'Fare',totalPrice:1,currencyCode:example.currency}, {month:'2027-06',minimum:1}]),query)).toEqual([]);
  expect(()=>publishedFareUrl(example.sourceUrl.replace('https://','https://user:password@'),example.airline)).toThrow();
  expect(()=>publishedFareUrl(example.sourceUrl.replace(new URL(example.sourceUrl).hostname,'wrong.example'),example.airline)).toThrow();
 });
});

it('keeps China Airlines Taipei city fares attached to their actual TSA–HND airport identity',()=>{
 const fare={__typename:'Fare',originAirportCode:'TSA',destinationAirportCode:'HND',departureDate:'2027-06-05',returnDate:'2027-06-10',
  totalPrice:17047,currencyCode:'TWD',flightType:'ROUND_TRIP',travelClass:'經濟艙 基本',farenetTravelClass:'ECONOMY',
  formattedTravelClass:'Economy',promoCode:'',redemption:null,priceLastSeen:{value:'6',unit:'hours'}};
 const query={airline:'CI',origin:'TSA',destination:'HND',sourceUrl:examples[1]!.sourceUrl,now};
 expect(parsePublishedFares(html([fare]),query)).toMatchObject([{origin:'TSA',destination:'HND',amount:17047,upstreamPriceAge:{value:6,unit:'hours'}}]);
 expect(parsePublishedFares(html([fare]),{...query,origin:'TPE',destination:'NRT'})).toEqual([]);
});
