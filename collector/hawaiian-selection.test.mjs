import {test} from 'node:test';import assert from 'node:assert/strict';import {selectHawaiianPages} from './hawaiian-selection.mjs';
const a='https://asha.hawaiianairlines.com/en/flights-from-honolulu',b='https://asha.hawaiianairlines.com/en/flights-from-seattle',rows=[a,b].map(url=>({url,observedOn:a}));
test('selects only observed failed pages or bounded batches',()=>{assert.deepEqual(selectHawaiianPages(rows,JSON.stringify([b])),[b]);assert.deepEqual(selectHawaiianPages(rows,null,0,1),[a]);});
test('rejects invented URLs, duplicates and malformed selections',()=>{for(const value of ['["https://evil.test"]',JSON.stringify([a,a]),'{}','[]'])assert.throws(()=>selectHawaiianPages(rows,value));});
