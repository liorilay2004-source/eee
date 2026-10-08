import {parsePublishedFares} from '../worker/src/sources/published-fares.ts';
/** Reparse observed upstream records, retaining original capture time, never refreshing it on merge. */
export function frontierSnapshot(rows,now=new Date()){
 if(!Array.isArray(rows)||rows.length>2500||!Number.isFinite(now.getTime()))throw new Error('Invalid Frontier observations');
 const pages=new Map();
 for(const row of rows){
  if(!row||row.error||typeof row.checkedAt!=='string'||!Array.isArray(row.records)||row.records.length>500)continue;
  const at=Date.parse(row.checkedAt);if(!Number.isFinite(at)||at>now.getTime())continue;
  let url;try{url=new URL(row.finalUrl);}catch{continue;}
  if(url.protocol!=='https:'||url.hostname!=='flights.flyfrontier.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/(?:en\/)?flights-from-[a-z-]+\/?$/.test(url.pathname))continue;
  const previous=pages.get(url.href);if(previous&&Date.parse(previous.checkedAt)>=at)continue;
  pages.set(url.href,row);
 }
 const observations=[];
 for(const [url,row] of pages){
  const origins=[...new Set(row.records.map(r=>r?.originAirportCode).filter(v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)))];
  if(origins.length>20)continue;
  const html=`<script id="__NEXT_DATA__">${JSON.stringify({records:row.records}).replaceAll('<','\\u003c')}</script>`;
  for(const origin of origins)observations.push(...parsePublishedFares(html,{airline:'F9',origin,destination:'XXX',allDestinations:true,sourceUrl:url,now:new Date(row.checkedAt)}));
 }
 const fresh=observations.filter(f=>now.getTime()-Date.parse(f.checkedAt)<600000);
 const byRoute={};
 for(const fare of fresh){const key=fare.origin+':'+fare.destination;(byRoute[key]??=[]).push(fare);}
 for(const fares of Object.values(byRoute))fares.sort((a,b)=>a.departDate.localeCompare(b.departDate)||a.currency.localeCompare(b.currency)||a.amount-b.amount);
 return {mergedAt:now.toISOString(),pages:pages.size,observations,fresh,byRoute};
}
