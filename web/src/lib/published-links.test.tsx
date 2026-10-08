import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {BookingActions} from "../components/OfferCards";
import FLYDUBAI_PAGES from '../../../worker/src/flydubai-published-catalog.json';
import EVA_PAGES from '../../../worker/src/eva-published-catalog.json';
import VIETNAM_PAGES from '../../../worker/src/vietnam-published-catalog.json';
import ROYAL_AIR_MAROC_PAGES from '../../../worker/src/royal-air-maroc-published-catalog.json';
import CHINA_AIRLINES_PAGES from '../../../worker/src/china-airlines-published-catalog.json';
import KOREAN_PAGES from '../../../worker/src/korean-published-catalog.json';
it('retains only approved flydubai, EVA and Vietnam official links',()=>{
 for(const [source,pages] of [['flydubai',FLYDUBAI_PAGES],['eva',EVA_PAGES],['vietnam',VIETNAM_PAGES]] as const){
  const page=pages[0]!;
  const offer={source,deeplink:page.sourceUrl,ticketStructure:'roundtrip',origin:page.origin,destination:page.destination,departDate:'2027-06-13',returnDate:'2027-06-17',outbound:{airlines:[]},inbound:{airlines:[]}};
  expect(renderToStaticMarkup(<BookingActions card={{offer} as any}/>)).toContain(`href="${page.sourceUrl}"`);
  expect(renderToStaticMarkup(<BookingActions card={{offer:{...offer,deeplink:new URL('/account',page.sourceUrl).href}} as any}/>)).not.toContain('href=');
 }
});
it('labels three new official publishers and rejects unobserved pages, credentials and altered URLs',()=>{
 for(const [source,label,pages] of [['royal_air_maroc','Royal Air Maroc',ROYAL_AIR_MAROC_PAGES],['china_airlines','China Airlines',CHINA_AIRLINES_PAGES],['korean_air','Korean Air',KOREAN_PAGES]] as const){
  const page=pages[0]!;
  const offer={source,deeplink:page.sourceUrl,ticketStructure:'roundtrip',origin:page.origin,destination:page.destination,departDate:'2027-06-04',returnDate:'2027-06-11',outbound:{airlines:[]},inbound:{airlines:[]}};
  const html=renderToStaticMarkup(<BookingActions card={{offer} as any}/>);
  expect(html).toContain(`href="${page.sourceUrl}"`);expect(html).toContain(label);expect(html).toContain('למחיר שפורסם');expect(html).toContain('הקישור אינו הזמנה שמורה');
  for(const deeplink of [page.sourceUrl+'?tracking=1',page.sourceUrl+'#top',page.sourceUrl.replace('https://','https://user:pass@'),new URL('/en/flights-from-unobserved-to-unobserved',page.sourceUrl).href,page.sourceUrl.replace(new URL(page.sourceUrl).host,'unrelated.example')]){
   expect(renderToStaticMarkup(<BookingActions card={{offer:{...offer,deeplink}} as any}/>)).not.toContain('href=');
  }
 }
});
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

it("keeps the observed Kenya Airways official price page",()=>{
 const url="https://www.kenya-airways.com/en_gb/flights-from-london-to-nairobi/";
 const card={offer:{source:"kenya",deeplink:url,ticketStructure:"roundtrip",origin:"LHR",destination:"NBO",departDate:"2026-11-27",returnDate:"2026-12-04"}} as any;
 expect(renderToStaticMarkup(<BookingActions card={card}/>)).toContain(`href="${url}"`);
});
