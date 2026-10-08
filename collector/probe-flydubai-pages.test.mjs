import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeFlydubaiPages} from './probe-flydubai-pages.mjs';
const page='https://www.flydubai.com/en-ae/flights-to-tbilisi/';
const second='https://www.flydubai.com/en-ae/flights-to-male/';
const checkedAt='2026-10-08T11:00:00.123Z';
const pair={origin:'DXB',destination:'TBS',sourceUrl:page};
const raw={origin:'DXB',destination:'TBS',currency:'AED',type:'OWRT',amount:1732,departureDate:'2026-10-13',returnDate:'2026-10-17',owDepartureDate:'2026-10-13',owAmount:'840.00'};
const html=data=>new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{Props:{Data:data}}}})}</script>`);
const config=(org='DXB',dest='TBS')=>({apiParams:{org,dest,type:'OWRT'}});
const options=()=>({inventory:[{url:page,observedOn:page}],approved:[pair],key:'a'.repeat(64),approvedOnly:true,now:()=>new Date(checkedAt),log:()=>{}});

test('aggregates every approved pair and publishes once with oldest original capture',async()=>{
 let posts=0,posted;let clock=0;
 const result=await probeFlydubaiPages({...options(),approved:[pair,{origin:'TBS',destination:'DXB',sourceUrl:page}],now:()=>new Date(Date.parse(checkedAt)+clock++*1000),fetchFn:async(url,init)=>{
  if(init.method==='POST'){posts++;posted=JSON.parse(init.body);return Response.json({fares:4,checkedAt:posted.checkedAt});}
  const target=new URL(url);if(target.pathname.endsWith('lowfare/'))return Response.json(target.searchParams.get('org')==='DXB'?[raw]:[{...raw,origin:'TBS',destination:'DXB',owAmount:360}]);
  return html([{seofaremonthlycardtabs:{data:[config(),config('TBS','DXB')]}}]);
 }});
 assert.equal(result.failed,false);assert.equal(posts,1);assert.equal(posted.records.length,2);assert.equal(posted.checkedAt,checkedAt);assert.equal(result.results.filter(row=>row.publication).length,1);
});

test('explicit null or inline empty schema can clear; missing schema cannot',async()=>{
 for(const data of [[{seofaremonthlycardtabs:{data:[config()]}}],[{seofarewithoutimage:{data:[]}}]]){
  let posted;
  const result=await probeFlydubaiPages({...options(),fetchFn:async(url,init)=>{
   if(init.method==='POST'){posted=JSON.parse(init.body);return Response.json({fares:0,checkedAt});}
   return new URL(url).pathname.endsWith('lowfare/')?Response.json(null):html(data);
  }});
  assert.equal(result.failed,false);assert.deepEqual(posted.records,[]);assert.equal(posted.clearIfNoPrices,true);
 }
 let posts=0;
 const missing=await probeFlydubaiPages({...options(),fetchFn:async(_url,init)=>{if(init.method==='POST')posts++;return html([]);}});
 assert.equal(missing.failed,true);assert.equal(posts,0);assert.match(missing.results.at(-1).error,/No explicit price schema/);
});

test('unapproved diagnostics do not publish; incomplete approved API coverage does not clear',async()=>{
 let posts=0;
 const result=await probeFlydubaiPages({...options(),inventory:[{url:page,observedOn:page},{url:second,observedOn:page}],approvedOnly:false,fetchFn:async(url,init)=>{
  if(init.method==='POST'){posts++;return Response.json({fares:2,checkedAt});}
  return new URL(url).pathname.endsWith('lowfare/')?Response.json([raw]):html([{seofaremonthlycardtabs:{data:[config()]}}]);
 }});
 assert.equal(result.failed,false);assert.equal(posts,1);
 const incomplete=await probeFlydubaiPages({...options(),approved:[pair,{origin:'TBS',destination:'DXB',sourceUrl:page}],fetchFn:async(url,init)=>{
  if(init.method==='POST'){posts++;throw Error('Unexpected publication');}
  return new URL(url).pathname.endsWith('lowfare/')?Response.json([raw]):html([{seofaremonthlycardtabs:{data:[config()]}}]);
 }});
 assert.equal(incomplete.failed,true);assert.match(incomplete.results.at(-1).error,/Incomplete approved configuration/);assert.equal(posts,1);
});

test('page failures continue but authorization failure checkpoints and stops',async()=>{
 const inventory=[{url:page,observedOn:page},{url:second,observedOn:page}];
 const approved=[pair,{origin:'DXB',destination:'MLE',sourceUrl:second}];
 let gets=0,checkpoints=0;
 const failed=await probeFlydubaiPages({...options(),inventory,approved,checkpoint:async()=>{checkpoints++;},fetchFn:async(url,init)=>{
  if(init.method==='POST')return new Response('',{status:500});
  gets++;return html([{seofarewithoutimage:{data:[]}}]);
 }});
 assert.equal(failed.failed,true);assert.equal(gets,2);assert.equal(checkpoints,2);
 gets=0;checkpoints=0;
 await assert.rejects(probeFlydubaiPages({...options(),inventory,approved,checkpoint:async rows=>{checkpoints++;assert.match(rows.at(-1).error,/HTTP 401/);},fetchFn:async(_url,init)=>{
  if(init.method==='POST')return new Response('',{status:401});
  gets++;return html([{seofarewithoutimage:{data:[]}}]);
 }}),error=>error.fatal===true);
 assert.equal(gets,1);assert.equal(checkpoints,1);
});

test('bounds or invalid configuration fail before fetching and malformed schemas do not publish',async()=>{
 for(const changed of [{offset:-1},{limit:21},{key:'invalid'},{key:undefined},{approved:[]}])await assert.rejects(probeFlydubaiPages({...options(),...changed,fetchFn:()=>{throw Error('Unexpected fetch');}}));
 for(const data of [[{seofarewithoutimage:{data:{}}}],[{seofaremonthlycardtabs:{data:[config()]}}]]){
  let posts=0;
  const result=await probeFlydubaiPages({...options(),fetchFn:async(url,init)=>{
   if(init.method==='POST')posts++;
   return new URL(url).pathname.endsWith('lowfare/')?Response.json({error:'no_prices'}):html(data);
  }});
  assert.equal(result.failed,true);assert.equal(posts,0);
 }
});
