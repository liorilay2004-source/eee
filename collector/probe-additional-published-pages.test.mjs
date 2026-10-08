import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {additionalPublishedPages,collectAdditionalPublishedPages,normalizeAdditionalAdvertisements} from './probe-additional-published-pages.mjs';
const provider='korean_air',page=additionalPublishedPages(provider)[0],checkedAt='2026-10-08T12:00:00.000Z';
const row={__typename:'Fare',originAirportCode:'LAX',destinationAirportCode:'ICN',departureDate:'2027-08-17',returnDate:'2027-08-24',totalPrice:1865.19,currencyCode:'USD',flightType:'ROUND_TRIP',travelClass:'Y',farenetTravelClass:'ECONOMY',formattedTravelClass:'Economy Class',promoCode:'',redemption:null};
const html=rows=>`<script id="__NEXT_DATA__">${JSON.stringify({rows})}</script>`;
async function temporary(fn){const folder=await mkdtemp(resolve(tmpdir(),'eee-additional-test-'));try{await fn(folder);}finally{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));await rm(folder,{recursive:true,force:true});}}
test('requires actual catalog pages and rejects reward, unknown cabin, invalid dates and prices',()=>{
 const q={provider,page,checkedAt};
 assert.equal(normalizeAdditionalAdvertisements([row,row],q).length,1);
 for(const patch of [{promoCode:'MEMBER'},{promoCode:undefined},{redemption:undefined},{redemption:true},{travelClass:'BUSINESS'},
  {totalPrice:0},{currencyCode:'usd'},{departureDate:'2027-02-30'},{originAirportCode:'TLV'},{returnDate:null}])assert.deepEqual(normalizeAdditionalAdvertisements([{...row,...patch}],q),[]);
 assert.throws(()=>normalizeAdditionalAdvertisements([row],{...q,page:page+'?api_key=bad'}));
 assert.throws(()=>additionalPublishedPages('unknown'));
});
test('publishes raw records immediately and verifies independently parsed original count and capture',async()=>temporary(async folder=>{
 const calls=[],key='a'.repeat(64);
 const fetchFn=async(url,options)=>{calls.push({url,options});if(url===page)return new Response(html([row]));const body=JSON.parse(options.body);assert.deepEqual(body.records,[row]);return Response.json({fares:1,checkedAt:body.checkedAt});};
 const result=await collectAdditionalPublishedPages({provider,key,outputDirectory:folder,fetchFn,now:()=>new Date(checkedAt)});
 assert.equal(result[0].publication.published,1);assert.equal(result[0].checkedAt,checkedAt);
 assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[1].options.headers.Authorization,`Bearer ${key}`);
 assert.equal(calls[1].url,'https://eee-api.liorilay2004.workers.dev/api/internal/public-fares');assert.equal(calls[1].options.redirect,'manual');
 assert.equal(JSON.parse(await readFile(resolve(folder,`${provider}-published-observations.json`),'utf8'))[0].publication.checkedAt,checkedAt);
}));
test('preserves captured raw data on receipt mismatch and never publishes an empty challenge extraction',async()=>temporary(async folder=>{
 const result=await collectAdditionalPublishedPages({provider,key:'a'.repeat(64),outputDirectory:folder,now:()=>new Date(checkedAt),fetchFn:async(url)=>url===page?new Response(html([row])):Response.json({fares:2,checkedAt})});
 assert.equal(result[0].error,'Ingestion receipt mismatch');assert.deepEqual(result[0].records,[row]);
 let calls=0;const empty=await collectAdditionalPublishedPages({provider,key:'a'.repeat(64),outputDirectory:folder,fetchFn:async()=>{calls++;return new Response('<html>challenge</html>');}});
 assert.equal(calls,1);assert.equal(empty[0].error,'No explicit published Fare records');
}));
test('transport failures cannot leak the collector credential into checkpoints',async()=>temporary(async folder=>{
 const key='b'.repeat(64);
 const rows=await collectAdditionalPublishedPages({provider,key,outputDirectory:folder,fetchFn:async(url)=>{if(url===page)return new Response(html([row]));throw new Error(`transport ${key}`);}});
 assert.equal(rows[0].error,'Collector request failed');
 assert.equal((await readFile(resolve(folder,`${provider}-published-observations.json`),'utf8')).includes(key),false);
}));
test('nonempty malformed Fare records cannot clear a previously valid snapshot',async()=>temporary(async folder=>{
 let calls=0;
 const rows=await collectAdditionalPublishedPages({provider,key:'a'.repeat(64),outputDirectory:folder,fetchFn:async()=>{calls++;return new Response(html([{...row,travelClass:undefined}]));}});
 assert.equal(calls,1);assert.equal(rows[0].error,'No validated cash economy fares');
 assert.equal(rows[0].records.length,1);assert.equal(rows[0].publication,undefined);
}));
