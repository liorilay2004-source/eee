import {describe,expect,it,vi} from "vitest";
import {readAegeanCalendar,validateAegeanCalendar} from "../src/aegean-calendar-cache";
import {aegeanCalendarUrl,type AegeanCalendarFare} from "../src/aegean-lowfare";
import {fareFreshness,sourceUpdatedTimestamp} from "../src/freshness";
import {sanitizeOffers} from "../src/pipeline";
import type {PublicFareCache} from "../src/public-fare-cache";
import {createAegeanPublishedSource} from "../src/sources/aegean-published";
import type {Offer} from "../src/types";

const now=new Date("2026-10-08T12:00:00.000Z");
const q={origin:"TLV",destination:"ATH",departDate:"2027-06-01",returnDate:"2027-06-05",party:{adults:1,children:0,infants:0}};
const earlier="2026-10-06T08:15:00.000Z",later="2026-10-07T09:30:00.000Z";
const token=(date:string)=>`/Date(${Date.parse(date)})/`;
const fare:AegeanCalendarFare={origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,amount:232.37,currency:"EUR",outboundAmount:104.63,inboundAmount:127.74,bookingUrl:aegeanCalendarUrl(q),checkedAt:now.toISOString(),pricing:"published_advertisement",carrier:null,outboundUpdatedAt:later,inboundUpdatedAt:earlier,vendorUpdated:{outbound:token(later),inbound:JSON.stringify(token(earlier))}};

function shared(value:AegeanCalendarFare|null=fare,expires=now.getTime()+600_000){
  const get=vi.fn(async()=>value?{fares:[value],expires}:null);
  return {get,put:vi.fn()} as unknown as PublicFareCache;
}
async function offer():Promise<Offer>{
  const [value]=await createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,shared()).quote(q);
  return value!;
}

describe("original Aegean calendar update timestamps",()=>{
  it("keeps original normalized and raw times while exposing the older of both selected rows",async()=>{
    const cache=shared(),fetcher=vi.fn() as unknown as typeof fetch;
    expect(await readAegeanCalendar(cache,q,now)).toEqual(fare);
    const [value]=await createAegeanPublishedSource(now,fetcher,cache).quote(q);
    expect(value).toMatchObject({checkedAt:fare.checkedAt,sourceUpdatedAt:earlier,fareFoundAt:null,priceAmount:232.37,
      outbound:{airlines:[],departTime:null,stops:null},inbound:{airlines:[],departTime:null,stops:null}});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts older snapshots without update metadata and leaves a partly known update unknown",async()=>{
    const {outboundUpdatedAt:_,inboundUpdatedAt:__,vendorUpdated:___,...legacy}=fare;
    expect(validateAegeanCalendar(legacy,q,now)).toEqual(legacy);
    for(const row of [legacy,{...legacy,outboundUpdatedAt:later},{...legacy,vendorUpdated:fare.vendorUpdated}]){
      const [value]=await createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,shared(row)).quoteCached(q);
      expect(value).toHaveProperty("fareFoundAt",null);
      expect(value).not.toHaveProperty("sourceUpdatedAt");
    }
  });

  it.each([
    {outboundUpdatedAt:"2026-10-07T09:30:00Z"},
    {outboundUpdatedAt:"2026-10-07T11:30:00.000+02:00"},
    {outboundUpdatedAt:"2026-10-07T09:30:00"},
    {outboundUpdatedAt:"2026-02-30T09:30:00.000Z"},
    {outboundUpdatedAt:new Date(now.getTime()+1).toISOString()},
    {outboundUpdatedAt:null},
    {vendorUpdated:{outbound:token(earlier),inbound:token(earlier)}},
    {vendorUpdated:{outbound:token(later),inbound:token(new Date(now.getTime()+1).toISOString())}},
    {vendorUpdated:{outbound:token(later),inbound:"garbage"}},
    {vendorUpdated:{outbound:token(later)}},
    {vendorUpdated:[token(later),token(earlier)]},
    {vendorUpdated:{outbound:token(later),inbound:token(earlier),extra:"unexpected"}},
  ])("rejects noncanonical, invalid, future or inconsistent source update metadata: %j",change=>{
    expect(validateAegeanCalendar({...fare,...change},q,now)).toBeNull();
  });

  it("requires the original cache expiry as well as the original capture age",async()=>{
    expect(await readAegeanCalendar(shared(fare,now.getTime()),q,now)).toBeNull();
    expect(await readAegeanCalendar(shared(fare),q,new Date(now.getTime()+600_000))).toBeNull();
    expect(await readAegeanCalendar(shared(fare),q,new Date(now.getTime()-1))).toBeNull();
  });

  it("uses an elapsed request clock after collection, retaining the actual capture",async()=>{
    let current=now;
    const captured=new Date(now.getTime()+3000).toISOString();
    const collected={...fare,checkedAt:captured};
    const onDemand=vi.fn(async()=>{await Promise.resolve();current=new Date(now.getTime()+4000);return collected;});
    const fetcher=vi.fn() as unknown as typeof fetch;
    const source=createAegeanPublishedSource(now,fetcher,undefined,undefined,onDemand,()=>current);
    expect(await source.quote(q)).toMatchObject([{priceAmount:232.37,checkedAt:captured,sourceUpdatedAt:earlier,fareFoundAt:null}]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onDemand).toHaveBeenCalledTimes(1);
  });

  it("does not accept a capture later than the trusted clock after collection",async()=>{
    const completion=new Date(now.getTime()+4000);
    const onDemand=vi.fn(async()=>({...fare,checkedAt:new Date(completion.getTime()+1).toISOString()}));
    const fetcher=vi.fn(async()=>new Response('<script id="__NEXT_DATA__">{"props":{}}</script>')) as unknown as typeof fetch;
    const source=createAegeanPublishedSource(now,fetcher,undefined,undefined,onDemand,()=>completion);
    expect(await source.quote(q)).toEqual([]);
    expect(onDemand).toHaveBeenCalledTimes(1);
  });

  it("checks capture freshness at the injected clock during cache-only reads",async()=>{
    let current=now;
    const source=createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,shared(),undefined,undefined,()=>current);
    expect(await source.quoteCached(q)).toHaveLength(1);
    current=new Date(now.getTime()+600_000);
    expect(await source.quoteCached(q)).toEqual([]);
  });
});

describe("calendar update metadata sanitation and labels",()=>{
  it("canonicalizes a valid source update without changing original capture or inventing price-found time",async()=>{
    const original=await offer();
    const [clean]=sanitizeOffers([{...original,sourceUpdatedAt:"2026-10-06T10:15:00+02:00"}],["aegean"]);
    expect(clean).toMatchObject({sourceUpdatedAt:earlier,checkedAt:fare.checkedAt});
    expect(clean?.fareFoundAt??null).toBeNull();
    expect(sourceUpdatedTimestamp(earlier,fare.checkedAt)).toBe(earlier);
  });

  it.each(["2026-10-06T08:15:00","2026-02-30T08:15:00Z","2026-10-08T12:00:00.001Z",null,42])("drops malformed or future update %j without a clock-skew allowance",async raw=>{
    const original=await offer();
    const [clean]=sanitizeOffers([{...original,sourceUpdatedAt:raw}],["aegean"]);
    expect(clean).not.toHaveProperty("sourceUpdatedAt");
    expect(sourceUpdatedTimestamp(raw,fare.checkedAt)).toBeNull();
  });

  it("labels the original calendar update, collection age and unverified advertisement separately",async()=>{
    const original=await offer();
    const first=fareFreshness(original,new Date(now.getTime()+60_000));
    const repeated=fareFreshness(original,new Date(now.getTime()+180_000));
    expect(first).toMatchObject({fareFoundAt:null,fareAgeHours:null,fareAgeMinutes:null,fareAgeMaxMinutes:null,
      fareAgeBasis:"unknown",freshness:"unknown",scanAgeMinutes:1});
    expect(first.ageLabelHe).toContain("לוח המחירים עודכן ב־06/10/2026 08:15 UTC");
    expect(first.ageLabelHe).toContain("הנתונים נאספו לפני דקה");
    expect(first.ageLabelHe).toContain("טרם אומתה באתר ההזמנה");
    expect(repeated.ageLabelHe).toContain("06/10/2026 08:15 UTC");
    expect(repeated.ageLabelHe).toContain("הנתונים נאספו לפני 3 דקות");
    expect(repeated.fareFoundAt).toBeNull();
  });

  it("keeps an actual price-found timestamp distinct from a generic calendar update",async()=>{
    const original=await offer(),foundAt="2026-10-08T11:55:00.000Z";
    expect(fareFreshness({...original,fareFoundAt:foundAt},now)).toMatchObject({fareFoundAt:foundAt,fareAgeBasis:"source",fareAgeMinutes:5});
  });

  it.each([
    [1,"days","יום אחד"],[2,"days","יומיים"],[3,"days","3 ימים"],
    [1,"hours","שעה אחת"],[2,"hours","שעתיים"],[1,"minutes","דקה אחת"],
  ] as const)("renders reported age %i %s with correct Hebrew",async(value,unit,text)=>{
    const {sourceUpdatedAt:_,...original}=await offer();
    const label=fareFreshness({...original,upstreamPriceAge:{value,unit}},now).ageLabelHe;
    expect(label).toContain(`גיל של ${text}`);
    expect(label).not.toContain("1 ימים");
  });
});

describe("Aegean selected-trip cache hooks",()=>{
  it("reads only the shared selected snapshot with zero requests or coordination calls",async()=>{
    const fetcher=vi.fn() as unknown as typeof fetch,onDemand=vi.fn(),prepare=vi.fn();
    const source=createAegeanPublishedSource(now,fetcher,shared(),{prepare} as unknown as D1Database,onDemand);
    const [value]=await source.quoteCached(q);
    expect(value).toMatchObject({priceAmount:232.37,checkedAt:fare.checkedAt,sourceUpdatedAt:earlier});
    expect(fetcher).not.toHaveBeenCalled();expect(onDemand).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
    expect(source.callCount()).toBe(0);expect(source.cacheOnly).toBeUndefined();
    expect(await source.quoteCached({...q,adults:2})).toEqual([]);
    expect(await source.quoteCached({...q,party:{...q.party,adults:2}})).toEqual([]);
  });

  it.each([180,300])("rejects a superseded stored native price and uses the new EUR %i snapshot",async amount=>{
    const old=await offer(),row={...fare,amount,outboundAmount:100,inboundAmount:amount-100};
    const source=createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,shared(row));
    expect(await source.validatesStoredOffer(old)).toBe(false);
    const [updated]=await source.quoteCached(q);
    expect(updated?.priceAmount).toBe(amount);
    expect(await source.validatesStoredOffer(updated!)).toBe(true);
    expect(await source.validatesStoredOffer({...updated!,checkedAt:new Date(now.getTime()-1).toISOString()})).toBe(false);
    expect(await source.validatesStoredOffer({...updated!,priceCurrency:"USD"})).toBe(false);
  });

  it("cannot revive a missing or expired selected snapshot",async()=>{
    const old=await offer();
    for(const cache of [shared(null),shared(fare,now.getTime()),shared({...fare,checkedAt:new Date(now.getTime()-600_000).toISOString()})]){
      const source=createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,cache);
      expect(await source.quoteCached(q)).toEqual([]);
      expect(await source.validatesStoredOffer(old)).toBe(false);
    }
  });

  it("preserves the existing validation behavior for generic marketing-page offers",async()=>{
    const old=await offer(),get=vi.fn();
    const source=createAegeanPublishedSource(now,vi.fn() as unknown as typeof fetch,{get,put:vi.fn()} as unknown as PublicFareCache);
    const marketing={...old,deeplink:"https://flights.aegeanair.com/en/flights-from-tel-aviv-to-athens",outbound:{...old.outbound,airlines:["A3"]}};
    expect(await source.validatesStoredOffer(marketing)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
