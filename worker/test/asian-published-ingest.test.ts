import {expect,it,vi} from 'vitest';
import {ingestPublicFares} from '../src/external-fare-ingest';
import {parsePublishedFares} from '../src/sources/published-fares';
import type {Env} from '../src/types';

const now=new Date('2026-10-08T12:00:00Z'),key='a'.repeat(64);
const configurations=[
 {airline:'BR',origin:'TPE',destination:'NRT',sourceUrl:'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo',travelClass:'Economy Basic',currencyCode:'TWD',totalPrice:17532},
 {airline:'VN',origin:'LHR',destination:'HAN',sourceUrl:'https://www.vietnamairlines.com/en-gb/flights-from-london-to-hanoi',travelClass:'Economy Super Lite',currencyCode:'GBP',totalPrice:647.19},
];
it.each(configurations)('ingests strict $airline native cash advertisements with original capture and reported singular age',async config=>{
 const row={__typename:'Fare',originAirportCode:config.origin,destinationAirportCode:config.destination,departureDate:'2027-06-13',returnDate:'2027-06-17',flightType:'ROUND_TRIP',travelClass:config.travelClass,farenetTravelClass:'ECONOMY',formattedTravelClass:'Economy',totalPrice:config.totalPrice,currencyCode:config.currencyCode,priceLastSeen:{value:'1',unit:'day'}};
 const write=vi.fn().mockResolvedValue(undefined),env={LOCAL_COLLECTOR_KEY:key,PUBLIC_FARES:{getByName:()=>({write})}} as unknown as Env;
 const body={source:'published_page',airline:config.airline,page:config.sourceUrl,checkedAt:now.toISOString(),records:[row,row,{...row,travelClass:'BUSINESS'},{...row,farenetTravelClass:undefined},{...row,promoCode:'PAID_MEMBER'}]};
 const request=new Request('https://example.test/api/internal/public-fares',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 expect((await ingestPublicFares(request,env,now)).status).toBe(200);
 expect(JSON.parse(write.mock.calls[0]![1])).toMatchObject({storedAt:now.getTime(),expires:now.getTime()+600000,fares:[{amount:config.totalPrice,currency:config.currencyCode,upstreamPriceAge:{value:1,unit:'days'}}]});
 expect(JSON.parse(write.mock.calls[0]![1]).fares).toHaveLength(1);
 expect(parsePublishedFares(`<script id="__NEXT_DATA__">${JSON.stringify([{...row,formattedTravelClass:'Business'}])}</script>`,{...config,now})).toEqual([]);
});
it('accepts either independently provisioned collector credential and rejects other values before body consumption',async()=>{
 const env={COLLECTOR_KEY:key,LOCAL_COLLECTOR_KEY:'b'.repeat(64),PUBLIC_FARES:{}} as Env;
 for(const value of [key,'b'.repeat(64)]){
  const request=new Request('https://example.test',{method:'POST',headers:{Authorization:`Bearer ${value}`,'Content-Type':'application/json'},body:'{}'});
  expect((await ingestPublicFares(request,env,now)).status).toBe(400);
 }
 const request=new Request('https://example.test',{method:'POST',headers:{Authorization:`Bearer ${'c'.repeat(64)}`},body:'{}'});
 expect((await ingestPublicFares(request,env,now)).status).toBe(401);expect(request.bodyUsed).toBe(false);
});
