import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectByHost} from './host-queue.mjs';
test('bounds concurrent hosts and keeps each host sequential',async()=>{
 const pages=['a','b','c','a','b'].map((host,index)=>({sourceUrl:`https://${host}.example/${index}`}));
 const active=new Set(),seen=[];let peak=0;
 await collectByHost(pages,async page=>{
  const host=new URL(page.sourceUrl).host;assert.equal(active.has(host),false);active.add(host);peak=Math.max(peak,active.size);
  await new Promise(resolve=>setTimeout(resolve,5));seen.push(page.sourceUrl);active.delete(host);
 },2);
 assert.equal(peak,2);assert.equal(new Set(seen).size,5);assert.ok(seen.indexOf(pages[0].sourceUrl)<seen.indexOf(pages[3].sourceUrl));
});
test('rejects invalid concurrency and handles no pages',async()=>{
 await assert.rejects(collectByHost([],()=>{},0));await collectByHost([],()=>assert.fail());
});
