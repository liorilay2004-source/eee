const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
/** Two independently observed tickets, exact dates, original timestamps, unknown ancillary fees. */
export function frontierTrips(snapshot,q,now=new Date()){
 if(!q||!/^[A-Z]{3}$/.test(q.origin)||!/^[A-Z]{3}$/.test(q.destination)||q.origin===q.destination||!date(q.departDate)||!date(q.returnDate)||q.returnDate<=q.departDate||!Number.isFinite(now.getTime()))throw new Error('Invalid Frontier trip');
 if(q.departDate<now.toISOString().slice(0,10)||(q.adults!==undefined&&q.adults!==1)||(q.children!==undefined&&q.children!==0)||(q.infants!==undefined&&q.infants!==0))throw new Error('Unsupported Frontier party or dates');
 const usable=f=>f&&f.airline==='F9'&&f.structure==='oneway'&&f.returnDate===null&&Number.isFinite(f.amount)&&f.amount>0&&/^[A-Z]{3}$/.test(f.currency)&&Number.isFinite(Date.parse(f.checkedAt))&&now.getTime()>=Date.parse(f.checkedAt)&&now.getTime()-Date.parse(f.checkedAt)<600000;
 const forward=(snapshot.byRoute?.[q.origin+':'+q.destination]??[]).filter(f=>usable(f)&&f.origin===q.origin&&f.destination===q.destination&&f.departDate===q.departDate);
 const reverse=(snapshot.byRoute?.[q.destination+':'+q.origin]??[]).filter(f=>usable(f)&&f.origin===q.destination&&f.destination===q.origin&&f.departDate===q.returnDate);
 const trips=[];
 for(const out of forward)for(const back of reverse){
  if(out.currency!==back.currency)continue;
  trips.push({...q,adults:1,children:0,infants:0,structure:'split',amount:Math.round((out.amount+back.amount)*100)/100,currency:out.currency,checkedAt:Date.parse(out.checkedAt)<=Date.parse(back.checkedAt)?out.checkedAt:back.checkedAt,outbound:out,inbound:back,pricing:'published_advertisement',ancillaryFeesKnown:false,checkoutVerified:false});
 }
 return trips.sort((a,b)=>a.currency.localeCompare(b.currency)||a.amount-b.amount);
}
