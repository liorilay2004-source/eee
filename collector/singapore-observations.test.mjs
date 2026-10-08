import {test} from 'node:test';import assert from 'node:assert/strict';import {singaporeObservations} from './singapore-observations.mjs';
const at='2026-10-08T08:00:00Z',row={origin:'SIN',destination:'HND',departureDate:'2027-07-14',returnDate:'2027-07-20',fare:973.6,currency:'SGD',cabinClass:'Y',duration:7};
test('retains actual HND dates and round-trip total rather than city code or inferred duration',()=>{
 const [fare]=singaporeObservations([row,row],at);assert.equal(fare.destination,'HND');assert.equal(fare.returnDate,'2027-07-20');assert.equal(fare.amount,973.6);assert.equal(fare.structure,'roundtrip');assert.equal(singaporeObservations([row,row],at).length,1);
});
test('rejects wrong airports, business fares, past/impossible dates and invalid currency/amount',()=>{
 const invalid=[{...row,destination:'TYO'},{...row,origin:'TLV'},{...row,cabinClass:'J'},{...row,departureDate:'2027-02-30'},{...row,departureDate:'2026-01-01'},{...row,returnDate:row.departureDate},{...row,fare:-1},{...row,currency:'points'}];assert.deepEqual(singaporeObservations(invalid,at),[]);
});
