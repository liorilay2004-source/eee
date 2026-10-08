import {it,expect} from "vitest";
import {parseAustrianAdvertisements} from "../src/austrian-advertisements";
const now=new Date("2026-10-08T04:20:00Z");
const url="/aircore/deeplink/redirect/en/at/VIE/TLV/05.06.2027/19.06.2027/RT";
it("preserves both observed trip dates and the original euro price",()=>{
 expect(parseAustrianAdvertisements([{text:"from 252 € Best price Jun. 5 Jun.",url}],now)).toMatchObject([{origin:"VIE",destination:"TLV",departDate:"2027-06-05",returnDate:"2027-06-19",amount:252,currency:"EUR",carrier:null}]);
});
it("excludes the observed conflicting September headline and calendar pair",()=>{
 const september="/aircore/deeplink/redirect/en/at/VIE/TLV/08.09.2027/22.09.2027/RT";
 expect(parseAustrianAdvertisements([{text:"Cheapest flight - September from 253 EUR View offer",url:september},{text:"from 252 € Best price Sep. 8 Sep.",url:september}],now)).toEqual([]);
});
it.each([url.replace("/VIE/TLV/","/TLV/VIE/"),url.replace("/en/at/","/en/ch/"),`https://www.swiss.com${url}`,`${url}?token=untrusted`])("rejects foreign route, market or link %s",bad=>{
 expect(parseAustrianAdvertisements([{text:"from 252 €",url:bad}],now)).toEqual([]);
});
