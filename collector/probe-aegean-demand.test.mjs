import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {AEGEAN_DEMAND_ENDPOINT,collectAegeanDemand} from './probe-aegean-demand.mjs';

const KEY='a'.repeat(64),INGEST='https://eee-api.liorilay2004.workers.dev/api/internal/public-fares';
const checkedAt='2026-10-08T11:51:10.694Z';
const trip={origin:'TLV',destination:'ATH',departDate:'2027-06-01',returnDate:'2027-06-05'};
const second={...trip,departDate:'2027-06-02'},third={...trip,departDate:'2027-06-03'};
const date=value=>JSON.stringify(`/Date(${Date.parse(value)})/`);
const row=(day,price)=>({Date:date(day),FullPrice:price,Price:price,Class:'Economy',Difference:null,Error:null,Updated:date('2026-10-07'),ServiceFee:0});
const records=(selected=trip)=>({Outbound:[row(selected.departDate,104.63)],Inbound:[row(selected.returnDate,127.74)],CurrencySymbol:'€'});
async function directory(t){
 const dir=await mkdtemp(resolve(tmpdir(),'eee-aegean-demand-test-'));
 assert.ok(dir.startsWith(resolve(tmpdir())+sep+'eee-aegean-demand-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
const summary=async dir=>JSON.parse(await readFile(resolve(dir,'aegean-demand-summary.json'),'utf8'));
const observations=async dir=>JSON.parse(await readFile(resolve(dir,'aegean-http-calendar-observations.json'),'utf8'));
function collect(outputDirectory,fetchFn,extra={}){return collectAegeanDemand({key:KEY,outputDirectory,fetchFn,now:()=>new Date(checkedAt),log:()=>{},...extra});}

test('uses the fixed authenticated inventory and claim endpoints, then only selected airline URLs',async t=>{
 const dir=await directory(t),calls=[];
 const results=await collect(dir,async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'manual');assert.ok(options.signal);
  if(url===AEGEAN_DEMAND_ENDPOINT){
   assert.equal(options.headers.Authorization,`Bearer ${KEY}`);
   if(options.method==='GET'){assert.equal(options.body,undefined);return Response.json({trips:[{...trip,email:'discarded',sourceUrl:'https://evil.example'}]});}
   assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(options.body),{trip});return Response.json({claimed:true});
  }
  if(url===INGEST){assert.equal(options.headers.Authorization,`Bearer ${KEY}`);const payload=JSON.parse(options.body);assert.deepEqual(payload.trip,trip);return Response.json({fares:1,checkedAt:payload.checkedAt});}
  assert.match(url,/^https:\/\/en\.aegeanair\.com\/en\/sys\/lowfares\/RouteLowFares\/\?/);
  assert.equal(options.headers.Authorization,undefined);return Response.json(records());
 },{endpoint:'https://evil.example'});
 assert.equal(calls.length,4);assert.equal(results[0].publication.published,1);assert.deepEqual(results[0].trip,trip);
 assert.deepEqual(await summary(dir),{queuedTrips:1,publishedTrips:1,acceptedFares:1,skippedTrips:0,tripErrors:0,status:'succeeded'});
});

test('invalid credentials fail before any fetch',async t=>{
 const dir=await directory(t);let calls=0;
 for(const key of [undefined,'',KEY.toUpperCase(),'bad',KEY+'a'])await assert.rejects(collectAegeanDemand({key,outputDirectory:dir,fetchFn:()=>{calls++;throw Error('Unexpected fetch');}}),/configuration/);
 assert.equal(calls,0);
});

test('zero pending trips is an idle success with an empty checkpoint and zero metrics',async t=>{
 const dir=await directory(t);let calls=0;
 const results=await collect(dir,async(url,options)=>{calls++;assert.equal(url,AEGEAN_DEMAND_ENDPOINT);assert.equal(options.method,'GET');return Response.json({trips:[]});});
 assert.deepEqual(results,[]);assert.equal(calls,1);assert.deepEqual(await observations(dir),[]);
 assert.deepEqual(await summary(dir),{queuedTrips:0,publishedTrips:0,acceptedFares:0,skippedTrips:0,tripErrors:0,status:'idle'});
});

test('declined claims are honest idle success with no airline request or publication',async t=>{
 const dir=await directory(t);let claims=0;
 const results=await collect(dir,async(url,options)=>{
  assert.equal(url,AEGEAN_DEMAND_ENDPOINT);
  if(options.method==='GET')return Response.json({trips:[trip,second]});claims++;return Response.json({claimed:false});
 });
 assert.equal(claims,2);assert.ok(results.every(result=>result.skipped==='claim_declined'&&!result.error&&!result.publication));
 assert.deepEqual(await summary(dir),{queuedTrips:2,publishedTrips:0,acceptedFares:0,skippedTrips:2,tripErrors:0,status:'idle'});
});

test('inventory bounds, duplicates, unsupported routes and invalid or past dates fail before claims',async t=>{
 const dir=await directory(t);
 for(const raw of [null,[],{}, {trips:'bad'},{trips:Array(13).fill(trip)},{trips:[trip,trip]},
  {trips:[{...trip,origin:'JFK'}]},{trips:[{...trip,departDate:'2027-02-30'}]},
  {trips:[{...trip,departDate:'2026-10-07'}]},{trips:[{...trip,returnDate:trip.departDate}]},{trips:[null]}]){
  let calls=0;await assert.rejects(collect(dir,async()=>{calls++;return Response.json(raw);}));assert.equal(calls,1);
  assert.equal((await summary(dir)).status,'failed');assert.deepEqual(await observations(dir),[]);
 }
});

test('strictly bounds inventory bodies and refuses redirects or malformed JSON',async t=>{
 const dir=await directory(t);
 for(const response of [new Response('x'.repeat(10001)),new Response('{bad'),new Response(new Uint8Array([0xff])),new Response('',{status:302}),new Response(null,{status:200})]){
  let calls=0;await assert.rejects(collect(dir,async()=>{calls++;return response;}));assert.equal(calls,1);
 }
});

test('inventory authentication failure stops immediately without upstream collection',async t=>{
 const dir=await directory(t);
 for(const status of [401,403]){
  let calls=0;await assert.rejects(collect(dir,async()=>{calls++;return new Response('',{status});}),error=>error.fatal===true);
  assert.equal(calls,1);assert.equal((await summary(dir)).status,'failed');
 }
});

test('claim receipts must contain a boolean and failure never permits an airline fetch',async t=>{
 const dir=await directory(t);
 for(const receipt of [{claimed:'true'},{},null]){
  let calls=0;const results=await collect(dir,async(url,options)=>{calls++;assert.equal(url,AEGEAN_DEMAND_ENDPOINT);return Response.json(options.method==='GET'?{trips:[trip]}:receipt);});
  assert.equal(calls,2);assert.match(results[0].error,/claim receipt/);assert.equal((await summary(dir)).tripErrors,1);
 }
});

test('retains original capture and source update times through the authenticated publication receipt',async t=>{
 const dir=await directory(t);let current=new Date(checkedAt),published;
 const results=await collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT){if(options.method==='GET')return Response.json({trips:[trip]});current=new Date(current.getTime()+2000);return Response.json({claimed:true});}
  if(url===INGEST){published=JSON.parse(options.body);current=new Date(current.getTime()+1000);return Response.json({fares:1,checkedAt:published.checkedAt});}
  current=new Date(current.getTime()+1000);return Response.json(records());
 },{now:()=>current});
 assert.equal(results[0].checkedAt,checkedAt);assert.equal(results[0].publication.checkedAt,checkedAt);assert.equal(published.checkedAt,checkedAt);
 assert.equal(results[0].fare.outboundUpdatedAt,'2026-10-07T00:00:00.000Z');assert.equal(results[0].fare.fareFoundAt,undefined);
 assert.deepEqual(published.records,records());assert.equal((await observations(dir))[0].checkedAt,checkedAt);
});

test('rejects renewed receipt captures and records the failure with no accepted fare',async t=>{
 const dir=await directory(t);
 const results=await collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT)return Response.json(options.method==='GET'?{trips:[trip]}:{claimed:true});
  if(url===INGEST)return Response.json({fares:1,checkedAt:'2026-10-08T12:00:00.000Z'});
  return Response.json(records());
 });
 assert.match(results[0].error,/receipt mismatch/);assert.equal(results[0].checkedAt,checkedAt);
 assert.deepEqual(await summary(dir),{queuedTrips:1,publishedTrips:0,acceptedFares:0,skippedTrips:0,tripErrors:1,status:'failed'});
});

test('fatal authentication failure checkpoints earlier publications and stops later trips',async t=>{
 const dir=await directory(t);let claims=0,gets=0;
 await assert.rejects(collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT){if(options.method==='GET')return Response.json({trips:[trip,second,third]});claims++;return claims===1?Response.json({claimed:true}):new Response('',{status:401});}
  if(url===INGEST)return Response.json({fares:1,checkedAt});gets++;return Response.json(records());
 }),error=>error.fatal===true);
 assert.equal(claims,2);assert.equal(gets,1);
 const saved=await observations(dir);assert.equal(saved.length,2);assert.equal(saved[0].publication.published,1);assert.match(saved[1].error,/401/);
 assert.deepEqual(await summary(dir),{queuedTrips:3,publishedTrips:1,acceptedFares:1,skippedTrips:0,tripErrors:1,status:'partial'});
});

test('nonfatal missing prices preserve successful later trips and partial metrics',async t=>{
 const dir=await directory(t);let selected;
 const results=await collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT){if(options.method==='GET')return Response.json({trips:[trip,second]});selected=JSON.parse(options.body).trip;return Response.json({claimed:true});}
  if(url===INGEST)return Response.json({fares:1,checkedAt});return Response.json(selected.departDate===trip.departDate?{...records(),Outbound:[]}:records(second));
 });
 assert.match(results[0].error,/No validated/);assert.equal(results[1].publication.published,1);
 assert.deepEqual(await summary(dir),{queuedTrips:2,publishedTrips:1,acceptedFares:1,skippedTrips:0,tripErrors:1,status:'partial'});
});

test('writes a publication checkpoint before waiting on the next claim',async t=>{
 const dir=await directory(t);let unblock,paused;
 const ready=new Promise(resolveReady=>{paused=resolveReady;}),hold=new Promise(resolveHold=>{unblock=resolveHold;});let claims=0;
 const work=collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT){if(options.method==='GET')return Response.json({trips:[trip,second]});if(++claims===2){paused();await hold;return Response.json({claimed:false});}return Response.json({claimed:true});}
  if(url===INGEST)return Response.json({fares:1,checkedAt});return Response.json(records());
 });
 await ready;
 try{const saved=await observations(dir);assert.equal(saved.length,1);assert.equal(saved[0].publication.published,1);assert.equal((await summary(dir)).queuedTrips,2);}finally{unblock();}
 const results=await work;assert.equal(results.length,2);assert.deepEqual(await summary(dir),{queuedTrips:2,publishedTrips:1,acceptedFares:1,skippedTrips:1,tripErrors:0,status:'succeeded'});
});

test('transport errors never put credential-bearing exception text in checkpoints or logs',async t=>{
 const dir=await directory(t),logs=[];
 await assert.rejects(collect(dir,async()=>{throw Error(`private ${KEY}`);},{log:message=>logs.push(message)}),/Demand request failed/);
 const results=await collect(dir,async(url,options)=>{
  if(url===AEGEAN_DEMAND_ENDPOINT)return Response.json(options.method==='GET'?{trips:[trip]}:{claimed:true});
  throw Error(`private ${KEY}`);
 },{log:message=>logs.push(message)});
 assert.match(results[0].error,/Collector request failed/);
 for(const content of [JSON.stringify(await observations(dir)),JSON.stringify(await summary(dir)),JSON.stringify(logs)])assert.ok(!content.includes(KEY));
});
