/** Airport pairs must be explicitly present in upstream records, never inferred from city slugs. */
export function observedPairs(records){
 const pairs=new Map();
 for(const record of records){const origin=record?.originAirportCode,destination=record?.destinationAirportCode;
  if(typeof origin==='string'&&typeof destination==='string'&&/^[A-Z]{3}$/.test(origin)&&/^[A-Z]{3}$/.test(destination)&&origin!==destination)pairs.set(`${origin}:${destination}`,{origin,destination});
 }
 return [...pairs.values()];
}
