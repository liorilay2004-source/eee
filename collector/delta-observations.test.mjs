import {test} from 'node:test';import assert from 'node:assert/strict';import {deltaObservations} from './delta-observations.mjs';
const row={carrier:"Delta Air Lines",legs:"Round-Trip",origin_queried:"NYC",destination_queried:"RSW",calculated_at:"2026-10-08T05:46:41Z",money:{travel_date_start:"2027-01-06",travel_date_end:"2027-01-12",price:{raw:"198.80",unit:"USD"},deeplink:"https://tkpi.delta.com/redirect?redirecturl=https://www.delta.com/flightsearch/search?originCity=NYC&destinationCity=RSW&awardTravel=false&paxCount=1&datesFlexible=true&departureDate=01/06/2027&returnDate=01/12/2027"}};
test('retains original city identity, timestamp and flexible-date limitations',()=>{
 const [offer]=deltaObservations({routes:[row]},"2026-10-08T08:00:00Z");assert.equal(offer.amount,198.8);assert.equal(offer.origin,'NYC');assert.equal(offer.airportIdentityConfirmed,false);assert.equal(offer.flexibleDates,true);assert.equal(offer.calculatedAt,row.calculated_at);
});
test('rejects points, invalid prices and nonofficial booking targets',()=>{
 assert.deepEqual(deltaObservations({routes:[{...row,money:{...row.money,price:{raw:'-1',unit:'USD'}}},{...row,money:{...row.money,deeplink:row.money.deeplink.replace('www.delta.com','evil.example')}}]},new Date().toISOString()),[]);
});

test('rejects impossible dates and a booking URL with different dates',()=>{
 assert.deepEqual(deltaObservations({routes:[{...row,money:{...row.money,travel_date_start:'2027-02-30'}},{...row,money:{...row.money,deeplink:row.money.deeplink.replace('01/06/2027','01/07/2027')}}]},new Date().toISOString()),[]);
});
