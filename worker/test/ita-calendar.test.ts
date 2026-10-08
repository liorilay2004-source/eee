import {it,expect} from "vitest";
import {parseItaReturnPrices} from "../src/ita-calendar";
const now=new Date("2026-10-08");const query={originCity:"ROM",destinationCity:"SAO",departDate:"2026-11-13"};
const body={countryCode:"IT",currency:"EUR",originCityNameUrl:"rome",destinationCityNameUrl:"sao+paulo",farePerReturnDates:[{returnDate:"2026-11-17T00:00:00.000+00:00",price:802.09}]};
it("preserves exact return dates and cents without inventing airline or airports",()=>{
 expect(parseItaReturnPrices(body,query,now)).toEqual([{...query,returnDate:"2026-11-17",amount:802.09,currency:"EUR",seller:"ITA Airways",carrier:null,pricing:"published_advertisement",checkedAt:now.toISOString()}]);
});
it("rejects monthly/one-date data, route mismatches, expired dates, noncash and invalid dates",()=>{
 for(const data of [{...body,farePerReturnDates:undefined,farePerDates:[{outboundDate:"2026-11-13",price:750}]},{...body,currency:"USD"},{...body,destinationCityNameUrl:"tel+aviv"},{...body,farePerReturnDates:[{returnDate:"2027-02-30T00:00:00.000+00:00",price:802}]},{...body,farePerReturnDates:[{returnDate:"2026-11-13T00:00:00.000+00:00",price:802}]},{...body,farePerReturnDates:[{returnDate:"2026-11-17T00:00:00.000+00:00",price:-1}]}])expect(parseItaReturnPrices(data,query,now)).toEqual([]);
 expect(parseItaReturnPrices(body,{...query,departDate:"2026-09-01"},now)).toEqual([]);
});
