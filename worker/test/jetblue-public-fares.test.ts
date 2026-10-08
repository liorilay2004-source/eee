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
