/** Publish raw upstream records, verifying the server's independently parsed count. */
export async function publishPageObservation(observation,key,fetchFn=fetch){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw new Error('Invalid collector configuration');
 const {airline,page,checkedAt,records,expectedFares}=observation;
 if(!Array.isArray(records)||records.length>500||!Number.isSafeInteger(expectedFares)||expectedFares<0)throw new Error('Invalid observation');
 const body=JSON.stringify({source:'published_page',airline,page,checkedAt,records,clearIfNoPrices:true});
 if(Buffer.byteLength(body)>128000)throw new Error('Payload size limit');
 const response=await fetchFn('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Object.assign(new Error(`Ingestion HTTP ${response.status}`),{fatal:[401,403].includes(response.status)});
 const result=await response.json();
 if(result.fares!==expectedFares||result.checkedAt!==checkedAt)throw new Error('Ingestion receipt mismatch');
 return {published:result.fares,checkedAt:result.checkedAt};
}
