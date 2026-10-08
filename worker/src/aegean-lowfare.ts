export interface AegeanCalendarTrip {
  origin:string; destination:string; departDate:string; returnDate:string;
}
export interface AegeanCalendarFare extends AegeanCalendarTrip {
  amount:number; currency:"EUR"; outboundAmount:number; inboundAmount:number;
  bookingUrl:string; checkedAt:string; pricing:"published_advertisement"; carrier:null;
}
export interface AegeanCalendarText {
  outboundRows:string[]; inboundRows:string[];
  outboundMonths:string[]; inboundMonths:string[]; summaries:string[];
}
function realDate(value:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
function validTrip(q:AegeanCalendarTrip):boolean {
  return q.origin==="TLV"&&q.destination==="ATH"&&realDate(q.departDate)&&realDate(q.returnDate)&&q.returnDate>q.departDate&&q.departDate.slice(0,7)===q.returnDate.slice(0,7);
}
/** Only the observed ordinary calendar query, never caller-supplied URLs or credentials. */
export function aegeanCalendarUrl(q:AegeanCalendarTrip):string {
  if(!validTrip(q))throw new Error("Unsupported collected Aegean calendar trip");
  const url=new URL("https://en.aegeanair.com/flight-deals/low-fare-calendar/");
  url.search=new URLSearchParams({arr:q.destination,datedeparture:q.departDate,datereturn:q.returnDate,dep:q.origin,month:q.departDate.slice(0,7),type:"R"}).toString();
  return url.href;
}
const clean=(text:string)=>text.replace(/\s+/g," ").trim();
const monthNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const displayDate=(date:string)=>`${date.slice(8,10)}/${date.slice(5,7)}/${date.slice(0,4)}`;
function monthPrices(rows:string[],month:string):Map<string,number>|null {
  if(rows.length>42)return null;
  const prices=new Map<string,number>();
  for(const raw of rows){
    if(raw.length>2000)return null;
    const text=clean(raw);if(!text)continue;
    // Unavailable calendar days have no price and cannot produce an offer.
    if(/^\d{1,2}$/.test(text))continue;
    const match=/^(\d{1,2}) €\s*(\d+(?:\.\d{1,2})?)$/.exec(text);if(!match)return null;
    const date=`${month}-${match[1]!.padStart(2,"0")}`;const amount=Number(match[2]);
    if(!realDate(date)||!Number.isFinite(amount)||amount<=0||amount>100000||prices.has(date))return null;
    prices.set(date,amount);
  }
  return prices;
}
/** Selected trip only. Contextual return-trip calendars are never treated as independent one-way quotes. */
export function parseAegeanCalendar(text:AegeanCalendarText,q:AegeanCalendarTrip,now:Date):AegeanCalendarFare|null {
  if(!validTrip(q)||q.departDate<now.toISOString().slice(0,10))return null;
  const month=q.departDate.slice(0,7);const name=monthNames[Number(month.slice(5))-1];
  for(const selected of [text.outboundMonths,text.inboundMonths]){
    if(selected.length!==1||selected[0]!.length>200||!new RegExp(`^${name} from €\\s*\\d+(?:\\.\\d{1,2})?$`).test(clean(selected[0]!)))return null;
  }
  const outbound=monthPrices(text.outboundRows,month),inbound=monthPrices(text.inboundRows,month);
  const out=outbound?.get(q.departDate),back=inbound?.get(q.returnDate);
  if(out===undefined||back===undefined||text.summaries.length>10)return null;
  const pattern=new RegExp(`^[^()]+\\(TLV\\) to [^()]+\\(ATH\\) ${displayDate(q.departDate)} [^()]+\\(ATH\\) to [^()]+\\(TLV\\) ${displayDate(q.returnDate)} €\\s*(\\d+(?:\\.\\d{1,2})?)\\s*Total(?: Book this trip)?$`);
  const matches=text.summaries.filter(s=>s.length<=2000).map(s=>pattern.exec(clean(s))).filter(m=>m!==null);
  if(matches.length!==1)return null;
  const amount=Number(matches[0]![1]);
  if(amount<=0||amount>100000||Math.round(amount*100)!==Math.round(out*100)+Math.round(back*100))return null;
  return {...q,amount,currency:"EUR",outboundAmount:out,inboundAmount:back,bookingUrl:aegeanCalendarUrl(q),checkedAt:now.toISOString(),pricing:"published_advertisement",carrier:null};
}
