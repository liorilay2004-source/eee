import {test} from 'node:test';import assert from 'node:assert/strict';import {frontierSnapshot} from './frontier-snapshot.mjs';
const at='2026-10-08T09:00:00.000Z',url='https://flights.flyfrontier.com/en/flights-from-denver-to-phoenix';
const fare={__typename:'Fare',travelClass:'ECONOMY',originAirportCode:'DEN',destinationAirportCode:'PHX',departureDate:'2027-01-05',returnDate:'',flightType:'ONE_WAY',totalPrice:18.98,currencyCode:'USD'};
const row={finalUrl:url,checkedAt:at,records:[fare]};
test('indexes original prices and times without turning one-way into round-trip',()=>{
 const result=frontierSnapshot([row],new Date(at));assert.equal(result.fresh.length,1);assert.equal(result.fresh[0].checkedAt,at);assert.equal(result.byRoute['DEN:PHX'][0].structure,'oneway');assert.equal(result.fresh[0].returnDate,null);
});
test('merging does not extend expiry and newer observations replace older page snapshots',()=>{
 const expired=frontierSnapshot([row],new Date(Date.parse(at)+600000));assert.equal(expired.observations.length,1);assert.equal(expired.fresh.length,0);
 const newer={...row,checkedAt:'2026-10-08T09:01:00.000Z',records:[{...fare,totalPrice:25.98}]};
 const result=frontierSnapshot([newer,row],new Date(newer.checkedAt));assert.equal(result.fresh.length,1);assert.equal(result.fresh[0].amount,25.98);assert.equal(result.fresh[0].checkedAt,newer.checkedAt);
});
test('rejects future, unofficial, member, malformed and failed observations',()=>{
 const result=frontierSnapshot([{...row,checkedAt:'2026-10-09T00:00:00Z'},{...row,finalUrl:'https://evil.test/'},{...row,error:'HTTP 502'},{...row,records:[{...fare,travelClass:'Discount Den'}]}],new Date(at));assert.equal(result.observations.length,0);
});
