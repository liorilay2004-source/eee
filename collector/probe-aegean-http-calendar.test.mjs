import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {aegeanHttpCalendarUrl,parseAegeanHttpCalendar} from './aegean-http-calendar.mjs';
import {collectAegeanHttpCalendar,publishAegeanHttpCalendar} from './probe-aegean-http-calendar.mjs';
const trip={origin:'TLV',destination:'ATH',departDate:'2027-06-01',returnDate:'2027-06-05'};
const checkedAt='2026-10-08T11:51:10.694Z';
const date=value=>JSON.stringify(`/Date(${Date.parse(value)})/`);
const row=(day,price)=>({Date:date(day),FullPrice:price,Price:price,Class:'Economy',Difference:null,Error:null,Updated:date('2026-10-07'),ServiceFee:0});
const records=()=>({Outbound:[row(trip.departDate,104.63)],Inbound:[row(trip.returnDate,127.74)],CurrencySymbol:'€'});
const snapshot=()=>({trip,page:aegeanHttpCalendarUrl(trip),checkedAt,records:records()});
async function directory(t){
 const prefix=resolve(tmpdir(),'eee-aegean-http-test-'),dir=await mkdtemp(prefix);
 if(!dir.startsWith(resolve(tmpdir())+sep+'eee-aegean-http-test-'))throw Error('Unexpected test directory');
 t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}

test('publishes verbatim context and timestamp only after selected cash price validation',async()=>{
 let payload;const original=snapshot();
 const receipt=await publishAegeanHttpCalendar(original,'a'.repeat(64),async(url,options)=>{
  assert.equal(url,'https://eee-api.liorilay2004.workers.dev/api/internal/public-fares');
  payload=JSON.parse(options.body);return Response.json({fares:1,checkedAt});
 });
 assert.deepEqual(receipt,{published:1,checkedAt});assert.equal(payload.source,'aegean_http_calendar');assert.deepEqual(payload.records,original.records);assert.deepEqual(payload.trip,trip);assert.equal(payload.checkedAt,checkedAt);assert.equal(payload.clearIfNoPrices,undefined);
 assert.equal(parseAegeanHttpCalendar(original.records,trip,checkedAt).amount,232.37);
});

test('invalid schemas, bounds, credentials and changed receipts cannot publish or clear',async()=>{
 const missing=snapshot();missing.records.Outbound=[];
 await assert.rejects(publishAegeanHttpCalendar(missing,'a'.repeat(64)),/No validated/);
 await assert.rejects(publishAegeanHttpCalendar({...snapshot(),page:'https://example.com'},'a'.repeat(64)),/No validated/);
 await assert.rejects(publishAegeanHttpCalendar(snapshot(),'bad'),/configuration/);
 await assert.rejects(publishAegeanHttpCalendar(snapshot(),'a'.repeat(64),async()=>Response.json({fares:0,checkedAt})),/receipt mismatch/);
 await assert.rejects(publishAegeanHttpCalendar(snapshot(),'a'.repeat(64),async()=>Response.json({fares:1,checkedAt:'2026-10-08T12:00:00.000Z'})),/receipt mismatch/);
 const oversized=snapshot();oversized.records.unrelated='x'.repeat(128000);await assert.rejects(publishAegeanHttpCalendar(oversized,'a'.repeat(64)),/size limit/);
 for(const status of [401,403])await assert.rejects(publishAegeanHttpCalendar(snapshot(),'a'.repeat(64),async()=>new Response('',{status})),error=>error.fatal===true);
});

test('captures before fetch, publishes only one contextual offer, and checkpoints original data',async t=>{
 const outputDirectory=await directory(t);let calls=0;
 const results=await collectAegeanHttpCalendar({trips:[trip],key:'a'.repeat(64),outputDirectory,now:()=>new Date(checkedAt),log:()=>{},fetchFn:async(_url,options)=>{
  calls++;return options.method==='POST'?Response.json({fares:1,checkedAt}):Response.json(records());
 }});
 assert.equal(calls,2);assert.equal(results.length,1);assert.equal(results[0].checkedAt,checkedAt);assert.equal(results[0].fare.amount,232.37);assert.deepEqual(results[0].records,records());
 const saved=JSON.parse(await readFile(resolve(outputDirectory,'aegean-http-calendar-observations.json'),'utf8'));assert.equal(saved[0].publication.published,1);assert.equal(saved[0].fare.outboundUpdatedAt,'2026-10-07T00:00:00.000Z');
});

test('auth failure checkpoints and stops while missing prices permit later trips',async t=>{
 const outputDirectory=await directory(t),second={...trip,departDate:'2027-06-02'};let gets=0;
 await assert.rejects(collectAegeanHttpCalendar({trips:[trip,second],key:'a'.repeat(64),outputDirectory,now:()=>new Date(checkedAt),log:()=>{},fetchFn:async(_url,options)=>{
  if(options.method==='POST')return new Response('',{status:401});gets++;return Response.json(records());
 }}),error=>error.fatal===true);
 assert.equal(gets,1);const saved=JSON.parse(await readFile(resolve(outputDirectory,'aegean-http-calendar-observations.json'),'utf8'));assert.match(saved[0].error,/401/);assert.equal(saved[0].checkedAt,checkedAt);
 gets=0;let posts=0;
 const results=await collectAegeanHttpCalendar({trips:[trip,second],key:'a'.repeat(64),outputDirectory,now:()=>new Date(checkedAt),log:()=>{},fetchFn:async(_url,options)=>{
  if(options.method==='POST'){posts++;return Response.json({fares:1,checkedAt});}
  gets++;return Response.json(gets===1?{...records(),Outbound:[]}:{...records(),Outbound:[row(second.departDate,58.52)]});
 }});
 assert.equal(gets,2);assert.equal(posts,1);assert.match(results[0].error,/No validated/);assert.equal(results[1].publication.published,1);
});

test('unsupported or duplicate routes fail before an upstream request',async t=>{
 const outputDirectory=await directory(t);
 for(const trips of [[],[trip,trip],[{...trip,origin:'JFK'}],Array(13).fill(trip)])await assert.rejects(collectAegeanHttpCalendar({trips,outputDirectory,fetchFn:()=>{throw Error('Unexpected fetch');}}));
});
