# SWISS public price collection evidence

Official pages verified in an ordinary browser on 2026-10-08:

- https://www.swiss.com/lhg/ch/en/o-d/cy-cy/tel-aviv-zurich
- https://www.swiss.com/lhg/ch/en/o-d/cy-cy/zurich-tel-aviv

The first page displayed schedules and a search form, with no price calendar. The
second was reached through the first page's visible return-flight link after
dismissing the non-binding cookie notice using Only necessary.

The ZRH–TLV page displayed dated advertisements for one Economy traveller and
14 days, with both dates explicit in the official aircore booking links:

- June1–15 2027: CHF358.
- July9–23 2027: CHF360.
- March12–26 2027: CHF332 in both headline and calendar.

Calendar price labels use `from 358 CHF`; headline anchors use `from CHF 332`.
The parser preserves CHF, accepts the two observed label orders, and rejects
fractional or ambiguous thousands-separated labels rather than guessing a value.
It requires the observed Swiss market and route and never reverses these trips
into outbound TLV–ZRH tickets. A round trip from ZRH is not a single return leg.
No operating carrier is inferred from unrelated schedule data.

Cloudflare Browser Run verified the same official page at 2026-10-08T04:07:20.276Z and yielded 26 accepted dated advertisements, including the June CHF358 and July CHF360 pairs above. The probe did not access D1 or retain security/session data.

This parser and renderer are not enabled as a production source yet.
cache and storage integration and checkout-price verification remain required.
No reservation, passenger entry or payment was performed.
