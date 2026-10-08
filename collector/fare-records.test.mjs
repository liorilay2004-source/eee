import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fareRecords} from './fare-records.mjs';
test('extracts upstream fare records without unrelated page configuration',()=>{
 const fare={__typename:'Fare',totalPrice:42};assert.deepEqual(fareRecords(`<script id="__NEXT_DATA__">${JSON.stringify({config:{irrelevant:'value'},nested:[fare]})}</script>`),[fare]);assert.deepEqual(fareRecords('<html></html>'),[]);
});
test('bounds extracted records',()=>assert.throws(()=>fareRecords(`<script id="__NEXT_DATA__">${JSON.stringify(Array(501).fill({__typename:'Fare'}))}</script>`)));
