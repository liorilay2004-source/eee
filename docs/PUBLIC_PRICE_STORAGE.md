# Public price storage — 2026-10-08

## Observed production limit

D1 rejected a migration bookkeeping write with code 7500 (free daily row-write limit).
A subsequent read showed 16,853 Finnair price observations recorded since midnight UTC,
compared with 121 Travelpayouts observations. The indexed `prices` table amplifies each
observation into several billable row writes. This is evidence of substantial Finnair
write volume, not a complete account-wide billing breakdown.

## Compact collection and exact lookup

Finnair collection now replaces current prices in `public_calendar_snapshots`, keyed by
source, origin, destination and departure month. It no longer appends its entire catalogue
to price history. Every dated fare remains in its monthly JSON snapshot. A 501-fare test
requires one monthly record, instead of 501 price records plus their index entries.
Snapshots have a 1.5 MB bound and reads validate the official route, currency, dates,
price, public-page URL and original collection timestamp. They expire after 36 hours.
An exact search reads only its matching month, memoized for that search; hot public cache
data is preferred. User-selected offers can still enter history through the search pipeline.

Other public collectors and the search pipeline explicitly deduplicate identical published
offers over 24 hours. The entire stored offer is compared, including legs, carrier, baggage
and booking links. A changed price or changed metadata is written, including a price that
changes and then changes back. Live paid-vendor quota controls are unchanged. This reduces
redundant history observations; it does not guarantee the free allowance cannot be exhausted.

## Norwegian scope

The cached adapter reads actual collected ATH–OSL calendar records and combines only the
requested outbound and inbound dates, including trips spanning two months. Both legs must
exist and be positive EUR prices for one adult. Operating carrier, times and baggage stay
unknown. The result is an advertised sum of two directional prices, not a verified checkout
or reserved booking. Its official link opens the observed calendar page; dates still need
selection on that page. Source metadata and UI labeling state this limitation.

Hourly background collection rotates the thirteen months in the one-year search horizon.
Each monthly snapshot replaces one record. Failed or empty renders leave previous data
untouched, subject to the 36-hour freshness limit. Future scheduled runs and all months'
availability must be verified separately; the verified initial snapshot was June 2027.

## Outstanding requirements

The current daily write allowance cannot be restored by deploying code. A write-dependent
operation may remain unavailable until the allowance resets. No paid upgrade was activated.
The complete all-airline, arbitrary-route cheapest-price objective remains unfulfilled:
these adapters cover observed public pages and advertisements, rather than every airline's
live inventory and final booking totals.
