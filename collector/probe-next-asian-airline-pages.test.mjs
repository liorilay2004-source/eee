import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asianObservedLinks, normalizeAsianAdvertisements, observedAsianPage } from './probe-next-asian-airline-pages.mjs';
const sourceUrl = 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo';
const observation = { provider: 'eva', sourceUrl, checkedAt: '2026-10-08T12:00:00.000Z' };
const record = { __typename: 'Fare', travelClass: 'Economy Basic', farenetTravelClass: 'ECONOMY', formattedTravelClass: 'Economy',
  originAirportCode: 'TPE', destinationAirportCode: 'NRT', departureDate: '2027-06-13', returnDate: '2027-06-17',
  flightType: 'ROUND_TRIP', totalPrice: 100, currencyCode: 'TWD', formattedTotalPrice: 'TWD100', redemption: null,
  promoCode: '', priceLastSeen: { value: '1', unit: 'day' } };

test('normalizes only exact dated cash economy records and preserves original capture and upstream age', () => {
  const fares = normalizeAsianAdvertisements([record, record], observation);
  assert.equal(fares.length, 1); assert.equal(fares[0].checkedAt, observation.checkedAt);
  assert.deepEqual(fares[0].upstreamPriceAge, { value: 1, unit: 'days' });
  assert.equal(fares[0].returnDate, '2027-06-17'); assert.equal(fares[0].operator, null);
  assert.equal(fares[0].checkoutVerified, false);
  assert.equal(normalizeAsianAdvertisements([{ ...record, priceLastSeen: null }], observation)[0].upstreamPriceAge, null);
});
test('rejects business, promotion, rewards, missing airports, missing/invalid dates, and invalid cash', () => {
  for (const patch of [{ travelClass: 'Business Basic' }, { farenetTravelClass: 'BUSINESS' }, { promoCode: 'MEMBER' },
    { redemption: true }, { departureDate: '2027-02-30' }, { returnDate: null }, { originAirportCode: 'Taipei' },
    { totalPrice: NaN }, { departureDate: '2026-01-01' }, { returnDate: '2027-06-12' }]) {
    assert.deepEqual(normalizeAsianAdvertisements([{ ...record, ...patch }], observation), []);
  }
  const oneWay = normalizeAsianAdvertisements([{ ...record, flightType: 'ONE_WAY', returnDate: null }], observation);
  assert.equal(oneWay[0].returnDate, null); assert.equal(oneWay[0].structure, 'oneway');
});
test('Vietnam branded economy keeps raw numeric and rounded display prices distinct', () => {
  const fares = normalizeAsianAdvertisements([{ ...record, travelClass: 'Economy Super Lite', currencyCode: 'GBP',
    totalPrice: 100.19, formattedTotalPrice: 'GBP101' }], { ...observation, provider: 'vietnam',
    sourceUrl: 'https://www.vietnamairlines.com/en-gb/flights-from-london-to-hanoi' });
  assert.equal(fares[0].amount, 100.19); assert.equal(fares[0].displayPrice, 'GBP101'); assert.equal(fares[0].airline, 'VN');
});
test('discovers only actual links on the approved official host and locale', () => {
  const html = '<a href="/en-tw/flights-from-taipei">ok</a><a href="/en/flights-from-taipei">locale</a>'
    + '<a href="https://evil.example/en-tw/flights-from-taipei">bad</a><a href="/en-tw/flights-from-taipei?token=x">query</a>';
  assert.deepEqual(asianObservedLinks(html, sourceUrl, 'eva'), [{ url: 'https://flights.evaair.com/en-tw/flights-from-taipei', observedOn: sourceUrl }]);
  assert.throws(() => observedAsianPage('https://flights.evaair.com:8443/en-tw/flights-from-taipei', 'eva'));
  assert.throws(() => normalizeAsianAdvertisements(Array(501).fill(record), observation));
});
