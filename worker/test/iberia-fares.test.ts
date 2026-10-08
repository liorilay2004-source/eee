import {describe,it,expect} from "vitest";
import {parseIberiaFares} from "../src/iberia-fares";
const now=new Date("2026-10-08");
const card=(amount="239",depart="2026-10-31",ret="2026-11-11")=>`<article><span class="iata" style="display:none">MAD</span><span class="iata">TLV</span><p class="cards-block-column--article__content-dates"><span class="cards-block-column--article__content-dates--start">${depart}</span> - <span class="cards-block-column--article__content-dates--end">${ret}</span></p><p class="cards-block-column--article__content-description">Return flights from</p><p class="cards-block-column--article__content-price link-arrow">${amount} € </p></article>`;
describe("Iberia complete dated public cards",()=>{
 it("preserves exact dates and amount from the observed card",()=>{
 expect(parseIberiaFares(card(),now)).toMatchObject([{origin:"MAD",destination:"TLV",departDate:"2026-10-31",returnDate:"2026-11-11",amount:239,currency:"EUR"}]);
 });
 it("ignores headings, scripts, invalid/expired dates, one way cards and other routes",()=>{
 expect(parseIberiaFares('<h1>Flights from 99 €</h1><script>'+card()+'</script>',now)).toEqual([]);
 for(const html of [card("239","2026-09-01","2026-09-11"),card("239","2026-10-31","2026-10-31"),card("239","2027-02-30","2027-03-03"),card().replace('>MAD<','>LHR<'),card().replace('Return flights from','One way flights from'),card().replace('€','USD')])expect(parseIberiaFares(html,now)).toEqual([]);
 });
 it("does not mix dates and price from different incomplete cards",()=>{
 expect(parseIberiaFares(card().replace('239 €','')+card().replace('2026-10-31',''),now)).toEqual([]);
 expect(parseIberiaFares(card("239,50"),now)[0]?.amount).toBe(239.5);
 });
});
