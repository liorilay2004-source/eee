import {test} from 'node:test';import assert from 'node:assert/strict';import {hawaiianIndex,hawaiianTrips} from './hawaiian-trips.mjs';
const now=new Date('2026-10-08T10:00:00Z'),q={origin:'HNL',destination:'LAX',departDate:'2027-01-27',returnDate:'2027-02-03'};
const fare={__typename:'Fare',travelClass:'ECONOMY',originAirportCode:'HNL',destinationAirportCode:'LAX',departureDate:q.departDate,returnDate:'',flightType:'ONE_WAY',totalPrice:135.1,currencyCode:'USD',priceLastSeen:{value:'19',unit:'hours'}};
const row={page:'https://asha.hawaiianairlines.com/en/flights-from-honolulu',fetchedAt:now.toISOString(),records:[fare,{...fare,originAirportCode:'LAX',destinationAirportCode:'HNL',departureDate:q.returnDate,totalPrice:99}]};
test('combines exact dates retaining upstream age and both official links',()=>{
 const index=hawaiianIndex([row],now),[trip]=hawaiianTrips(index,q,now);
 assert.equal(trip.amount,234.1);assert.equal(trip.operator,null);assert.equal(trip.checkoutVerified,false);assert.equal(trip.outbound.upstreamPriceAge.value,19);assert.equal(trip.inbound.sourceUrl,row.page);
 assert.deepEqual(hawaiianTrips(index,{...q,returnDate:'2027-02-04'},now),[]);
});
test('does not revive expired observations or combine currencies and unsupported parties',()=>{
 const index=hawaiianIndex([row],now);
 assert.deepEqual(hawaiianTrips(index,q,new Date(now.getTime()+600000)),[]);
 assert.deepEqual(hawaiianIndex([row],new Date(now.getTime()+600000)).byDate,{});
 assert.throws(()=>hawaiianTrips(index,{...q,adults:2},now));
 const changed={...row,records:[fare,{...row.records[1],currencyCode:'EUR'}]};assert.deepEqual(hawaiianTrips(hawaiianIndex([changed],now),q,now),[]);
});
