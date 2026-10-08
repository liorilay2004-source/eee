# Lufthansa dated public fare evidence

Ordinary official pages verified on 2026-10-08:

- https://www.lufthansa.com/lhg/il/en/o-d/cy-cy/tel-aviv-athens
- https://www.lufthansa.com/lhg/gr/en/o-d/cy-cy/athens-tel-aviv

The TLV–ATH page contains no priced advertisement anchors. The ATH–TLV page
contains visible whole-euro advertisements and official booking links with both
airport codes and both dates. Observed June 5–19 2027: EUR304. Observed July22–
August5 2027: EUR339. These are round-trip advertisements from ATH, not return-only
legs to combine with an outbound ticket from TLV, and not TLV–ATH round trips.

Conflicting values occur: the December1–15 headline advertises EUR304 while its
calendar advertises EUR303; October20–November3 calendar EUR411 conflicts with
the last-minute EUR436 for the same dates. The parser excludes conflicting pairs.
It retains collection time, original EUR, unknown carrier and advertised-price
classification. Schedule data is not evidence of the flight included in a fare.

The search provider reads collected ATH–TLV advertisements for one adult with
exact matching dates. Checkout-price verification remains required before claiming
confirmed booking prices. None of these observations solves TLV–ATH June1–5.

## Cloudflare collection verification

At 2026-10-08 03:48:36 UTC, `loadRenderedLufthansa` was executed with a real remote
Cloudflare Browser Run binding through Wrangler. Ordinary navigation to the
observed ATH–TLV page returned 23 accepted dated advertisements. June5–19 EUR304
and July22–August5 EUR339 matched the normal browser's visible anchors. All records
retained ATH:TLV direction, official seller URL, EUR and collection time. Conflicting
pairs were omitted. The probe made no D1 queries, reservations or payments.

The shared renderer supports exactly the two observed Brussels/Lufthansa page
URLs and refuses caller-supplied alternatives before launching the browser.
Response size, anchor count and anchor label size are bounded. Failed rendering
and non-string/unsuccessful envelopes never become fares.

## Cache and provider verification

At 2026-10-08 03:51:22 UTC, the integrated collector and provider were exercised
with a real remote Cloudflare Browser Run binding and Workers Cache API. Collection
returned 23 advertisements; ATH–TLV June5–19 returned EUR304 and its dated official
link. June5–20 and the reversed TLV–ATH route returned no offers. The provider made
zero upstream calls; the three cache/provider checks together took 13ms, not a full
production search latency measurement. This probe did not use D1.

Prices retain their original collection timestamp and expire after 36 hours.
Scheduled refresh runs at 07/19 UTC within the existing queue of at most two
concurrent browsers. Future cron execution and a complete production search have
not yet been verified. Production D1's daily read allowance is currently exhausted.

## Direct API access rechecked

On 2026-10-08 the official Developer Center homepage explicitly states that
registration to OpenAPI is on hold until further notice:
https://developer.lufthansa.com/page

The official product description distinguishes public reference/operations data
from Partner Plan fare/deeplink data. Its fares/availability page requires submitting
a use case and describes partner eligibility restrictions for metasearch-like
services. Existing documentation therefore does not establish that this project's
fare access is approved or that a new key can currently be self-issued.

- https://developer.lufthansa.com/product
- https://developer.lufthansa.com/page/read/Fares_availability
- https://developer.lufthansa.com/docs/read/api_partner/offers

No credentials were fabricated, obtained from example documentation, or committed.
The public advertisement collector is independent of this unavailable API approval.
