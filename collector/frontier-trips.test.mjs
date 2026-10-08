import {test} from 'node:test';import assert from 'node:assert/strict';import {frontierTrips} from './frontier-trips.mjs';
const at='2026-10-08T09:00:00Z',q={origin:'DEN',destination:'PHX',departDate:'2027-01-05',returnDate:'2027-01-10'};
const out={airline:'F9',origin:'DEN',destination:'PHX',departDate:q.departDate,returnDate:null,structure:'oneway',amount:18.98,currency:'USD',checkedAt:at};
const back={...out,origin:'PHX',destination:'DEN',departDate:q.returnDate,amount:25.98,checkedAt:'2026-10-08T09:01:00Z'};
const snapshot=(a=out,b=back)=>({byRoute:{'DEN:PHX':[a],'PHX:DEN':[b]}});
test('combines only exact observed dates and retains the older capture time',()=>{
 const [trip]=frontierTrips(snapshot(),q,new Date(back.checkedAt));assert.equal(trip.amount,44.96);assert.equal(trip.checkedAt,at);assert.equal(trip.structure,'split');assert.equal(trip.checkoutVerified,false);assert.equal(trip.ancillaryFeesKnown,false);
});
test('does not use missing returns, nearby dates, different currencies or same-day holidays',()=>{
 const now=new Date(back.checkedAt);assert.deepEqual(frontierTrips({byRoute:{'DEN:PHX':[out]}},q,now),[]);
 assert.deepEqual(frontierTrips(snapshot(out,{...back,departDate:'2027-01-11'}),q,now),[]);
 assert.deepEqual(frontierTrips(snapshot(out,{...back,currency:'EUR'}),q,now),[]);
 assert.throws(()=>frontierTrips(snapshot(),{...q,returnDate:q.departDate},now));
 assert.throws(()=>frontierTrips(snapshot(),{...q,adults:2},now));
 assert.throws(()=>frontierTrips(snapshot(),{...q,children:1},now));
});
test('rechecks freshness when using an earlier built index',()=>{
 assert.deepEqual(frontierTrips(snapshot(),q,new Date(Date.parse(at)+600000)),[]);
 assert.deepEqual(frontierTrips(snapshot(),q,new Date(Date.parse(at)-1)),[]);
});
