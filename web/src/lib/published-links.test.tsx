import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {BookingActions} from "../components/OfferCards";
it("keeps verified new airline route-page links in booking actions",()=>{
 for(const [source,url] of [["virgin_atlantic","https://flights.virginatlantic.com/en-il/flights-from-tel-aviv-to-seattle"],["copa","https://www.copaair.com/en/flights-from-panama-city-to-miami"],["jetblue","https://www.jetblue.com/en/flights-from-new-york"]]){
  const card={offer:{source,deeplink:url,returnDeeplink:null,ticketStructure:"roundtrip",origin:"TLV",destination:"SEA",departDate:"2027-06-20",returnDate:"2027-06-29"}} as any;
  expect(renderToStaticMarkup(<BookingActions card={card}/>)).toContain(`href="${url}"`);
 }
});
