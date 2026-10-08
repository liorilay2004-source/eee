import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asianPublicationPages, publishAsianObservation } from './publish-asian-observation.mjs';
const page = 'https://flights.evaair.com/en-tw/flights-from-taipei-to-tokyo';
const checkedAt = '2026-10-08T12:00:00.000Z';
const record = { __typename: 'Fare', travelClass: 'Economy Basic', farenetTravelClass: 'ECONOMY', formattedTravelClass: 'Economy',
  originAirportCode: 'TPE', destinationAirportCode: 'NRT', departureDate: '2027-06-13', returnDate: '2027-06-17',
  flightType: 'ROUND_TRIP', totalPrice: 100, currencyCode: 'TWD', redemption: null, promoCode: '',
  priceLastSeen: { value: '1', unit: 'day' } };
test('publishes original raw records and original capture with independently expected approved-pair count', async () => {
  const records = [record, { ...record, originAirportCode: 'XXX' }, { ...record, travelClass: 'Business Basic' }];
  let body;
  const receipt = await publishAsianObservation({ provider: 'eva', page, checkedAt, records }, 'a'.repeat(64), async (url, options) => {
    assert.equal(url, 'https://eee-api.liorilay2004.workers.dev/api/internal/public-fares');
    body = JSON.parse(options.body);
    return Response.json({ fares: 1, checkedAt });
  });
  assert.deepEqual(receipt, { published: 1, checkedAt });
  assert.deepEqual(body, { source: 'published_page', airline: 'BR', page, checkedAt, records, clearIfNoPrices: true });
  assert.equal(body.records[0].priceLastSeen.unit, 'day');
});
test('clears only explicit Fare records with no matching economy fares and rejects absent schema or bad receipts', async () => {
  assert.deepEqual(await publishAsianObservation({ provider: 'eva', page, checkedAt, records: [{ ...record, travelClass: 'Business Basic' }] }, 'a'.repeat(64),
    async () => Response.json({ fares: 0, checkedAt })), { published: 0, checkedAt });
  await assert.rejects(publishAsianObservation({ provider: 'eva', page, checkedAt, records: [] }, 'a'.repeat(64)), /No explicit published Fare records/);
  await assert.rejects(publishAsianObservation({ provider: 'eva', page: 'https://flights.evaair.com/en-tw/flights-from-taipei-to-unobserved', checkedAt, records: [] }, 'a'.repeat(64)), error => error.fatal === true);
  await assert.rejects(publishAsianObservation({ provider: 'eva', page, checkedAt: '2026-10-08', records: [] }, 'a'.repeat(64)));
  await assert.rejects(publishAsianObservation({ provider: 'eva', page, checkedAt, records: [record] }, 'a'.repeat(64),
    async () => Response.json({ fares: 0, checkedAt })));
  assert.equal(asianPublicationPages('eva').size, 10); assert.equal(asianPublicationPages('vietnam').size, 1);
});
