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

Production search now integrates exact-date split fares and shares monthly calendars
for ten minutes per Worker isolate. Only one-adult searches qualify. The UI labels
the price as an advertised official calendar price and links to the airline.
Workers requires `redirect: manual`; `redirect: error` caused request failures.
The public service hostname is also present in the official bundle configuration.
Verified production on 2026-10-07: STN–DUB June 1–5 2027 returned EUR 104.98
(ILS 360.72), source ryanair, two upstream calls. June 2–6 reused the monthly
calendar with zero Ryanair upstream calls; complete requests took 1.45–1.82 seconds.

`worker/scripts/collect-ryanair.mjs` additionally collects an exact pair outside
Workers and persists its real advertised price to D1 using authenticated Wrangler.
Public calendar data now also uses the Cloudflare Cache API, shared between Worker
isolates in a data center. Records and empty calendars expire after ten minutes.
The original collection timestamp and expiry are preserved on reuse. Cache errors
fall back to source collection. This is not a globally synchronized cache.
Pending: full booking handoff, whole-party pricing and cross-carrier combinations.

## Coverage remains incomplete

## Aegean published page reader

Verified 2026-10-07 from the official route page:
https://flights.aegeanair.com/he/flights-from-tel-aviv-to-athens
The page embeds JSON in `__NEXT_DATA__`. `Fare` records carry airport codes,
departure/return dates, original currency and total price. The same page also
contains a cheaper headline fare for AXD–ATH: filtering airport codes is essential.
The matched TLV–ATH record was a one-way EUR 58.63 fare for 2027-08-29.
The reverse official page published EUR 102.74 for 2027-05-15; those dates cannot
form the requested June round trip and were not displayed as a June result.

Implemented `worker/src/sources/published-fares.ts`, verified against the actual
downloaded official page as well as unit tests. Parsing never evaluates scripts or
copies configuration/credentials. It bounds response size and traversal, checks the
official hostname, validates real dates, rejects expired prices and deduplicates.
This is sparse published advertising, not full inventory. The production adapter
matches an exact round-trip record or two one-way records on precisely the selected
dates, only for one adult. Its registry deliberately does not claim live inventory.
Production TLV–ATH June 1–5 2027 on October 7 returned zero offers from Aegean,
Ryanair and Travelpayouts. SerpApi's daily quota refused the live request.

## Other official website access checks (2026-10-07)

The official Lufthansa TLV–ATH route page and Scoot SIN–BKK route page returned
HTTP 403 to direct collection. Aegean's normal browser search accepted TLV–ATH
June 1–5 but the subsequent search submission was blocked by the browser.
Air France's route-page request failed and Etihad's timed out. None of these
checks yielded a verified date-specific price or a completed new price adapter.

## Israeli airline investigation

Israir's official client bundle exposes a search-only POST `/api/search/FLIGHTS`,
with route/date parameters and siteId `isra2023`. Two requests using the observed
contract returned HTTP 500. No prices or completed adapter have been obtained.
Arkia's official homepage returned a browser access challenge. No challenge was
solved or bypassed, and no direct fare access was verified.

## Remaining coverage

Every other airline still needs independently verified collection and deployed
integration. Official links and source-registry entries alone are not price coverage.
The goal of all-airline collection and fast cheapest-price comparisons is not complete.
