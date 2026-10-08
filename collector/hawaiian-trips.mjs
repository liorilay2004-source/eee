import {hawaiianFares} from './hawaiian-fares.mjs';
/** Reparse upstream observations and index exact dates. Do not renew capture times. */
export function hawaiianIndex(observations,now=new Date()){
 if(!Array.isArray(observations)||observations.length>100||!Number.isFinite(now.getTime()))throw new Error('Invalid snapshot');
 const latest=new Map();
 for(const row of observations){
  const at=Date.parse(row?.fetchedAt);
  if(row?.error||!Number.isFinite(at)||at>now.getTime())continue;
  if(!latest.has(row.page)||at>Date.parse(latest.get(row.page).fetchedAt))latest.set(row.page,row);
 }
 const byDate={};
 for(const row of latest.values()){
  if(now.getTime()-Date.parse(row.fetchedAt)>=600000)continue;
  for(const fare of hawaiianFares(row)){
   if(fare.structure!=='oneway')continue;
   const key=[fare.origin,fare.destination,fare.departDate].join(':');
   (byDate[key]??=[]).push(fare);
  }
 }
 return {byDate};
}
export function hawaiianTrips(index,q,now=new Date()){
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
 if(!q||!/^[A-Z]{3}$/.test(q.origin??'')||!/^[A-Z]{3}$/.test(q.destination??'')||q.origin===q.destination||!date(q.departDate)||!date(q.returnDate)||q.returnDate<=q.departDate||!Number.isFinite(now.getTime())||q.departDate<now.toISOString().slice(0,10)||(q.adults??1)!==1||(q.children??0)!==0||(q.infants??0)!==0)throw new Error('Unsupported trip');
 const fresh=f=>Number.isFinite(Date.parse(f.fetchedAt))&&now.getTime()>=Date.parse(f.fetchedAt)&&now.getTime()-Date.parse(f.fetchedAt)<600000;
 const outs=(index.byDate?.[[q.origin,q.destination,q.departDate].join(':')]??[]).filter(fresh);
 const backs=(index.byDate?.[[q.destination,q.origin,q.returnDate].join(':')]??[]).filter(fresh);
 const trips=[];
 for(const outbound of outs)for(const inbound of backs){
  if(outbound.currency!==inbound.currency)continue;
  trips.push({...q,amount:Math.round((outbound.amount+inbound.amount)*100)/100,currency:outbound.currency,outbound,inbound,structure:'split',operator:null,checkoutVerified:false,ancillaryFeesKnown:false,pricing:'published_advertisement',priceAgeKnown:!!outbound.upstreamPriceAge&&!!inbound.upstreamPriceAge});
 }
 return trips.sort((a,b)=>a.currency.localeCompare(b.currency)||a.amount-b.amount);
}
