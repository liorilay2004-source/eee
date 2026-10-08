import {expect,it,vi} from "vitest";
import {handleAegeanDemand} from "../src/aegean-demand-handler";
import {ingestPublicFares} from "../src/external-fare-ingest";
import {AEGEAN_DEMAND_OBJECT} from "../src/aegean-on-demand";
import type {Env} from "../src/types";
const key="a".repeat(64),trip={origin:"TLV",destination:"ATH",departDate:"2027-07-02",returnDate:"2027-07-06"};
const request=(method="GET",body?:unknown,token=key)=>new Request("https://example.com/api/internal/aegean-demand",{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
function setup(){
 const pendingAegean=vi.fn(async()=>[trip]),claimAegean=vi.fn(async()=>true),completeAegean=vi.fn(async()=>true),write=vi.fn();
 const getByName=vi.fn(()=>({pendingAegean,claimAegean,completeAegean,write}));
 const prepare=vi.fn(()=>{throw Error("D1 should not be used");});
 const env={LOCAL_COLLECTOR_KEY:key,PUBLIC_FARES:{getByName},DB:{prepare}} as unknown as Env;
 return {env,pendingAegean,claimAegean,completeAegean,write,getByName,prepare};
}
it("lists bounded aggregate trips only to an authenticated collector with no D1 work",async()=>{
 const e=setup(),result=await handleAegeanDemand(request(),e.env);
 expect(result.status).toBe(200);expect(result.headers.get("Cache-Control")).toBe("no-store");
 expect(await result.json()).toEqual({trips:[trip]});expect(e.getByName).toHaveBeenCalledWith(AEGEAN_DEMAND_OBJECT);
 expect(e.pendingAegean).toHaveBeenCalledWith(12);expect(e.prepare).not.toHaveBeenCalled();
});
it("refuses credentials before reading the body or reaching storage",async()=>{
 const e=setup(),bad=request("POST",{trip},"b".repeat(64));
 expect((await handleAegeanDemand(bad,e.env)).status).toBe(401);expect(bad.bodyUsed).toBe(false);expect(e.getByName).not.toHaveBeenCalled();
 expect((await handleAegeanDemand(request(),{...e.env,LOCAL_COLLECTOR_KEY:undefined})).status).toBe(503);
});
it("claims only exact observed route/date shapes and never fetches supplied URLs",async()=>{
 const e=setup();expect(await (await handleAegeanDemand(request("POST",{trip,url:"https://evil.example"}),e.env)).json()).toEqual({claimed:true});
 expect(e.claimAegean).toHaveBeenCalledWith(trip);
 for(const selected of [null,[],{...trip,origin:"JFK"},{...trip,departDate:"2027-02-30"},{...trip,returnDate:trip.departDate}]){
  expect((await handleAegeanDemand(request("POST",{trip:selected}),e.env)).status).toBe(400);
 }
 expect(e.claimAegean).toHaveBeenCalledTimes(1);
 e.claimAegean.mockResolvedValue(false);expect(await (await handleAegeanDemand(request("POST",{trip}),e.env)).json()).toEqual({claimed:false});
});
it("bounds payloads and fails closed on missing or unavailable storage",async()=>{
 const e=setup();expect((await handleAegeanDemand(request("POST",{trip,padding:"x".repeat(4096)}),e.env)).status).toBe(413);
 expect((await handleAegeanDemand(request("DELETE"),e.env)).status).toBe(405);
 expect((await handleAegeanDemand(request(),{...e.env,PUBLIC_FARES:undefined})).status).toBe(503);
 e.pendingAegean.mockRejectedValue(Error("unavailable"));expect((await handleAegeanDemand(request(),e.env)).status).toBe(503);
 expect(e.claimAegean).not.toHaveBeenCalled();
});
it("acknowledges demand only after a selected original fare has been stored",async()=>{
 const e=setup(),now=new Date("2026-10-08T12:00:00.000Z"),date=(d:string)=>JSON.stringify(`/Date(${Date.parse(d)})/`);
 const row=(d:string,p:number)=>({Date:date(d),Updated:date("2026-10-07"),Price:p,FullPrice:p,Class:"Economy",Error:null,ServiceFee:0});
 const body={source:"aegean_http_calendar",trip,checkedAt:now.toISOString(),records:{CurrencySymbol:"€",Outbound:[row(trip.departDate,100)],Inbound:[row(trip.returnDate,150)]}};
 const req=()=>new Request("https://example.com/api/internal/public-fares",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
 expect((await ingestPublicFares(req(),e.env,now)).status).toBe(200);
 expect(e.completeAegean).toHaveBeenCalledWith(trip,body.checkedAt);
 expect(e.write.mock.invocationCallOrder[0]).toBeLessThan(e.completeAegean.mock.invocationCallOrder[0]!);
 e.completeAegean.mockRejectedValue(Error("ack unavailable"));expect((await ingestPublicFares(req(),e.env,now)).status).toBe(200);
 e.completeAegean.mockClear();e.write.mockRejectedValue(Error("storage unavailable"));expect((await ingestPublicFares(req(),e.env,now)).status).toBe(503);expect(e.completeAegean).not.toHaveBeenCalled();
});
