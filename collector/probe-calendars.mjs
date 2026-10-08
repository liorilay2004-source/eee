import {writeFile} from 'node:fs/promises';

// Approved public calendar contracts already consumed by the production providers.
const targets = [
  ...['ATH/FCO', 'FCO/ATH'].map(route => ({source:'ryanair', url:`https://services-api.ryanair.com/farfnd/v4/oneWayFares/${route}/cheapestPerDay?outboundMonthOfDate=2027-06-01&currency=EUR`})),
  ...['BEG/ATH', 'ATH/BEG'].map(route => ({source:'air_serbia', url:`https://www.airserbia.com/api/destination/flight-prices/${route}?year=2027&month=6&pos=GLOBAL`})),
];
const results=[];
for (const target of targets) {
  const checkedAt=new Date().toISOString();
  try {
    const response=await fetch(target.url,{headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(response.status!==200)throw new Error(`HTTP ${response.status}`);
    const reader=response.body.getReader();let size=0;const chunks=[];
    try {for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>100000){await reader.cancel();throw new Error('Response too large');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(process.env.COLLECTOR_KEY){
      if(!/^[a-f0-9]{64}$/.test(process.env.COLLECTOR_KEY))throw new Error('Invalid collector configuration');
      const route=new URL(target.url).pathname.split('/');
      const origin=route[4],destination=route[5];
      const published=await fetch('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.COLLECTOR_KEY}`},body:JSON.stringify({source:target.source,page:target.url,origin,destination,month:'2027-06',checkedAt,body}),signal:AbortSignal.timeout(15000)});
      if(!published.ok)throw new Error(`Ingestion HTTP ${published.status}`);
      const accepted=await published.json();console.log(JSON.stringify({source:target.source,publishedFares:accepted.fares,checkedAt:accepted.checkedAt}));
    }
    const result={...target,checkedAt,status:200,body};results.push(result);
    console.log(JSON.stringify({source:target.source,url:target.url,status:200,bytes:size,checkedAt}));
  } catch(error) {
    results.push({...target,checkedAt,error:String(error.message)});
    console.error(JSON.stringify({source:target.source,url:target.url,error:String(error.message)}));
    process.exitCode=1;
  }
}
await writeFile('calendar-probe.json',JSON.stringify(results,null,2));
