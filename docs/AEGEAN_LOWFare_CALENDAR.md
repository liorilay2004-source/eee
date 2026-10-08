# Aegean official low-fare calendar

Verified on 2026-10-08 in an ordinary browser and Cloudflare Browser Run:

https://en.aegeanair.com/flight-deals/low-fare-calendar/?arr=ATH&datedeparture=2027-06-01&datereturn=2027-06-05&dep=TLV&month=2027-06&type=R

The calendar displayed TLV–ATH departure June1 2027 and ATH–TLV return June5
2027, EUR232.37 total for one adult in Economy, including taxes. The selected
outbound day was EUR104.63 and inbound day EUR127.74. A June monthly minimum
is a different price and is not substituted for these selected dates.

The normal browser's public RouteLowFares response provided both daily calendars
with Date, FullPrice, Price, Class, Updated and ServiceFee fields. Direct HTTP
retrieval of that observed endpoint returned403. Collection uses an ordinary
Browser Run navigation to the public calendar, with no copied cookies, tokens,
spoofed headers or challenge bypass.

At 2026-10-08T04:32:23.006Z the implemented bounded HTMLRewriter collector
returned the exact selected EUR232.37 fare. It validates both selected month
labels, both real trip dates and direction in the trip overview, both daily
component prices, and exact cent equality against the displayed total.

The site warns that connecting or partner-operated flights may appear. Carrier,
stops, timetable and baggage remain unknown. This is a published calendar fare,
not a checkout-confirmed reservation. Contextual round-trip calendar days are
not treated as independently bookable one-way flights or freely combined into
unverified return trips.

The reader was initially limited to TLV–ATH within one month. It now accepts
distinct, syntactically valid IATA airport codes and independently validates the
outbound and inbound months. Actual returned trip overview codes, dates, cells
and total must still match; URL admission does not imply route availability.
The existing Aegean source now first
reads the exact selected calendar fare from the public cache or compact trip
storage, then falls back to its marketing pages. It retains the conservative
marketing request reservation; a cached calendar hit makes no airline requests.
Missing hours, carrier, stops and baggage are not filled from assumptions.

`0011_public_trip_snapshots.sql` stores one current row per source, route and
exact departure/return pair. Repeated collection updates that row, rather than
appending every day in the contextual calendar to price history. Snapshot
freshness is limited to six hours. The collector stores the public cache before
attempting D1, so a storage failure does not erase the collected fare.

The hourly scheduler adds at most one Aegean job at 05 and 17 UTC, selected from
the latest 12 search logs across routes in the preceding 24 hours. Only exact date
pairs with one adult and no children or infants are eligible. Fresh stored trips
are skipped. Migration0012 adds the recent-search timestamp index, which the
collector explicitly requires to prevent accidental history table scans.
This bounded background collection does not provide immediate coverage for
every newly requested trip, flexible date window or other route.
Unavailable demand storage causes collection to skip, not an unbounded crawl.

At 2026-10-08T04:45:02.360Z an actual Cloudflare Browser Run navigation and the
implemented cache/provider returned EUR232.37 for June1–5. The provider cache
read took 3ms with zero airline requests, even with deliberately unavailable D1.
This is an adapter measurement, not full-site response latency. Subsequent
parser changes strip caller metadata from public fare records.

On Oct8 the ordinary official calendar also displayed ATH–FCO June1–5 2027,
EUR169.80 (EUR66.44 outbound plus EUR103.36 inbound), and June30–July4,
EUR137.80 (EUR66.44 plus EUR71.36). Each latter calendar selected its own month:
June outbound and July inbound. At 2026-10-08T04:55:46.928Z the implemented
Cloudflare renderer, cache and provider collected and returned EUR137.80 for
that exact cross-month trip with zero further airline requests (3ms provider
read, not full search latency). Tests retain observed selected cells and overview.

An ordinary Book this trip action opened one-adult passenger selection; its
Confirm action navigated to the site's flight-search post handler but Edge
reported ERR_BLOCKED_BY_CLIENT. No bypass was attempted. This does not prove
checkout price or availability, and no booking or payment was submitted.

Production migration application on Oct8 failed with D1 error7500 (daily read
allowance exhausted). Production collection, durable writes and actual website
price display remain unverified until the migration can be applied and those
paths can be exercised. Checkout verification is also incomplete.
No reservation, passenger details or payment were submitted.
