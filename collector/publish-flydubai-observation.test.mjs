import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedFlydubaiInventory,flydubaiPublicationSnapshot,publishFlydubaiObservation} from './publish-flydubai-observation.mjs';
const page='https://www.flydubai.com/en-ae/flights-to-tbilisi/';
const checkedAt='2026-10-08T11:00:00.123Z';
const pair={origin:'DXB',destination:'TBS',sourceUrl:page};
const raw={origin:'DXB',destination:'TBS',currency:'AED',type:'OWRT',amount:'1732.00',departureDate:'2026-10-13',returnDate:'2026-10-17',owDepartureDate:'2026-10-13',owAmount:'840.00'};
const observation=()=>flydubaiPublicationSnapshot({page,checkedAt,records:[raw]},[pair]);

test('selects only observed approved identities and rejects unsafe or invented pages',()=>{
 const inventory=[{url:page,observedOn:page},{url:'https://www.flydubai.com/en-ae/flights-to-male/',observedOn:page}];
 const selected=approvedFlydubaiInventory(inventory,[pair]);assert.equal(selected.length,1);assert.deepEqual(selected[0].approvedPairs,[pair]);
 for(const changed of [{...pair,origin:'BADCODE'},{...pair,origin:'TBS'},{...pair,sourceUrl:'https://www.flydubai.com/en-ae/flights-to-invented/'},{...pair,sourceUrl:page+'?token=x'},{...pair,sourceUrl:page.replace('www.flydubai.com','example.com')}])assert.throws(()=>approvedFlydubaiInventory(inventory,[changed]));
 assert.throws(()=>approvedFlydubaiInventory([...inventory,inventory[0]],[pair]));
 assert.throws(()=>approvedFlydubaiInventory(inventory,[pair,pair]));
 assert.throws(()=>approvedFlydubaiInventory([{url:page,observedOn:'https://example.com/en-ae/flights-to-tbilisi/'}],[pair]));
});

test('publishes original raw prices and capture with exact receipt verification',async()=>{
 let payload;
 const result=await publishFlydubaiObservation(observation(),'a'.repeat(64),async(url,options)=>{
  assert.equal(url,'https://eee-api.liorilay2004.workers.dev/api/internal/public-fares');
  assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(64));
  payload=JSON.parse(options.body);return Response.json({fares:2,checkedAt});
 });
 assert.deepEqual(result,{published:2,checkedAt});assert.equal(payload.source,'flydubai_page');assert.equal(payload.clearIfNoPrices,true);assert.equal(payload.checkedAt,checkedAt);assert.deepEqual(payload.records,[raw]);assert.equal(payload.origin,'DXB');assert.equal(payload.destination,'TBS');
});

test('counts all approved pairs for one page, deduplicates and permits explicit schema emptiness',async()=>{
 const reverse={origin:'TBS',destination:'DXB',sourceUrl:page};
 const row={...raw,origin:'TBS',destination:'DXB',owAmount:360};
 const snapshot=flydubaiPublicationSnapshot({page,checkedAt,records:[raw,raw,row]},[pair,reverse]);assert.equal(snapshot.expectedFares,4);assert.equal(snapshot.records.length,3);
 const empty=flydubaiPublicationSnapshot({page,checkedAt,records:[]},[pair]);assert.equal(empty.expectedFares,0);
 const result=await publishFlydubaiObservation(empty,'a'.repeat(64),async()=>Response.json({fares:0,checkedAt}));assert.equal(result.published,0);
 assert.throws(()=>flydubaiPublicationSnapshot({page,checkedAt,records:null},[pair]));
 assert.throws(()=>flydubaiPublicationSnapshot({page,checkedAt,records:[{error:'upstream_error'}]},[pair]));
 assert.throws(()=>flydubaiPublicationSnapshot({page,checkedAt,records:[raw]},[{...pair,sourceUrl:'https://www.flydubai.com/en-ae/flights-to-male/'}]));
});

test('rejects changed receipts, bounds and configuration; only authentication is fatal',async()=>{
 await assert.rejects(publishFlydubaiObservation(observation(),'a'.repeat(64),async()=>Response.json({fares:2,checkedAt:'2026-10-08T12:00:00Z'})),/receipt mismatch/);
 await assert.rejects(publishFlydubaiObservation(observation(),'a'.repeat(64),async()=>Response.json({fares:3,checkedAt})),/receipt mismatch/);
 await assert.rejects(publishFlydubaiObservation(observation(),'invalid'),/configuration/);
 await assert.rejects(publishFlydubaiObservation({...observation(),records:Array(501).fill(raw)},'a'.repeat(64)),/observation/);
 await assert.rejects(publishFlydubaiObservation({...observation(),records:[{error:'upstream_error'}],expectedFares:0},'a'.repeat(64)),/observation/);
 await assert.rejects(publishFlydubaiObservation({...observation(),records:[{...raw,large:'x'.repeat(128000)}]},'a'.repeat(64)),/size limit/);
 for(const status of [401,403])await assert.rejects(publishFlydubaiObservation(observation(),'a'.repeat(64),async()=>new Response('',{status})),error=>error.fatal===true);
 await assert.rejects(publishFlydubaiObservation(observation(),'a'.repeat(64),async()=>new Response('',{status:500})),error=>error.fatal===false);
});
