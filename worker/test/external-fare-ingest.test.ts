import {it,expect,vi} from "vitest";
import {ingestPublicFares,externalLhgCache} from "../src/external-fare-ingest";
import {EXTERNAL_FARE_PAGES} from "../src/external-fare-catalog";
import {storedQuoteWithinAge} from "../src/pipeline";
import type {Env} from "../src/types";
const now=new Date("2026-10-08T06:30:00Z"),key="a".repeat(64),entry=EXTERNAL_FARE_PAGES[0];
const body={source:entry.source,page:entry.page,checkedAt:now.toISOString(),anchors:[{text:"From 304 EUR",url:"https://www.lufthansa.com/aircore/deeplink/redirect/en/gr/ATH/TLV/05.06.2027/19.06.2027/RT"}]};
const request=(value:unknown=body,token=key)=>new Request("https://example.com/api/internal/public-fares",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(value)});
it("reparses approved published page records and rejects mismatched pages",async()=>{
 const e=env(),value={source:"published_page",airline:"AC",page:"https://www.aircanada.com/en-ca/flights-from-tel-aviv",checkedAt:now.toISOString(),records:[{__typename:"Fare",originAirportCode:"TLV",destinationAirportCode:"YYZ",departureDate:"2027-06-01",returnDate:"2027-06-05",totalPrice:500,currencyCode:"CAD",travelClass:"ECONOMY",flightType:"ROUND_TRIP"}]};
 expect((await ingestPublicFares(request(value),e.value,now)).status).toBe(200);
 expect(JSON.parse(e.write.mock.calls[0]![1]).fares[0]).toMatchObject({amount:500,currency:"CAD",pricing:"published_advertisement"});
 expect((await ingestPublicFares(request({...value,page:"https://evil.example"}),e.value,now)).status).toBe(400);
 expect((await ingestPublicFares(request({...value,records:[{...value.records[0],originAirportCode:"FCO"}]}),e.value,now)).status).toBe(422);
});
it("ingests parsed official Ryanair calendars and rejects mismatched URLs",async()=>{
 const e=env(),value={source:"ryanair",origin:"ATH",destination:"FCO",month:"2027-06",page:"https://services-api.ryanair.com/farfnd/v4/oneWayFares/ATH/FCO/cheapestPerDay?outboundMonthOfDate=2027-06-01&currency=EUR",checkedAt:now.toISOString(),body:{outbound:{fares:[{day:"2027-06-01",departureDate:"2027-06-01T10:00:00",price:{value:42,currencyCode:"EUR"}}]}}};
 expect((await ingestPublicFares(request(value),e.value,now)).status).toBe(200);
 expect(JSON.parse(e.write.mock.calls[0]![1]).fares[0]).toMatchObject({airline:"FR",amount:42,checkedAt:now.toISOString()});
 expect((await ingestPublicFares(request({...value,page:"https://evil.example"}),e.value,now)).status).toBe(400);
});
it("ingests matching Air Serbia calendars without inventing flight times",async()=>{
 const e=env(),value={source:"air_serbia",origin:"BEG",destination:"ATH",month:"2027-06",page:"https://www.airserbia.com/api/destination/flight-prices/BEG/ATH?year=2027&month=6&pos=GLOBAL",checkedAt:now.toISOString(),body:{origin:"BEG",destination:"ATH",year:2027,month:6,source:"db",prices:{"2027-06-01":{price:55,currency:"EUR",soldOut:false}}}};
 expect((await ingestPublicFares(request(value),e.value,now)).status).toBe(200);
 expect(JSON.parse(e.write.mock.calls[0]![1]).fares[0]).toMatchObject({airline:"JU",amount:55});
 expect((await ingestPublicFares(request({...value,body:{...value.body,origin:"TLV"}}),e.value,now)).status).toBe(422);
});
function env(){const write=vi.fn().mockResolvedValue(undefined),read=vi.fn().mockResolvedValue(null);return {write,read,value:{COLLECTOR_KEY:key,PUBLIC_FARES:{getByName:()=>({write,read})}} as unknown as Env};}
it("authenticates before consuming body or writing",async()=>{const e=env();expect((await ingestPublicFares(request(body,"b".repeat(64)),e.value,now)).status).toBe(401);expect(e.write).not.toHaveBeenCalled();});
it("fails closed without collector configuration",async()=>{expect((await ingestPublicFares(request(),{} as Env,now)).status).toBe(503);});
it("preserves original price and observation time",async()=>{const e=env();expect((await ingestPublicFares(request(),e.value,now)).status).toBe(200);const snapshot=JSON.parse(e.write.mock.calls[0]![1]);expect(snapshot.expires).toBe(now.getTime()+600000);expect(snapshot.fares[0]).toMatchObject({amount:304,currency:"EUR",carrier:null,checkedAt:now.toISOString()});});
it.each([{...body,page:"https://evil.example"},{...body,checkedAt:"bad"},{...body,checkedAt:new Date(now.getTime()+1).toISOString()},{...body,checkedAt:new Date(now.getTime()-120001).toISOString()},{...body,anchors:[{text:"x",url:5}]}])("rejects invalid payload",async value=>{const e=env();expect((await ingestPublicFares(request(value),e.value,now)).status).toBe(400);expect(e.write).not.toHaveBeenCalled();});
it("does not replace valid snapshots with empty prices",async()=>{const e=env();expect((await ingestPublicFares(request({...body,anchors:[]}),e.value,now)).status).toBe(422);expect(e.write).not.toHaveBeenCalled();});
it("bounds payloads and tolerates storage failure",async()=>{const e=env();expect((await ingestPublicFares(request({text:"x".repeat(128001)}),e.value,now)).status).toBe(413);e.write.mockRejectedValue(new Error());expect((await ingestPublicFares(request(),e.value,now)).status).toBe(503);});
it("bypasses regional data for shared external updates",async()=>{const e=env();expect(externalLhgCache(e.value,now)).toBeUndefined();e.value.EXTERNAL_LHG_COLLECTOR="true";e.read.mockResolvedValue(JSON.stringify({storedAt:now.getTime(),expires:now.getTime()+600000,fares:[{amount:304}]}));expect(await externalLhgCache(e.value,now)!.get(entry.page)).toMatchObject({fares:[{amount:304}]});});
it.each(["lufthansa","swiss","austrian","brussels_airlines"] as const)("expires stored %s prices at ten minutes",source=>{expect(storedQuoteWithinAge({source,checkedAt:now.toISOString()},new Date(now.getTime()+599999))).toBe(true);expect(storedQuoteWithinAge({source,checkedAt:now.toISOString()},new Date(now.getTime()+600000))).toBe(false);});
