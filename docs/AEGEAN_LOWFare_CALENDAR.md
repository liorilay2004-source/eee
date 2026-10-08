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
month, matching the observed calendar. Cache/storage, search integration,
production collection and checkout verification are not yet implemented.
The existing marketing-page Aegean source is separate and unchanged.
No reservation, passenger details or payment were submitted.
