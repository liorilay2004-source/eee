import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observedPairs} from './observed-pairs.mjs';
test('uses explicit airport codes and preserves direction without city inference',()=>{
 const pair={originAirportCode:'TLV',destinationAirportCode:'EWR'};
 assert.deepEqual(observedPairs([pair,pair,{originAirportCode:'EWR',destinationAirportCode:'TLV'},null,{originAirportCode:'TLV',destinationAirportCode:'TLV'},{originAirportCode:'Tel Aviv',destinationAirportCode:'New York'}]),[{origin:'TLV',destination:'EWR'},{origin:'EWR',destination:'TLV'}]);
});
