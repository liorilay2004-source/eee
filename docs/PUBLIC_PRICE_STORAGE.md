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
or reserved booking. The observed calendar request used a return-trip search, so the
adapter does not claim these are two independently bookable one-way tickets.
Its official link opens the observed calendar page; dates still need
selection on that page. Source metadata and UI labeling state this limitation.

Hourly background collection rotates the thirteen months in the one-year search horizon.
Each monthly snapshot replaces one record. Failed or empty renders leave previous data
untouched, subject to the 36-hour freshness limit. Future scheduled runs and all months'
availability must be verified separately; the verified initial snapshot was June 2027.

## Outstanding requirements

### Public exchange-rate cache

Exchange rates now have an optional hourly edge-cache entry keyed by the UTC
request day. Fresh cache hits skip both D1 FX reads and upstream FX calls.
Concurrent misses in one isolate share one loader promise. Rates retain the
original source date and stale marker; invalid, future, expired or oversized
entries are rejected. Cache failures leave the existing D1/official-source
fallback intact. No passenger information or credentials enter this cache.

An actual Wrangler runtime probe fetched Bank of Israel rates on 2026-10-08 with
D1 deliberately unavailable. Its first load made one unsuccessful D1 read and
one upstream call. The repeat returned identical rates in 2 ms, with zero D1
reads and zero upstream calls. This is evidence for the FX-cache path, not a
whole-search latency guarantee or proof that all fare sources work without D1.
Targeted pipeline tests also verify a fare-cache hit uses public cached FX
without querying either daily or latest stored FX.

Live verification subsequently hit D1's daily **read** allowance too. The independent
monthly read returned its metadata once, but the subsequent cached-adapter query returned
no offers; a direct CLI read then explicitly failed with the daily row-read limit. This
does not prove the production Norwegian search works today. Background public cache
entries now retain their original collection timestamps for up to 36 hours; active
Ryanair, Air Serbia and Aegean calendars keep the ten-minute limit. Norwegian checks
that public cache before D1. Local tests prove the cached path survives unavailable D1;
production cache population and the next scheduled collection still require observation.

The current daily write allowance cannot be restored by deploying code. A write-dependent
operation may remain unavailable until the allowance resets. No paid upgrade was activated.
The complete all-airline, arbitrary-route cheapest-price objective remains unfulfilled:
these adapters cover observed public pages and advertisements, rather than every airline's
live inventory and final booking totals.
