const DATE=/^\d{4}-\d{2}-\d{2}$/;
const ROUTES=new Set(['TLV:ATH','ATH:TLV']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const realDate=value=>typeof value==='string'&&DATE.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const displayDate=value=>`${value.slice(8,10)}/${value.slice(5,7)}/${value.slice(0,4)}`;
const validTrip=trip=>object(trip)&&ROUTES.has(`${trip.origin}:${trip.destination}`)&&realDate(trip.departDate)&&realDate(trip.returnDate)&&trip.returnDate>trip.departDate;

/** The observed public controller request. Contextual round-trip rows stay together. */
export function aegeanHttpCalendarUrl(trip){
 if(!validTrip(trip))throw Error('Unsupported Aegean HTTP calendar trip');
 const url=new URL('https://en.aegeanair.com/en/sys/lowfares/RouteLowFares/');
 url.search=new URLSearchParams({DepartureAirport:trip.origin,ArrivalAirport:trip.destination,TripType:'RT',DepartureDate:trip.departDate.slice(0,7),ReturnDate:trip.returnDate.slice(0,7),SelectedDepartureDate:displayDate(trip.departDate),SelectedReturnDate:displayDate(trip.returnDate),Type:'Fares'});
 return url.href;
}

export function aegeanHttpBookingUrl(trip){
 if(!validTrip(trip))throw Error('Unsupported Aegean HTTP calendar trip');
 const url=new URL('https://en.aegeanair.com/flight-deals/low-fare-calendar/');
 url.search=new URLSearchParams({arr:trip.destination,datedeparture:trip.departDate,datereturn:trip.returnDate,dep:trip.origin,month:trip.departDate.slice(0,7),type:'R'});
 return url.href;
}

function vendorTimestamp(raw){
 if(typeof raw!=='string'||raw.length>100)return null;
 let value=raw;
 if(value.startsWith('"')){try{value=JSON.parse(value);}catch{return null;}}
 if(typeof value!=='string')return null;
 const match=/^\/Date\((\d{13})\)\/$/.exec(value);
 if(!match)return null;
 const time=Number(match[1]);
 if(!Number.isSafeInteger(time)||time<Date.UTC(2000,0,1)||time>Date.UTC(2100,0,1))return null;
 const date=new Date(time);
 if(!Number.isFinite(date.getTime()))return null;
 return date.toISOString();
}

function priceCents(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000)return null;
 const cents=Math.round(value*100);
 if(Math.abs(cents/100-value)>1e-8)return null;
 return cents;
}

function selectedRow(rows,date){
 if(!Array.isArray(rows)||!rows.length||rows.length>42)return null;
 const seen=new Set();let selected=null;
 for(const row of rows){
  if(!object(row))return null;
  const timestamp=vendorTimestamp(row.Date);
  if(!timestamp||!timestamp.endsWith('T00:00:00.000Z'))return null;
  const day=timestamp.slice(0,10);
  if(day.slice(0,7)!==date.slice(0,7)||seen.has(day))return null;
  seen.add(day);if(day===date)selected=row;
 }
 if(!selected||selected.Class!=='Economy'||selected.Error!==null||selected.ServiceFee!==0)return null;
 const full=priceCents(selected.FullPrice),shown=priceCents(selected.Price);
 // The public controller sums Price. Equality and a known zero fee avoid invented cost semantics.
 if(full===null||shown!==full)return null;
 const updatedAt=vendorTimestamp(selected.Updated);
 if(!updatedAt)return null;
 return {row:selected,amountCents:full,updatedAt};
}

/** No month minima, independent one-way inference, capture renewal or invented operator. */
export function parseAegeanHttpCalendar(records,trip,checkedAt){
 if(!validTrip(trip)||typeof checkedAt!=='string'||!Number.isFinite(Date.parse(checkedAt))||new Date(checkedAt).toISOString()!==checkedAt||trip.departDate<checkedAt.slice(0,10)||!object(records)||records.CurrencySymbol!=='€')return null;
 const outbound=selectedRow(records.Outbound,trip.departDate),inbound=selectedRow(records.Inbound,trip.returnDate);
 if(!outbound||!inbound||outbound.updatedAt>checkedAt||inbound.updatedAt>checkedAt)return null;
 const amountCents=outbound.amountCents+inbound.amountCents;
 if(amountCents<=0||amountCents>10000000)return null;
 return {origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate,
  amount:amountCents/100,currency:'EUR',outboundAmount:outbound.amountCents/100,inboundAmount:inbound.amountCents/100,
  bookingUrl:aegeanHttpBookingUrl(trip),checkedAt,pricing:'published_advertisement',carrier:null,
  outboundUpdatedAt:outbound.updatedAt,inboundUpdatedAt:inbound.updatedAt,
  vendorUpdated:{outbound:outbound.row.Updated,inbound:inbound.row.Updated}};
}

/** Bounded public HTTP only. No session, cookie, authentication or browser action. */
export async function fetchAegeanHttpCalendarSnapshot(trip,checkedAt=new Date().toISOString(),fetchFn=fetch){
 const url=aegeanHttpCalendarUrl(trip);
 if(typeof checkedAt!=='string'||!Number.isFinite(Date.parse(checkedAt))||new Date(checkedAt).toISOString()!==checkedAt)throw Error('Invalid original capture timestamp');
 const response=await fetchFn(url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
 if(response.status!==200||!response.body)throw Error(`Aegean public calendar HTTP ${response.status}`);
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>128000)throw Error('Aegean public calendar size limit');chunks.push(part.value);}}finally{await reader.cancel();}
 const joined=new Uint8Array(bytes);let cursor=0;for(const chunk of chunks){joined.set(chunk,cursor);cursor+=chunk.length;}
 let records;try{records=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}catch{throw Error('Invalid Aegean public calendar JSON');}
 const fare=parseAegeanHttpCalendar(records,trip,checkedAt);
 return {trip:{origin:trip.origin,destination:trip.destination,departDate:trip.departDate,returnDate:trip.returnDate},page:url,checkedAt,records,fare};
}
