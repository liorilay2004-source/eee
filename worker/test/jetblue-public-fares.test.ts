import {createJetBluePublishedSource} from "../src/sources/jetblue-published";
import {expect,it} from "vitest";
import {parsePublishedFares} from "../src/sources/published-fares";
it("parses observed JetBlue airport/date fares without using an undated headline",()=>{
 const page="https://www.jetblue.com/en/flights-from-new-york";
 const row={__typename:"Fare",originAirportCode:"JFK",destinationAirportCode:"MCO",travelClass:"ECONOMY",departureDate:"2026-11-17",totalPrice:70,currencyCode:"USD",flightType:"ONE_WAY",returnDate:"",redemption:null};
 const html=`<script id="__NEXT_DATA__">${JSON.stringify({fares:[row,{...row,originAirportCode:"LGA"},{__typename:"Fare",totalPrice:70,currencyCode:"USD"}]})}</script>`;
 const fares=parsePublishedFares(html,{airline:"B6",origin:"JFK",origins:["JFK","LGA"],destination:"MCO",sourceUrl:page,allDestinations:true,now:new Date("2026-10-08T00:00:00Z")});
 expect(fares).toHaveLength(2);expect(fares[0]).toMatchObject({airline:"B6",amount:70,structure:"oneway",returnDate:null});
});

it("accepts JetBlue DN only with the observed explicit economy and Main metadata",()=>{
 const row={__typename:"Fare",originAirportCode:"JFK",destinationAirportCode:"STI",travelClass:"DN",farenetTravelClass:"ECONOMY",formattedTravelClass:"Main",departureDate:"2026-12-02",totalPrice:131,currencyCode:"USD",flightType:"ONE_WAY",returnDate:"",redemption:null,promoCode:""};
 const html=`<script id="__NEXT_DATA__">${JSON.stringify({fares:[row,{...row,farenetTravelClass:null},{...row,farenetTravelClass:"BUSINESS"},{...row,promoCode:"PRIVATE"}]})}</script>`;
 const fares=parsePublishedFares(html,{airline:"B6",origin:"JFK",destination:"STI",sourceUrl:"https://www.jetblue.com/en/flights-from-new-york",now:new Date("2026-10-08T00:00:00Z")});
 expect(fares).toHaveLength(1);expect(fares[0]).toMatchObject({amount:131,structure:"oneway"});
});

it("reads shared JetBlue one-way fares without inventing a round trip or group price",async()=>{
 const now=new Date("2026-10-08T00:00:00Z"),url="https://www.jetblue.com/en/flights-from-new-york";
 const row={airline:"B6",origin:"JFK",destination:"MCO",departDate:"2026-11-17",returnDate:null,amount:70,currency:"USD",structure:"oneway",sourceUrl:url,checkedAt:now.toISOString(),pricing:"published_advertisement"};
 const source=createJetBluePublishedSource(now,(async()=>{throw new Error("must use shared snapshot");}) as typeof fetch,{get:async<T>()=>({fares:[row] as T[],expires:now.getTime()+600000}),put:async()=>{}});
 const q={origin:"JFK",destination:"MCO",departDate:row.departDate,returnDate:"2026-11-21",party:{adults:1,children:0,infants:0}};
 expect(await source.oneWays!(q)).toMatchObject([{source:"jetblue",amount:70}]);expect(await source.quote(q)).toEqual([]);expect(source.callCount()).toBe(0);
 expect(await source.oneWays!({...q,party:{adults:2,children:0,infants:0}})).toEqual([]);
});
