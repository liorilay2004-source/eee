/** Stable, bounded batches preserve every actually observed URL exactly once. */
export function frontierBatch(rows,offset=0,limit=60){
 if(!Array.isArray(rows)||rows.length>2500||!Number.isInteger(offset)||offset<0||offset>rows.length||!Number.isInteger(limit)||limit<1||limit>60)throw new Error('Invalid Frontier batch');
 const priority=new Set(['https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix','https://flights.flyfrontier.com/en/flights-from-phoenix-to-denver']);
 const ordered=[...rows.filter(r=>priority.has(r.url)),...rows.filter(r=>!priority.has(r.url))];
 return ordered.slice(offset,offset+limit);
}
