import {describe,it,expect,vi} from 'vitest';
import {aegeanHttpCalendarUrl,parseAegeanHttpCalendar,loadHttpAegeanCalendar} from '../src/aegean-http-calendar';
const trip={origin:'TLV',destination:'ATH',departDate:'2027-06-01',returnDate:'2027-06-05'};
const now=new Date('2026-10-08T11:51:10.694Z');
const date=(value:string)=>JSON.stringify(`/Date(${Date.parse(value)})/`);
const row=(day:string,price:number)=>({Date:date(day),FullPrice:price,Price:price,Class:'Economy',Difference:null,Error:null,Updated:date('2026-10-07'),ServiceFee:0});
const body=()=>({Outbound:[row(trip.departDate,104.63),row('2027-06-02',58.52)],Inbound:[row(trip.returnDate,127.74)],CurrencySymbol:'€'});

describe('exact public Aegean HTTP calendar',()=>{
 it('constructs only observed selected round-trip parameters for the existing route',()=>{
  const url=new URL(aegeanHttpCalendarUrl(trip));
  expect(url.origin+url.pathname).toBe('https://en.aegeanair.com/en/sys/lowfares/RouteLowFares/');
  expect(Object.fromEntries(url.searchParams)).toEqual({DepartureAirport:'TLV',ArrivalAirport:'ATH',TripType:'RT',DepartureDate:'2027-06',ReturnDate:'2027-06',SelectedDepartureDate:'01/06/2027',SelectedReturnDate:'05/06/2027',Type:'Fares'});
  expect(()=>aegeanHttpCalendarUrl({...trip,origin:'JFK'})).toThrow();
  expect(()=>aegeanHttpCalendarUrl({...trip,departDate:'2027-02-30'})).toThrow();
  expect(()=>aegeanHttpCalendarUrl({...trip,returnDate:trip.departDate})).toThrow();
 });
 it('preserves exact selected cash total, original capture and separate vendor update dates',()=>{
  const records=body(),fare=parseAegeanHttpCalendar(records,trip,now.toISOString());
  expect(fare).toMatchObject({...trip,amount:232.37,currency:'EUR',outboundAmount:104.63,inboundAmount:127.74,checkedAt:now.toISOString(),carrier:null,outboundUpdatedAt:'2026-10-07T00:00:00.000Z',inboundUpdatedAt:'2026-10-07T00:00:00.000Z',vendorUpdated:{outbound:records.Outbound[0]!.Updated,inbound:records.Inbound[0]!.Updated}});
  expect(fare!.bookingUrl).toContain('datedeparture=2027-06-01&datereturn=2027-06-05');
  expect(parseAegeanHttpCalendar(records,{...trip,departDate:'2027-06-03'},now.toISOString())).toBeNull();
 });
 it('rejects unavailable, non-economy, ambiguous, malformed and unknown extra-cost rows',()=>{
  for(const changed of [{Price:0},{FullPrice:99},{FullPrice:'104.63'},{Price:104.631,FullPrice:104.631},{Class:'Business'},{Error:'unavailable'},{Error:undefined},{ServiceFee:1},{ServiceFee:undefined},{Updated:date('2026-10-09')},{Updated:'bad'},{Date:'bad'}]){
   const records=body();Object.assign(records.Outbound[0]!,changed);
   expect(parseAegeanHttpCalendar(records,trip,now.toISOString())).toBeNull();
  }
  const duplicated=body();duplicated.Outbound.push({...duplicated.Outbound[0]!});expect(parseAegeanHttpCalendar(duplicated,trip,now.toISOString())).toBeNull();
  expect(parseAegeanHttpCalendar({...body(),CurrencySymbol:'$'},trip,now.toISOString())).toBeNull();
  expect(parseAegeanHttpCalendar({OutboundPrices:{'2027-6':58.52},InboundPrices:{'2027-6':96.99}},trip,now.toISOString())).toBeNull();
  expect(parseAegeanHttpCalendar({...body(),Outbound:[]},trip,now.toISOString())).toBeNull();
  expect(parseAegeanHttpCalendar(body(),trip,'2026-10-08T11:51:10Z')).toBeNull();
 });
 it('fetches public JSON with no credentials and keeps prefetch capture after completion',async()=>{
  const fetchFn=vi.fn(async(_url:unknown,_options?:unknown)=>Response.json(body()));
  const fare=await loadHttpAegeanCalendar(trip,now,fetchFn as typeof fetch);
  expect(fare!.checkedAt).toBe(now.toISOString());expect(fare!.amount).toBe(232.37);
  expect(fetchFn).toHaveBeenCalledOnce();expect(fetchFn.mock.calls[0]![0]).toBe(aegeanHttpCalendarUrl(trip));
  expect(fetchFn.mock.calls[0]![1]).toMatchObject({redirect:'manual',headers:{Accept:'application/json'}});
 });
 it('rejects redirects, malformed JSON and oversized responses without a browser',async()=>{
  await expect(loadHttpAegeanCalendar(trip,now,async()=>new Response('',{status:302}))).rejects.toThrow('HTTP 302');
  await expect(loadHttpAegeanCalendar(trip,now,async()=>new Response('<html>challenge</html>'))).rejects.toThrow('JSON');
  await expect(loadHttpAegeanCalendar(trip,now,async()=>new Response('x'.repeat(128001)))).rejects.toThrow('size limit');
 });
});
