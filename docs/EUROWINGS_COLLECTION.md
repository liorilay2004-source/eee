# Eurowings public calendar

Observed and verified on 2026-10-08.

Official UI: https://www.eurowings.com/en/booking/flights/low-fare-calendar.html

The ordinary page requested:
`https://www.eurowings.com/services/centrallowfare.version1.ccen.originLHR.destinationDUS.promo.airlinecodesEW.showalternativesfalse.showNumberOfRoutes0.radius0.json`

The JSON response contains explicit LHR/DUS/EW route metadata, outbound and
inbound sections, 14 monthly groups, day numbers and GBP cash amounts. A plain
HTTP request returned 403. Ordinary Cloudflare Browser Run navigation to both the
calendar page and the observed JSON URL succeeded without challenge interaction,
copied browser credentials or a paid upgrade.

The actual production loader/parser/collector and public cache source were invoked
using the remote Cloudflare browser. They collected 792 direction/day amounts in
14 monthly groups. LHR–DUS 2027-06-01 to 2027-06-05 returned GBP 159.98 (89.99
outbound plus 69.99 inbound) from cache, with zero upstream search requests.
The probe deliberately disabled D1 persistence and returned historyUnavailable;
it did not populate production D1. This verifies collection and cached matching,
not a successful end-to-end production search.

When `promocode` is true the parser uses only explicit `noDiscountPrice.raw`.
It never assumes an anonymous user qualifies for the advertised member discount.
Wrong route/currency, invalid dates, duplicate directions/day records, missing
ordinary promo price and oversized payloads fail closed.

The collector stores one compact snapshot per month in the existing snapshot
table and warms the public cache before trying history writes. Search reads the
cache first, then at most one D1 snapshot per selected month. Original checkedAt
is retained and entries older than 36 hours are excluded. Scheduled collection
uses the existing bounded queue at 04, 10, 16 and 22 UTC. Successful future cron
execution has not yet been observed.

Scope currently proven: LHR–DUS in either direction, one adult. These are summed
calendar advertisements, not confirmed checkout inventory. Flight times, stops,
operating carrier and baggage are unknown. The UI says so and links to the official
calendar. Other routes and arbitrary airline-site coverage remain required work.
