const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=v=>typeof v==='string'&&DATE.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const amount=v=>{if(typeof v!=='number'&&!(typeof v==='string'&&/^\d+(\.\d{1,2})?$/.test(v)))return null;const n=Number(v);return Number.isFinite(n)&&n>0&&n<=10000000?n:null};
/** Explicit dated public ads only; schedules and missing/invalid returns are not prices. */
export function normalizeFlydubaiFares(rows,{origin,destination,sourceUrl,checkedAt}){
 const u=new URL(sourceUrl);if(u.protocol!=='https:'||u.hostname!=='www.flydubai.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/en-[a-z]{2}\/flights-(from|to)-[a-z-]+\/$/.test(u.pathname))throw Error('Unapproved official page');
 if(!/^[A-Z]{3}$/.test(origin)||!/^[A-Z]{3}$/.test(destination)||origin===destination||!Number.isFinite(Date.parse(checkedAt))||!Array.isArray(rows)||rows.length>500)throw Error('Invalid snapshot');
 const fares=[];for(const r of rows){if(!r||r.origin!==origin||r.destination!==destination||r.type!=='OWRT'||!/^[A-Z]{3}$/.test(r.currency))continue;
 const out=amount(r.owAmount);if(out!==null&&validDate(r.owDepartureDate))fares.push({origin,destination,departDate:r.owDepartureDate,returnDate:null,amount:out,currency:r.currency,structure:'oneway',sourceUrl,checkedAt,pricing:'published_advertisement'});
 const rt=amount(r.amount);if(rt!==null&&validDate(r.departureDate)&&validDate(r.returnDate)&&r.returnDate>r.departureDate)fares.push({origin,destination,departDate:r.departureDate,returnDate:r.returnDate,amount:rt,currency:r.currency,structure:'roundtrip',sourceUrl,checkedAt,pricing:'published_advertisement'});
 }return [...new Map(fares.map(f=>[JSON.stringify(f),f])).values()];
}
