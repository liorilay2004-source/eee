import {test} from 'node:test';import assert from 'node:assert/strict';import {publishHawaiianObservation} from './publish-hawaiian-observation.mjs';
const row={page:'https://asha.hawaiianairlines.com/en/flights-from-honolulu',fetchedAt:'2026-10-08T10:00:00.000Z',records:[{totalPrice:340}],fares:[{amount:340}]};
test('publishes raw records with original timestamp and validates receipt',async()=>{
 let request;
 const receipt=await publishHawaiianObservation(row,'a'.repeat(64),async(url,options)=>{request={url,options};return Response.json({fares:1,checkedAt:row.fetchedAt});});
 assert.equal(receipt.published,1);assert.deepEqual(JSON.parse(request.options.body),{source:'hawaiian_page',page:row.page,checkedAt:row.fetchedAt,records:row.records});
});
test('does not post empty prices and rejects mismatched or unauthorized receipts',async()=>{
 assert.deepEqual(await publishHawaiianObservation({...row,fares:[]},'a'.repeat(64),()=>{throw new Error('must not fetch');}),{published:0,reason:'no_valid_prices'});
 await assert.rejects(publishHawaiianObservation(row,'a'.repeat(64),async()=>Response.json({fares:0,checkedAt:row.fetchedAt})));
 await assert.rejects(publishHawaiianObservation(row,'a'.repeat(64),async()=>new Response('',{status:401})),error=>error.fatal===true);
});
