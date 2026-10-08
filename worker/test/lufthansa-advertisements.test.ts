import {it,expect} from "vitest";
import {parseLufthansaAdvertisements} from "../src/lufthansa-advertisements";
const now=new Date("2026-10-08T03:50:00Z");
const url="/aircore/deeplink/redirect/en/gr/ATH/TLV/05.06.2027/19.06.2027/RT";
it("preserves Lufthansa's observed June date pair and seller link",()=>{
 expect(parseLufthansaAdvertisements([{text:"from 304 € Jun. 5 Jun.",url}],now)).toMatchObject([
 {origin:"ATH",destination:"TLV",departDate:"2027-06-05",returnDate:"2027-06-19",amount:304,currency:"EUR",carrier:null,bookingUrl:`https://www.lufthansa.com${url}`}]);
});
it.each([url.replace("/ATH/TLV/","/TLV/ATH/"),url.replace("/en/gr/","/en/be/"),`https://www.brusselsairlines.com${url}`,url+"?session=x"])("rejects unrelated route, market or seller %s",bad=>{
 expect(parseLufthansaAdvertisements([{text:"from 304 €",url:bad}],now)).toEqual([]);
});
it("drops inconsistent calendar and last-minute prices for the same pair",()=>{
 expect(parseLufthansaAdvertisements([{text:"from 411 €",url},{text:"from 436 €",url}],now)).toEqual([]);
});
