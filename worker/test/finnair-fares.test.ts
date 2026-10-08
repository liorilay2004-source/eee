import {describe,it,expect} from "vitest";
import {parseFinnairFares} from "../src/finnair-fares";
const now=new Date("2026-10-08T00:00:00Z");
const observed={currency:"EUR",from:"HEL",to:"SCL",fromDate:"2026-11-12",toDate:"2026-11-15",travelClassPrices:[{price:1207,travelClass:"Economy"}]};
const html=(fares:unknown[])=>`<script id="fcom-ux-state">${JSON.stringify({prices:fares})}</script>`;
describe("Finnair exact public round-trip prices",()=>{
 it("reads the observed economy record and deduplicates it",()=>{expect(parseFinnairFares(html([observed,observed]),now)).toMatchObject([{airline:"AY",origin:"HEL",destination:"SCL",departDate:"2026-11-12",returnDate:"2026-11-15",amount:1207,currency:"EUR"}]);});
 it("rejects bus stations, unknown dates, premium prices and unsupported origins",()=>{
  const invalid=[...['XTP','XTZ'].map(to=>({...observed,to})),{...observed,toDate:null},{...observed,toDate:'2026-11-31'},{...observed,fromDate:'2025-11-12'},{...observed,from:'ARN'},{...observed,travelClassPrices:[{price:100,travelClass:'Business'}]},{...observed,currency:'MILES'}];expect(parseFinnairFares(html(invalid),now)).toEqual([]);
 });
 it("bounds parsing and ignores headline-only markup",()=>{expect(parseFinnairFares('Round-trip from €62',now)).toEqual([]);expect(()=>parseFinnairFares('x'.repeat(4000001),now)).toThrow('too large');});
});

it("retains more than 500 distinct dated official fares instead of failing the whole page",()=>{
 const fares=Array.from({length:501},(_,i)=>({from:"HEL",to:"RIX",fromDate:"2026-11-17",toDate:"2026-11-20",currency:"EUR",travelClassPrices:[{price:i+1,travelClass:"Economy"}]}));
 const html=`<script id="fcom-ux-state">${JSON.stringify(fares)}</script>`;
 expect(parseFinnairFares(html,new Date("2026-10-08"))).toHaveLength(501);
});
