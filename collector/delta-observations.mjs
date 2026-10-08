const realDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const bookingDate=v=>`${v.slice(5,7)}/${v.slice(8,10)}/${v.slice(0,4)}`;
/** Diagnostic observations retain city codes and original vendor timestamp. */
export function deltaObservations(data,checkedAt) {
 if(!data||!Array.isArray(data.routes)||data.routes.length>1000)throw new Error('Invalid Delta route response');
 return data.routes.flatMap(route=>{
  const m=route.money,price=m?.price;
  if(route.carrier!=="Delta Air Lines"||route.legs!=="Round-Trip"||!m||!/^[A-Z]{3}$/.test(route.origin_queried)||!/^[A-Z]{3}$/.test(route.destination_queried)||!realDate(m.travel_date_start)||!realDate(m.travel_date_end)||m.travel_date_end<=m.travel_date_start||!price||!/^\d+(?:\.\d{1,2})?$/.test(String(price.raw))||Number(price.raw)<=0||price.unit!=="USD"||!Number.isFinite(Date.parse(route.calculated_at)))return [];
  const marker="redirecturl=";const at=String(m.deeplink??"").indexOf(marker);if(at<0)return [];
  let url;try{url=new URL(m.deeplink.slice(at+marker.length));}catch{return [];}
  if(url.protocol!=="https:"||url.hostname!=="www.delta.com"||url.pathname!=="/flightsearch/search"||url.username||url.password||url.port||url.hash||url.searchParams.get("awardTravel")!=="false"||url.searchParams.get("paxCount")!=="1"||url.searchParams.get("originCity")!==route.origin_queried||url.searchParams.get("destinationCity")!==route.destination_queried||url.searchParams.get("departureDate")!==bookingDate(m.travel_date_start)||url.searchParams.get("returnDate")!==bookingDate(m.travel_date_end))return [];
  return [{source:"delta",origin:route.origin_queried,destination:route.destination_queried,departDate:m.travel_date_start,returnDate:m.travel_date_end,amount:Number(price.raw),currency:price.unit,calculatedAt:route.calculated_at,checkedAt,bookingUrl:url.href,flexibleDates:url.searchParams.get("datesFlexible")==="true",pricing:"published_advertisement",airportIdentityConfirmed:false,locationKind:'upstream_location_code'}];
 });
}
