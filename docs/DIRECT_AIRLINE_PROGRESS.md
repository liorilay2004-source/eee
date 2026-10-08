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

## Air Canada published page data

Verified on 2026-10-07 from
https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto.
The HTML has a dated cash economy round trip TLV–YYZ, March 1–31 2027,
CAD 1,009. Toronto's heading uses city code YTO, but this fare explicitly uses YYZ;
the adapter does not silently substitute airport codes. Points and business-class
records are excluded. A source timestamp and exact original currency are retained.
The Air Canada adapter reads only this verified route page, returns exact date
matches for one adult, and shares parsed records in the public fare cache.
Its UI link opens the verified official route price page, not a reserved checkout.
Production verified October 7 at 21:54 UTC: one official-page call returned
CAD 1,009 (ILS 2,177.62), exactly March 1–31. Browser rendering displayed the
Air Canada card and correct official route URL. Unknown times and stops stayed
unknown, rather than being inferred from the route's usual schedule.

Every other airline still needs independently verified collection and deployed
integration. Official links and source-registry entries alone are not price coverage.
The goal of all-airline collection and fast cheapest-price comparisons is not complete.

## TAP public route-page data

Verified October 7 from https://www.flytap.com/en_pt/flights-from-tel-aviv-to-lisbon.
The page embeds five distinct future cash economy round trips for TLV–LIS.
June 16–20 2027 is EUR 434.69; August 1–14 is EUR 396.45. The page also embeds
executive fares over EUR 2,500, which are excluded. Economy casing varies within
the page and is normalized before filtering. Only exact route/date matches for
one adult qualify; missing times and stops stay unknown.

`published-source.ts` now supplies shared bounded page collection, per-request
pending work, ten-minute parsed-data caching and exact-date matching for Aegean,
Air Canada and TAP. Each wrapper contains only independently verified page URLs.
El Al's New York route-page request returned a browser access challenge rather
than flight data; no challenge was bypassed and no El Al prices were claimed.
Production verified October 7 at 22:01 UTC: June 16–20 returned EUR 434.69
(ILS 1,493.64), one official page call. A later August 1–14 request returned
EUR 396.45 with zero TAP page calls and preserved the original checkedAt.
The live browser displayed exact June dates, original EUR and the official URL.

## Ethiopian multi-destination public page

Verified October 7 from https://www.ethiopianairlines.com/en-il/.
The Israeli page embeds 29 distinct future cash economy fares from TLV across
18 published destination codes. Business fares and invalid same-day round trips
are excluded. July 12–August 2 2027 TLV–BKK is USD 950.38; July 1–13 TLV–ICN
is USD 732.58. Tokyo is published as city code TYO, which must not be silently
converted to NRT or HND. Exact airport quotes exclude that city-code record.

The source parses the entire origin page once, then selects exact route/date
matches across destinations. The same parsed page is reused across searches;
deduplication includes the destination, so equal prices for two routes survive.
Whole-party pricing, checkout handoff and full live inventory remain unverified.
Air India's tested page timed out. Aer Lingus' page was accessible but labels
its deals as each-way fares; their full round-trip amount is not yet established.
Production verified October 7 at 22:09 UTC: TLV–BKK July 12–August 2 returned
USD 950.38 (ILS 2,921.47), one Ethiopian page call. TLV–ICN July 1–13 then
returned USD 732.58 (ILS 2,251.95) with zero Ethiopian calls, the same checkedAt,
and a complete API response in 1.174 seconds. Browser rendering confirmed the
ICN dates, original USD price and official Israeli price-page URL.

## Finnair production integration — 2026-10-08

- Official fixed origin page: https://www.finnair.com/en/flights/from/hel/flights-from-Helsinki.
- Cloudflare Browser Run reads public `fcom-ux-state` JSON; only dated EUR Economy round-trip records from HEL are accepted. XTP/XTZ bus destinations, expired dates and premium cabins are excluded. Flight numbers, times and stops remain unknown.
- First production collection completed with 8,425 fares saved through the actual D1 repository. An earlier parser-only run found 8,428; the page can change between reads.
- Cache partitions are per destination, up to 500 records per partition. Searches never launch Browser Run. Background collection is scheduled daily at 01:43 UTC, separately from the other browser sources. The scheduled production invocation has not yet been observed; the collector was verified directly with the same remote bindings.
- Live production search HEL–RIX, 2026-11-17 to 2026-11-20, one adult: source `finnair` enabled/ok, one offer, zero provider calls. Official advertisement EUR 96 / ILS 329.87 appears in airline price links. A cheaper SerpApi quote USD 98 / ILS 301.25 ranks ahead of it. The rendered stable website shows Finnair at rounded ILS 330.
- Worker build `dbd8e230a5e0`, version `e82c8460-09f2-41a8-9b80-7e2618661188`; Pages deployment https://23fd1839.eee-web-bly.pages.dev.
- Verification: 2,187 worker tests and 249 web tests passed; TypeScript and web build passed.
- Coverage is published HEL-origin date pairs, not arbitrary live availability or all Finnair origins. Final checkout price and partner-operated legs are not verified. Global airline coverage and global cheapest remain incomplete.

## Iberia dated card integration — 2026-10-08

- Official fixed page https://www.iberia.com/es/cheap-flights/Madrid-Tel-Aviv/ renders in Cloudflare Browser Run although ordinary Worker fetch returns HTTP 403. No cookies or protection bypass are used.
- Complete public card MAD–TLV, 2026-10-31 to 2026-11-11, round trip EUR 239 was parsed from the real rendered response and saved through the production D1 repository (one fare/one offer). Dates are absent from the JSON-LD Flight, so the parser reads each card's dates and amount together and excludes incomplete or mismatched cards.
- Cabin, flight numbers, stops, baggage and final availability are unverified. This is a published advertisement, not checkout proof. Iberia's official September 7 Update 8 notice says three daytime weekly flights are cancelled October 25–December 9 while seven weekly frequencies continue; it does not justify excluding the entire route. https://agencias.iberia.com/content/iberia-agencias/language-masters/en/flexibilizaciones/listado/telaviv-update-8.html
- Integration adds an exact-date one-adult cache-only source and daily background collection at 03:43 UTC. The scheduled invocation has not yet been observed. Coverage remains one published route card, not arbitrary Iberia searches or all airline sites.
- Production verification after deploy: source `iberia` enabled/ok, one offer, zero provider calls; exact MAD–TLV dates return EUR 239 / ILS 821.23 as a selected card. Travelpayouts USD 192 / ILS 590.21 ranks cheaper. Build `70371427dc58`, Worker version `b413ba60-42b0-4929-889d-c0b92efba14b`, Pages https://2143eb9b.eee-web-bly.pages.dev.
- All 2,192 worker tests passed on a single-worker run with 30s per-test timeout; the earlier concurrent run had 5s timeouts and consequent leaked audit-log assertions. Web 249 tests, TypeScript and web build passed.

## ITA Airways daily/return calendar discovery — 2026-10-08

- Official page https://www.ita-airways.com/it/en/book-and-prepare/offers-and-destinations?OriginCode=ROM&PartnerFlights=one&city=SAO was inspected in the actual browser and Cloudflare Browser Run. Plain Worker fetch returned 403; rendered content loaded the public application.
- The visible calendar exposes exact days. Its actual public requests include `/service/api/flight-prices/ROM/SAO/E/2026-11-01T00:00:00/14?monthsToFetch=2&mode=DAYS` and `/service/api/flight-prices/ROM/SAO/E/2026-11-13T00:00:00/consecutiveReturnDays`. The first returned 61 departure records. The second returned explicit return dates with prices, e.g. November 17/18 EUR 802.09 from departure November 13. The visible selected November 13–27 trip displays rounded EUR 803.
- Responses contain currency, city-name URLs and `farePerDates` or `farePerReturnDates`; no operating airline or airport pair is supplied. The official page explicitly says displayed prices include Lufthansa Group and partners even with the ITA-only filter. Do not label these as confirmed AZ-operated flights or infer FCO/GRU airports from ROM/SAO cities.
- Added a strict parser for the observed exact-return schema, preserving cents and unknown carrier. Departure-only/monthly minima, route mismatches, invalid dates and negative prices are rejected. Two parser tests and TypeScript passed.
- Automatic backend extraction remains unverified: direct API Worker fetch returned 403; a fresh Quick Action navigation did not yield JSON; two normal Cloudflare Puppeteer sessions timed out at finding the priced offer card. Multiple public app catalog/label requests did return 200. No account cookies, user-agent spoofing, CAPTCHA or protection bypass were used. The backend selector currently matches raw text; whitespace normalization is a possible next diagnostic step.
- Puppeteer was installed only in the outside-repository probe workspace. No production dependency, paid plan or ITA source flag was changed; this source is not enabled in live search yet.

## Collection concurrency and ITA backend diagnosis — 2026-10-08

- Worker build 494eed9b6076, version 239d5ec6-510d-40db-a8ab-9f727fef8047, now limits each scheduled browser collection queue to two simultaneous jobs, preserving source cadence and continuing after source failures. TypeScript and 61 targeted tests passed; production health and exact TLV–ATH June 1–5 search were verified after deployment. Scheduled execution has not yet been observed.
- A fresh Cloudflare Puppeteer session returned HTTP 200 JSON from ITA destinationfinder/destination/finder/ROM/E. The public response has destinationFinderOffers, currencyInfo and originCityName; individual city records contain prices and operating/filter hints but no travel dates. This is route discovery evidence, not an exact trip price. Normalized button selection still timed out. Public body text showed Sao Paulo in the destination filter, no priced result cards, and an open privacy dialog. The next diagnostic rejects optional cookies before waiting for the result card.
- Rejecting optional cookies before the card wait also timed out. No exact-date prices were obtained and ITA remains disabled; no authentication data or protection bypass was used.

## British Airways actual booking flow discovery — 2026-10-08

- Official public low-price finder: https://www.britishairways.com/travel/low-price-finder/public/en_gb. Normal browser UI Europe → Athens → June 2027 shows GBP 124 each-way based on a seven-night return journey. This is not a complete independently purchasable one-way fare.
- Clicking its June Find control exposed dated calendars and the June 2–9 trip. Continue opened the official search URL https://www.britishairways.com/nx/b/airselect/en/gbr/book/search/?from=LON&to=ATH&departureDate=2027-06-02&adults=1&youngAdults=0&children=0&infants=0&travelClass=economy&arrivalDate=2027-06-09&trip=round&bound=outbound.
- Actual flight selection, without account login or passenger/payment details, reached Flight summary: BA626 LHR–ATH June 2 07:25–13:10 and BA627 ATH–LHR June 9 14:05–16:15, Economy Basic, one adult. Shopping Cart total GBP 282.24. Outbound/return intermediate screens rounded prices GBP 149 and GBP 134. Never sum rounded leg labels or double the calendar minimum as proof of the final total.
- Browser network returned 200 for /nx/b/bff/offer-flight/v0/search/calendars-out, /roundtrip/outbound, /search/calendars-in, /roundtrip/inbound, /carts and /flightSummary/{session-id}. Session identifiers and account/security headers are not persisted in project data. Backend Cloudflare extraction and repeatable summary deeplink remain unverified. BA is not yet an enabled automatic quote source.
