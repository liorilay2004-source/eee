import {expect,it} from "vitest";
import {parseNorwegianCalendar,parseNorwegianCalendarHtml} from "../src/norwegian-calendar";
const now=new Date("2026-10-08T00:00:00Z");
const query={origin:"ATH",destination:"OSL",month:"2027-06"};
const row={date:"2027-06-05T00:00:00",price:56.44,isSoldOut:false,isAgreementPrice:false,isInterliningRoute:false,transitCount:0};
it("binds rendered dates and amounts within each direction and excludes transit",()=>{
 const metadata='D_City=ATH&amp;A_City=OSL&amp;D_Month=202706&amp;R_Month=202706&amp;AdultCount=1&amp;CurrencyCode=EUR';
 const button='<button><span aria-label="Jun 5, 2027">5.</span><strong aria-label="Fare is 56.44">56.44</strong></button>';
 const html=metadata+'<h2>Outbound</h2>from Athens (ATH)<table class="lowfare-calendar__table">'+button+'</table><h2>Return</h2>from Oslo-Gardermoen (OSL)<table class="lowfare-calendar__table">'+button.replace('5,','9,')+'</table>';
 expect(parseNorwegianCalendarHtml(html,"2027-06",now)).toMatchObject([{origin:"ATH",date:"2027-06-05",amount:56.44},{origin:"OSL",date:"2027-06-09",amount:56.44}]);
 expect(parseNorwegianCalendarHtml(html.replaceAll('<strong','<span aria-label="Is transit"></span><strong'),"2027-06",now)).toEqual([]);
 expect(parseNorwegianCalendarHtml(html,"2027-07",now)).toEqual([]);
 expect(parseNorwegianCalendarHtml(html.replace('Fare is 56.44','Fare is 56.44" data-extra="x"><span aria-label="Fare is 90'),"2027-06",now)).toHaveLength(1);
});
it("preserves actual cents, direction and transit count",()=>{
 expect(parseNorwegianCalendar({currencyCode:"EUR",outbound:{days:[row]},inbound:{days:[{...row,transitCount:1}]}},query,now)).toMatchObject([{origin:"ATH",destination:"OSL",amount:56.44,stops:0},{origin:"OSL",destination:"ATH",amount:56.44,stops:1}]);
});
it("rejects unavailable, special, invalid and out-of-month records",()=>{
 const invalid=[{price:0},{isSoldOut:true},{isAgreementPrice:true},{isInterliningRoute:true},{transitCount:null},{date:"2027-06-31T00:00:00"},{date:"2027-07-05T00:00:00"}];
 expect(parseNorwegianCalendar({currencyCode:"EUR",outbound:{days:invalid.map(change=>({...row,...change}))}},query,now)).toEqual([]);
 expect(parseNorwegianCalendar({currencyCode:"NOK",outbound:{days:[row]}},query,now)).toEqual([]);
});
