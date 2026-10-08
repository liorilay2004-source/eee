import {expect,it} from "vitest";
import {parseNorwegianCalendar} from "../src/norwegian-calendar";
const now=new Date("2026-10-08T00:00:00Z");
const query={origin:"ATH",destination:"OSL",month:"2027-06"};
const row={date:"2027-06-05T00:00:00",price:56.44,isSoldOut:false,isAgreementPrice:false,isInterliningRoute:false,transitCount:0};
it("preserves actual cents, direction and transit count",()=>{
 expect(parseNorwegianCalendar({currencyCode:"EUR",outbound:{days:[row]},inbound:{days:[{...row,transitCount:1}]}},query,now)).toMatchObject([{origin:"ATH",destination:"OSL",amount:56.44,stops:0},{origin:"OSL",destination:"ATH",amount:56.44,stops:1}]);
});
it("rejects unavailable, special, invalid and out-of-month records",()=>{
 const invalid=[{price:0},{isSoldOut:true},{isAgreementPrice:true},{isInterliningRoute:true},{transitCount:null},{date:"2027-06-31T00:00:00"},{date:"2027-07-05T00:00:00"}];
 expect(parseNorwegianCalendar({currencyCode:"EUR",outbound:{days:invalid.map(change=>({...row,...change}))}},query,now)).toEqual([]);
 expect(parseNorwegianCalendar({currencyCode:"NOK",outbound:{days:[row]}},query,now)).toEqual([]);
});
