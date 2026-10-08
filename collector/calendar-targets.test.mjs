import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarTargets} from './calendar-targets.mjs';
test('collects both directions and keeps source URL month aligned',()=>{
  const targets=calendarTargets();assert.equal(targets.length,8);
  for(const target of targets){const url=new URL(target.url);if(target.source==='ryanair')assert.equal(url.searchParams.get('outboundMonthOfDate'),`${target.month}-01`);else{assert.equal(url.searchParams.get('year'),target.month.slice(0,4));assert.equal(Number(url.searchParams.get('month')),Number(target.month.slice(5)));}}
});
test('rejects malformed months and deduplicates',()=>{
  for(const months of [['2027-13'],['2027-6'],['https://example.com'],[null],Array(13).fill('2027-06')])assert.throws(()=>calendarTargets(months));
  assert.equal(calendarTargets(['2027-06','2027-06']).length,4);
});
