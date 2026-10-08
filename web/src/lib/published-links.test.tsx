import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {BookingActions} from "../components/OfferCards";
it('keeps the approved Hawaiian source link without implying an operating carrier',()=>{
 const url='https://asha.hawaiianairlines.com/en/flights-from-honolulu';
 const card={offer:{source:'hawaiian',deeplink:url,ticketStructure:'roundtrip',origin:'HNL',destination:'LAX',departDate:'2027-01-27',returnDate:'2027-02-03'}} as any;
 expect(renderToStaticMarkup(<BookingActions card={card}/>)).toContain(`href="${url}"`);
});
it("keeps verified new airline route-page links in booking actions",()=>{
 for(const [source,url] of [["frontier","https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix"],["singapore","https://www.singaporeair.com/sg/en/plan-travel/destinations/flights-from-singapore-to-tokyo/"],["virgin_atlantic","https://flights.virginatlantic.com/en-il/flights-from-tel-aviv-to-seattle"],["copa","https://www.copaair.com/en/flights-from-panama-city-to-miami"],["jetblue","https://www.jetblue.com/en/flights-from-new-york"]]){
  const card={offer:{source,deeplink:url,returnDeeplink:null,ticketStructure:"roundtrip",origin:"TLV",destination:"SEA",departDate:"2027-06-20",returnDate:"2027-06-29"}} as any;
  expect(renderToStaticMarkup(<BookingActions card={card}/>)).toContain(`href="${url}"`);
 }
});
it("keeps both observed Frontier links for independently booked tickets",()=>{
 const forward="https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix",reverse="https://flights.flyfrontier.com/en/flights-from-phoenix-to-denver";
 const card={offer:{source:"frontier",deeplink:forward,returnDeeplink:reverse,ticketStructure:"split",origin:"DEN",destination:"PHX",departDate:"2026-10-28",returnDate:"2026-10-31"}} as any;
 const html=renderToStaticMarkup(<BookingActions card={card}/>);expect(html).toContain(`href="${forward}"`);expect(html).toContain(`href="${reverse}"`);
});

it("retains the observed Air Astana official price page",()=>{
 const url="https://bestfares.airastana.com/en-kz/flights-from-almaty-to-london";
 const card={offer:{source:"air_astana",deeplink:url,ticketStructure:"roundtrip",origin:"ALA",destination:"LHR",departDate:"2026-12-04",returnDate:"2026-12-06"}} as any;
 expect(renderToStaticMarkup(<BookingActions card={card}/>)).toContain(`href="${url}"`);
});
