import {test} from 'node:test';import assert from 'node:assert/strict';import {hawaiianFares} from './hawaiian-fares.mjs';
const fare={__typename:'Fare',travelClass:'ECONOMY',originAirportCode:'HNL',destinationAirportCode:'LAX',departureDate:'2027-01-27',returnDate:'',flightType:'ONE_WAY',totalPrice:135.1,currencyCode:'USD',priceLastSeen:{value:'19',unit:'hours'}};
const row={page:'https://asha.hawaiianairlines.com/en/flights-from-honolulu',fetchedAt:'2026-10-08T10:00:00Z',records:[fare]};
test('preserves dates, original price age and unknown operator',()=>{
 assert.deepEqual(hawaiianFares(row),[{origin:'HNL',destination:'LAX',departDate:'2027-01-27',returnDate:null,amount:135.1,currency:'USD',structure:'oneway',sourceUrl:row.page,fetchedAt:row.fetchedAt,upstreamPriceAge:{value:19,unit:'hours'},operator:null,checkoutVerified:false,pricing:'published_advertisement'}]);
});
test('rejects rewards, headline, unknown currency, impossible dates and promoted fares',()=>{
 for(const patch of [{redemption:true},{currencyCode:null},{departureDate:'2027-02-30'},{flightType:null},{promoCode:'MEMBER'},{travelClass:'BUSINESS'},{totalPrice:NaN}])assert.deepEqual(hawaiianFares({...row,records:[{...fare,...patch}]}),[]);
});
test('rejects unofficial URLs and deduplicates identical advertisements',()=>{
 assert.throws(()=>hawaiianFares({...row,page:'https://evil.test/en/flights-from-honolulu'}));
 assert.equal(hawaiianFares({...row,records:[fare,fare]}).length,1);
});
