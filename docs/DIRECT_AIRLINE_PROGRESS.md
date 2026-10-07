# Direct airline price collection

## Ryanair: verified public website data

Observed 2026-10-07 at approximately 21:10 UTC from the official page
https://www.ryanair.com/gb/en/cheap-flights and its referenced fare-finder bundle.
The page's own calendar uses `/api/farfnd/v4/oneWayFares/{origin}/{destination}/cheapestPerDay`.
Parameters: `outboundMonthOfDate=YYYY-MM-01&currency=EUR`.

Live verification:
- STN–DUB June 2027: June 1 returned EUR 40.99, departure 20:05, arrival 21:25.
- TLV–ATH June 2027: every day had null price and `unavailable: true`.
These are advertised one-adult, one-way calendar prices. They do not prove a
whole-party quote, baggage inclusion, inventory reservation or a guaranteed final booking price.

Implemented in `worker/src/sources/ryanair-direct.ts`: strict route/date validation,
official host only, bounded timeout, no redirects/retries, source timestamp and URL,
and exclusion of unavailable/sold-out/malformed fares.

Pending: integrate into search pipeline, share monthly calendars in cache, compose
the exact selected outward/return dates, preserve advertised-price labeling, provide
official booking handoff and verify deployed Worker access. This source is not yet
shown in production search results.

## Coverage remains incomplete

Every other airline still needs independently verified collection and deployed
integration. Official links and source-registry entries alone are not price coverage.
The goal of all-airline collection and fast cheapest-price comparisons is not complete.
