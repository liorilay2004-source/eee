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

The initial supported reader is TLV–ATH with departure and return in the same
month, matching the observed calendar. The existing Aegean source now first
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
the latest 12 TLV–ATH search logs in the preceding 24 hours. Only exact date
pairs with one adult and no children or infants are eligible. Fresh stored trips
are skipped. This bounded background collection does not provide immediate
coverage for every newly requested trip, flexible date window or other route.
Unavailable demand storage causes collection to skip, not an unbounded crawl.

At 2026-10-08T04:45:02.360Z an actual Cloudflare Browser Run navigation and the
implemented cache/provider returned EUR232.37 for June1–5. The provider cache
read took 3ms with zero airline requests, even with deliberately unavailable D1.
This is an adapter measurement, not full-site response latency. Subsequent
parser changes strip caller metadata from public fare records.

Production migration application on Oct8 failed with D1 error7500 (daily read
allowance exhausted). Production collection, durable writes and actual website
price display remain unverified until the migration can be applied and those
paths can be exercised. Checkout verification is also incomplete.
No reservation, passenger details or payment were submitted.
