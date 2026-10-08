import {test} from 'node:test';import assert from 'node:assert/strict';import {publishPageObservation} from './publish-page-observation.mjs';
const row={airline:'KC',page:'https://bestfares.airastana.com/en-kz/flights-from-almaty',checkedAt:'2026-10-08T10:00:00.000Z',records:[],expectedFares:0};
test('sends original raw snapshot and accepts an explicit empty receipt',async()=>{
 let payload;const receipt=await publishPageObservation(row,'a'.repeat(64),async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({fares:0,checkedAt:row.checkedAt});});assert.equal(payload.clearIfNoPrices,true);assert.equal(payload.checkedAt,row.checkedAt);assert.equal(receipt.published,0);
});
test('rejects changed capture times, mismatched counts and invalid credentials',async()=>{
 await assert.rejects(publishPageObservation(row,'a'.repeat(64),async()=>Response.json({fares:0,checkedAt:'2026-10-08T11:00:00Z'})));
 await assert.rejects(publishPageObservation(row,'a'.repeat(64),async()=>Response.json({fares:1,checkedAt:row.checkedAt})));
 await assert.rejects(publishPageObservation(row,'invalid'));
});
