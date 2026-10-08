export async function publishHawaiianObservation(observation,key,fetchFn=fetch){
 if(!/^[a-f0-9]{64}$/.test(key??''))throw new Error('Invalid collector configuration');
 if(!Array.isArray(observation.fares)||!observation.fares.length)return {published:0,reason:'no_valid_prices'};
 const body=JSON.stringify({source:'hawaiian_page',page:observation.page,checkedAt:observation.fetchedAt,records:observation.records});
 if(Buffer.byteLength(body)>128000)throw new Error('Payload size limit');
 const response=await fetchFn('https://eee-api.liorilay2004.workers.dev/api/internal/public-fares',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Object.assign(new Error(`Ingestion HTTP ${response.status}`),{fatal:[401,403].includes(response.status)});
 const result=await response.json();
 if(result.fares!==observation.fares.length||result.checkedAt!==observation.fetchedAt)throw new Error('Ingestion receipt mismatch');
 return {published:result.fares,checkedAt:result.checkedAt};
}
