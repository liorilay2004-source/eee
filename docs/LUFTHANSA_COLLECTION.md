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

The parser is not yet enabled as a production provider. Cache integration and
checkout-price verification remain required before claiming
production coverage. None of these observations solves TLV–ATH June1–5.

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
