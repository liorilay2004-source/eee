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

Scope initially proven: LHR–DUS in either direction, one adult. These are summed
calendar advertisements, not confirmed checkout inventory. Flight times, stops,
operating carrier and baggage are unknown. The UI says so and links to the official
calendar. Other routes and arbitrary airline-site coverage remain required work.

## Athens route expansion

On 2026-10-08 the ordinary destination selector listed Athens and its own request
used the same observed calendar URL with `destinationATH`. The response explicitly
identified LHR/ATH/EW and contained 22 outbound and 196 inbound priced days.
The station selector also exposes numeric cluster identifiers alongside airport
codes; those identifiers must not be treated as airports or evidence of fares.

The real remote Browser Run collector and cached adapter subsequently collected
218 direction/day fares across 14 months for LHR–ATH. Exact November 12–15, 2026
returned GBP 399.98 (189.99 outward plus 209.99 return) with zero search calls.
The probe deliberately disabled production D1 access. Production search and future
scheduled execution remain unverified while the daily storage allowance is spent.

The parser now requires the selected route to match metadata in both directions.
Cache and compact snapshot keys include the destination. A test using one adapter
for both routes verifies Athens data cannot answer a Dusseldorf request.
The four daily rendering slots now alternate routes: DUS at 04/16 UTC and ATH at
10/22 UTC, retaining the total of four daily calls and the existing browser queue.
No arbitrary route has been enabled merely because the selector lists it.

The UI's departure selector returned no results for TLV while Athens was selected
as destination. Therefore the LHR-origin station catalogue's mention of TLV does
not prove a selectable TLV–ATH calendar, and that pair has not been enabled.
