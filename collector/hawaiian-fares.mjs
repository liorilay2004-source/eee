const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
/** Official public advertisements; site branding alone does not identify the operator. */
export function hawaiianFares(observation){
 const url=new URL(observation.page),at=Date.parse(observation.fetchedAt);
 if(url.protocol!=='https:'||url.hostname!=='asha.hawaiianairlines.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/en\/flights-from-[a-z-]+$/.test(url.pathname)||!Number.isFinite(at)||observation.error||!Array.isArray(observation.records)||observation.records.length>500)throw new Error('Invalid official observation');
 const today=new Date(at).toISOString().slice(0,10),fares=[];
 for(const r of observation.records){
  if(!r||r.__typename!=='Fare'||r.travelClass!=='ECONOMY'||r.redemption!=null&&r.redemption!==false||r.promoCode!=null&&r.promoCode!==''||!/^[A-Z]{3}$/.test(r.originAirportCode??'')||!/^[A-Z]{3}$/.test(r.destinationAirportCode??'')||r.originAirportCode===r.destinationAirportCode||!validDate(r.departureDate)||r.departureDate<today||typeof r.totalPrice!=='number'||!Number.isFinite(r.totalPrice)||r.totalPrice<=0||typeof r.currencyCode!=='string'||!/^[A-Z]{3}$/.test(r.currencyCode))continue;
  const oneWay=r.flightType==='ONE_WAY'&&(r.returnDate==null||r.returnDate==='');
  const roundTrip=r.flightType==='ROUND_TRIP'&&validDate(r.returnDate)&&r.returnDate>r.departureDate;
  if(!oneWay&&!roundTrip)continue;
  const age=r.priceLastSeen,value=typeof age?.value==='string'&&/^\d+$/.test(age.value)?Number(age.value):age?.value;
  const upstreamPriceAge=Number.isSafeInteger(value)&&value>=0&&value<=36500&&['minutes','hours','days'].includes(age?.unit)?{value,unit:age.unit}:null;
  fares.push({origin:r.originAirportCode,destination:r.destinationAirportCode,departDate:r.departureDate,returnDate:roundTrip?r.returnDate:null,amount:r.totalPrice,currency:r.currencyCode,structure:oneWay?'oneway':'roundtrip',sourceUrl:url.href,fetchedAt:observation.fetchedAt,upstreamPriceAge,operator:null,checkoutVerified:false,pricing:'published_advertisement'});
 }
 return [...new Map(fares.map(f=>[JSON.stringify(f),f])).values()];
}
