import {test} from 'node:test';import assert from 'node:assert/strict';import {frontierBatch} from './frontier-batch.mjs';
test('partitions all 1862 routes without dropping or duplicating rows',()=>{
 const rows=Array.from({length:1862},(_,id)=>({id,url:`https://flights.flyfrontier.com/en/flights-from-city-${id}-to-another`}));
 const parts=[];for(let offset=0;offset<rows.length;offset+=60)parts.push(...frontierBatch(rows,offset));
 assert.deepEqual(parts,rows);assert.equal(frontierBatch(rows,1860).length,2);
});
test('prioritizes only observed reverse routes without fabricating missing ones',()=>{
 const rows=[{url:'other'},{url:'https://flights.flyfrontier.com/en/flights-from-phoenix-to-denver'}];
 assert.deepEqual(frontierBatch(rows),[rows[1],rows[0]]);assert.deepEqual(frontierBatch([{url:'other'}]),[{url:'other'}]);
});
test('rejects invalid or oversized batch controls',()=>{
 for(const [offset,limit] of [[-1,60],[0,61],[0,0],[0,1.5],[NaN,60],[2,60]])assert.throws(()=>frontierBatch([{}],offset,limit));
 assert.throws(()=>frontierBatch(Array(2501).fill({})));
});
