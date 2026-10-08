import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishPages} from './publish-pages.mjs';
test('continues after missing prices and checkpoints each attempted page',async()=>{
 const snapshots=[];
 const rows=await publishPages(['a','b','c'],async page=>{if(page==='b')throw new Error('No explicit public prices');return {checkedAt:'original',fares:1};},async rows=>snapshots.push(structuredClone(rows)));
 assert.deepEqual(rows.map(row=>row.ok),[true,false,true]);
 assert.deepEqual(snapshots.map(rows=>rows.length),[1,2,3]);
 assert.equal(rows[2].result.checkedAt,'original');
});
test('stops on credentials failure without attempting later pages',async()=>{
 const attempted=[];
 await assert.rejects(publishPages(['a','b'],async page=>{attempted.push(page);throw Object.assign(new Error('Ingestion HTTP 401'),{fatal:true});},async()=>{}));
 assert.deepEqual(attempted,['a']);
});
