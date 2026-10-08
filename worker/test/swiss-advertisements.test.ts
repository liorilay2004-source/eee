import {it,expect} from "vitest";
import {parseSwissAdvertisements} from "../src/swiss-advertisements";
const now=new Date("2026-10-08T04:10:00Z");
const url="/aircore/deeplink/redirect/en/ch/ZRH/TLV/01.06.2027/15.06.2027/RT";
it.each(["from 358 CHF Jun. 1 Jun.","Cheapest flight - June from CHF 358 View offer"])("preserves Swiss francs in observed label %s",text=>{
 expect(parseSwissAdvertisements([{text,url}],now)).toMatchObject([{origin:"ZRH",destination:"TLV",departDate:"2027-06-01",returnDate:"2027-06-15",amount:358,currency:"CHF",carrier:null,bookingUrl:`https://www.swiss.com${url}`}]);
});
it.each(["from 358 EUR","from 358 €","from 358.50 CHF","from CHF 358.50","from CHF 1.358","from CHF 1,358","from 1.358 CHF","from 1,358 CHF","from 358 CHF from CHF 400"])("rejects ambiguous or unsupported price text %s",text=>{
 expect(parseSwissAdvertisements([{text,url}],now)).toEqual([]);
});
it.each([url.replace("/ZRH/TLV/","/TLV/ZRH/"),url.replace("/en/ch/","/en/gr/"),`https://www.lufthansa.com${url}`])("rejects unrelated routes or sellers %s",bad=>{
 expect(parseSwissAdvertisements([{text:"from 358 CHF",url:bad}],now)).toEqual([]);
});
it("rejects contradictory same-date price claims",()=>{
 expect(parseSwissAdvertisements([{text:"from 358 CHF",url},{text:"from CHF 359",url}],now)).toEqual([]);
});
