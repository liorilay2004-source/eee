# FLIGHT_API_RESEARCH — flight price and supporting APIs

> Status: research note · Date: 2026-09-29 · Documentation only: no code, no keys, nothing deployed.
> Method: four parallel read-only web research passes (affiliate/metasearch, GDS/NDC/booking, scraping/SERP, supporting data) over official documentation where reachable. Many vendor pages returned 403/404/503 to the research tool, so a large part of the evidence is search snippets or third-party summaries. Every claim carries its source; **[UNVERIFIED]** marks anything not confirmed on an official page. Nothing here was tested against a live endpoint, and no ILS or TLV/ETM coverage was measured.
> Project context: Hebrew-only price comparison for Israeli travellers (TLV/ETM), Cloudflare Workers free tier + D1, search and affiliate redirect first (no ticketing), flexible date windows, ILS conversion done by us. See [`SPEC.md`](SPEC.md).

## 1. Bottom line

1. **Core source: Travelpayouts / Aviasales Data API.** It is the only option found that is open to a small developer, free, and has calendar / month-matrix cached prices. It is what the engine already uses. Its weaknesses are unverified: Israel-origin cache density, ILS support, and exact rate limits (sources conflict).
2. **Managed calendar fallback: SearchApi.io `google_flights_calendar`.** The only managed API found that returns a real cheapest-date grid (up to 200 date pairs in one call). Paid ($4 per 1,000 requests) and Google-ToS exposed.
3. **Detail enrichment stays best-effort:** `fast-flights` (free, fragile) and, if a paid option is wanted, SerpApi (price insights, booking tokens).
4. **Dead or closed to us:** Amadeus Self-Service (decommissioned 2026-07-17), Kiwi Tequila (invite-only), Skyscanner API (large partners only), Sabre / Travelport / Amadeus Enterprise (contract-gated), Booking.com and Expedia (no flight API).
5. **Ticketing later:** Duffel is the only self-serve booking API found (El Al through Travelport; Israir, Arkia, Ryanair, Wizz not confirmed).
6. **Free supporting data:** Bank of Israel for ILS, OurAirports + Wikidata/GeoNames for airports and Hebrew names, data.gov.il `flydata` for Ben Gurion flight status.

Before committing to any choice, three things must be measured with a real token (see §8): TLV/ETM coverage in the Travelpayouts cache, whether ILS is accepted as `currency`, and the actual rate limits.

## 2. Status table (price / availability sources)

| Source | Type | Calendar / cheapest date | Access for a small developer | Cost | Verdict |
|---|---|---|---|---|---|
| Travelpayouts Data API | Cached prices, affiliate | **Yes** (`calendar`, `month-matrix`, `week-matrix`) | Open, token on sign-up | Free (commission model) | **Core (in use)** |
| Travelpayouts Flight Search API | Live search | live | Only projects with ≥ 50,000 monthly users [UNVERIFIED] | Free | Later |
| SearchApi.io Google Flights | Managed SERP | **Yes** (`google_flights_calendar`) | Self-serve | 100 free, then from $40/mo | **Paid fallback** |
| SerpApi Google Flights | Managed SERP | No | Self-serve | 250 free/mo; from $25/mo | Detail enrichment |
| Apify Google Flights actors | Community scrapers | Yes (some) | Self-serve | ~$0.2–5 per 1,000 rows | Cheap fallback, fragile |
| Bright Data Google Flights | Scraper API | No | Self-serve | 5,000 free records/mo; $1.50/1k | Volume option |
| Scrapingdog Google Flights | Scraper API | No | Self-serve | 5 credits per request | Simple alternative |
| FlightAPI.io | Scraped price API | [UNVERIFIED] | Self-serve | 20 free credits; $49–199/mo | Paid fallback |
| fast-flights 3.1.0 | OSS Google Flights scraper | Not verified | Free | Free | Keep, best-effort |
| Wego | Live metasearch | No | Contact / Admitad | [UNVERIFIED] | Later |
| Kayak / Momondo | Affiliate + API | Price Insights API | Sales-gated | [UNVERIFIED] | Enquire, do not plan on it |
| Duffel | Search + booking | No | Self-serve | $3 per order; $0.005 per search beyond the free allowance | Ticketing later |
| Amadeus Self-Service | — | — | **Closed 2026-07-17** | — | **Dead** |
| Amadeus Enterprise / Quick Connect | GDS-style | [UNVERIFIED] | Sales + qualification | Not public | No |
| Sabre, Travelport | GDS | — | Contract, PCC / sales inquiry | ~$5k/yr and up (blog estimate) | No |
| Kiwi Tequila | Metasearch | — | Invite-only since ~May 2024 | — | No |
| Skyscanner Travel API | Metasearch | Indicative prices | Established businesses, ~2-week application | Commercial | No (CJ affiliate links only) |
| Booking.com Demand API | — | — | Managed affiliates | — | No flights |
| Expedia Rapid | — | — | — | — | Lodging only |
| Trip.com affiliate | Links | — | Open (links) | 0.5% intl. flights | Links only |
| Google Flights | — | — | **No official API** (QPX Express ended 2018-04-10) | — | Not an option |
| DataForSEO | SERP | — | — | — | No flights endpoint found |

## 3. Affiliate and metasearch APIs

### 3.1 Travelpayouts / Aviasales
- **Data API endpoints** (docs: https://travelpayouts.github.io/slate/): v1 `prices/cheap`, `prices/direct`, `prices/calendar` (cheapest per day of a month), `prices/monthly`, `airline-directions`, `city-directions`; v2 `prices/latest` (last 48 hours, `limit` up to 1000), `prices/month-matrix`, `prices/week-matrix`, `prices/nearest-places-matrix`, `prices/special-offers` (XML). Reference data files `data/<lang>/cities.json`, `airports.json`, `airlines.json`.
- `prices_for_dates` (used by the Phase 0 / Phase 1 code) is **not on the slate docs page** the research could read; it appears only in help-center titles. Treat its exact contract as [UNVERIFIED] here, and rely on the code's own tests and fixtures.
- **Auth:** token in `X-Access-Token` header or `token` query parameter (slate docs). **Currency:** a `currency` parameter, default RUB; whether ILS is accepted is [UNVERIFIED].
- **Freshness:** cached from users' searches; stored 2–7 days depending on the query, and the vendor recommends caching on your side for 24 hours (help-center snippets: https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API, https://support.travelpayouts.com/hc/en-us/articles/203956083-Requirements-for-Aviasales-data-API-access). No traffic minimum for the Data API.
- **Rate limits:** reworked 2024-06-14 to requests per minute, 429 when exceeded; one snippet shows `prices/calendar` at 300 requests per minute (https://support.travelpayouts.com/hc/en-us/articles/4402565416594-API-rate-limits). The slate docs give an older 200 requests per hour for `prices/latest`, so the sources **conflict**.
- **Real-time Flight Search API** (`POST /v1/flight_search`, then poll `GET /v1/flight_search_results?uuid=`): reported to need ≥ 50,000 monthly active users; searches must be user-initiated, results shown in full, automated link collection prohibited; conversion thresholds (9% search→book click, 5% click→purchase) and 100 requests per hour per user IP are quoted from the slate/help-center snippets [UNVERIFIED]. Out of reach at launch.
- **Payout (third-party, unofficial):** up to 50% of Aviasales revenue (about 1.1–1.3% of booking value), 30-day cookie, monthly payout with a $50 minimum (https://getlasso.co/affiliate/travelpayouts/, https://uppromote.com/affiliate-directory/travelpayouts/). Traffic rules (no paid search, no media buying, no coupons) are third-party and unverified. Registration asks for a traffic source (site, social profile, channel or app).
- **Israel:** Aviasales affiliate tools support Hebrew (`he`). ILS and TLV/ETM coverage are [UNVERIFIED]; the audience is largely Russian-speaking, so Israel-origin cache density may be thin.

### 3.2 Others (all gated or link-only)
- **Kiwi.com Tequila:** self-serve keys closed since ~May 2024; invitation-only, needs a live travel product (https://media.kiwi.com/articles-and-interviews/better-for-business-kiwi-com-takes-a-new-approach-to-partnerships/; third-party: https://phptravels.com/blog/comprehensive-guide-to-flights-api-integration). Kiwi's public GitHub docs still describe self-registration and are outdated.
- **Skyscanner:** Travel API for "established businesses with a large audience", ~2 weeks to answer (https://www.partners.skyscanner.net/product/travel-api). Affiliate programme via CJ gives links, not a price API. White-label and legacy API access ended (third-party: https://www.travelpayouts.com/blog/no-more-skyscanner-api-and-white-label/).
- **Kayak / Momondo / Cheapflights:** affiliate network with white label and API access, including a Flights Search API and a Flights Price Insights API (https://affiliates.kayak.com/apis/flights, https://developers.kayak.com/). Approval and terms are not published: contact partnerships@kayak.com. Kayak's terms forbid scraping (https://www.kayak.com/terms-of-use).
- **Booking.com Demand API:** accommodations, cars and orders; flights only rumoured (https://developers.booking.com/demand/docs/getting-started/try-out-the-api).
- **Expedia Group:** Rapid is lodging-only (https://partner.expediagroup.com/en-us/join-us/rapid-api); flights are affiliate links via CJ.
- **Trip.com:** open affiliate programme; international flights from 0.5%, $200 payout minimum (https://www.trip.com/partners). No public flight price API found.
- **Wego:** flights metasearch API (`POST https://affiliate-api.wego.com/metasearch/flights/searches`, then poll results) but **no calendar endpoint**, so a flexible grid would need one search per date pair (https://developers.wego.com/docs/affiliate/guides/flights/). Access by emailing affiliates@wego.com or via Admitad.
- **Google Flights:** no public API; QPX Express was discontinued 2018-04-10 (https://techcrunch.com/2017/11/01/google-will-pull-its-qpx-express-api-in-april-2018-cutting-off-its-flight-data-feed/). ITA Matrix is a web tool with no API.

## 4. GDS, NDC and booking-capable APIs

- **Amadeus Self-Service — decommissioned.** Registration for new users was paused and the portal was closed on **2026-07-17**, with API keys disabled; Enterprise customers are unaffected. Sources: https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers, https://traveltrade.today/gds-systems/amadeus-sa/amadeus-closes-self-service-apis-portal-for-developers/, https://www.tripgic.com/playbook/amadeus-api-shutdown-migration/, https://ignav.com/docs/amadeus-self-service-shutdown. The vendor's own page (https://developers.amadeus.com/) could not be read by the research tool, so this rests on several independent secondary sources. This also removes Amadeus Airport & City Search as a free autocomplete. Old tutorials and SDKs that assume self-service keys are obsolete.
- **Amadeus Enterprise / Quick Connect:** sales contact and qualification, "4 to 6 weeks" integration, pricing not public (https://amadeus.com/en/travel-sellers/products/quick-connect). Not viable now.
- **Sabre (Bargain Finder Max):** REST/SOAP search (https://developer.sabre.com/rest-api/bargain-finder-max/v5); free sandbox, but production needs a Sabre representative, a PCC and a paid agreement (secondary source). Not viable.
- **Travelport JSON APIs:** credentials after a sales inquiry; a 30-day Universal API trial exists (https://support.travelport.com/webhelp/JSONAPIs/Content/Home.htm). About $5,000 per year developer fee and $15–35k first year (vendor-blog estimates only, [UNVERIFIED]). Not viable.
- **Duffel:** self-serve search + booking with a test token, Place Suggestion API for autocomplete (https://duffel.com/docs/guides/getting-started-with-flights). Official pricing: **$3.00 per confirmed order**, 1% of order value for Managed Content, $2.00 per paid ancillary, 2% FX fee, 1,500 free searches per order and $0.005 per excess search (https://duffel.com/pricing). With zero orders every search is billable, roughly $5 per 1,000 searches (our inference from the pricing page). No calendar or price-history endpoint found. Offers expire (typically 30 minutes, `expires_at`). Claims 300+ airlines; **El Al via Travelport** (https://duffel.com/flights/airlines/el-al); Israir and Arkia not found; Ryanair and Wizz not confirmed (its NDC list does not name them: https://duffel.com/ndc/airlines-and-ndc). Duffel's terms (caching/display) were not read. Best fit if tickets are ever sold; a poor fit for redirect-only search.
- **Airline NDC direct:** Lufthansa Group SPRK needs an IATA number (https://lhgroupairlines.com/ndc/en/about-ndc/faqs-1); British Airways and Air France-KLM require developer-portal applications and certification. None of them carry El Al, Israir or Arkia, and each airline is a separate integration. Not practical for a solo developer.
- **Farelogix/Accelya, Navitaire:** airline-side platforms, per-airline contracts. No public API.
- **Travelfusion** (license agreement with fees, LCC-heavy, https://corporate.travelfusion.com/resources/xml-api), **Mystifly** (onboarding on quote), **TBO** (India-focused, contract): B2B consolidators, relevant only if the product moves into ticketing.
- **FlightAPI.io:** scraped real-time prices, round trip at 2 credits per request; **no booking, links only**; 20 free credits, then $49 (30,000 credits), $99, $199 per month (https://www.flightapi.io/flight-price-api/, https://docs.flightapi.io/flight-price-api/round-trip-api). About 15,000 round-trip searches per month at the entry tier. Scraping risk applies; coverage of Israeli carriers unverified.
- **FlightLabs:** claims calendar search and price forecast (https://www.goflightlabs.com/flight-prices); nothing beyond marketing pages was found. [UNVERIFIED]

## 5. Scraping, SERP and data-as-a-service

Google has no public Flights API, so everything in this section reads Google Flights (or another metasearch site) through a scraper.

- **SearchApi.io** (https://www.searchapi.io/docs/google-flights-api, https://www.searchapi.io/docs/google-flights-calendar-api, https://www.searchapi.io/pricing): the `google_flights_calendar` engine takes `outbound_date_start/end` and `return_date_start/end` and returns `calendar[]` of `{departure, return, price, is_lowest_price, has_no_flights}`, up to **200 outbound/return combinations per request** (200-day range for one-way). Price is an integer and the calendar carries no leg times, so pair it with the `google_flights` engine for detail. $40/month for 10,000 requests ($4 per 1,000), $100 for 35,000; 100 free requests, failed requests not billed; calendar-call credit cost is not stated [UNVERIFIED]. Higher tiers advertise legal protection.
- **SerpApi** (https://serpapi.com/google-flights-api, https://serpapi.com/pricing): round trip, one-way and multi-city, `deep_search`, `price_insights` (lowest price, price level, typical range, history), `booking_token` for booking options, `departure_token` for return legs. **No date-grid engine**; the Travel Explore API lists destinations, not a per-route grid. Free 250 searches per month; $25 for 1,000; $75 for 5,000; $150 for 15,000. A round trip needs several calls. Google sued SerpApi on 2025-12-19 (DMCA circumvention theory); the July/August 2026 procedural steps in press summaries are partly unverified (https://ipwatchdog.com/2025/12/26/google-sues-serpapi-parasitic-scraping-circumvention-protection-measures/).
- **Apify actors** (community-run, per-result billing): `lergassy/google-flights-scraper` (~$0.20 per 1,000 rows, price calendar up to 365 days, round-trip pairing, booking links), `kestrel/google-flights-prices` (~$5 per 1,000 itineraries, `sweepDays`). Maintainers can disappear or break; quality claims are self-reported. Kayak and Skyscanner actors exist but Kayak's terms forbid automated access; avoid them.
- **Bright Data** (https://brightdata.com/products/serp-api/google-search/flights): input is a Google Flights URL; 5,000 free records per month, then $1.50 per 1,000. No calendar endpoint.
- **Scrapingdog** (https://www.scrapingdog.com/documentation/google-flights-api/): structured Google Flights API, 5 credits per request, no calendar. **ScrapingBee / Oxylabs:** generic unblockers where you own the parsing. Zyte and Outscraper: no flights product found. **DataForSEO:** no flights endpoint in its documented SERP list (https://docs.dataforseo.com/v3/serp/google/overview/).
- **fast-flights** (https://github.com/AWeirdDev/flights, https://pypi.org/project/fast-flights/): MIT, latest 3.1.0 (2026-08-18), builds a protobuf `tfs` query and reads embedded JSON. The 3.x line broke the 2.x API; open issues include parse failures and a maintainer-availability note. No calendar feature found [UNVERIFIED]. Runs from GitHub Actions datacenter IPs; block risk not verified. Keep it pinned and wrapped in try/except.
- **Skiplagged:** no official API; **Momondo/Kayak scraping:** prohibited by Kayak's terms.
- **Legal:** Google's terms prohibit automated access in violation of machine-readable instructions and reverse-engineering (https://policies.google.com/terms). Whether `/travel/flights` is disallowed in robots.txt was not checked. Some vendors sell indemnity at high tiers. This is what the sources say, not legal advice; the owner should decide the risk (see §8).

## 6. Supporting data

| Need | Pick | Notes |
|---|---|---|
| Airport structure (IATA, coordinates, timezone, country) | **OurAirports** CSV, public domain (https://ourairports.com/data/) | Import into D1 at build time. No airlines. |
| Hebrew names of airports, cities, airlines | **Wikidata** (CC0, label `he`, IATA property P238) and **GeoNames** (CC-BY, `alternateNamesV2` includes `he`) | Coverage per item not verified. One-off export at build time. |
| Aviasales-compatible codes | Travelpayouts `data/<lang>/{airports,cities,airlines}.json` | The fetched `he/cities.json` showed only `en` translations, so Hebrew coverage is unconfirmed; licence not found. The repo already bundles 615 airports / 567 cities. |
| Airline names | OpenFlights (`airlines.dat`, ODbL, stale [UNVERIFIED]) or Travelpayouts `airlines.json` | Licence text not read. |
| Ben Gurion flight status | **data.gov.il `flydata`** (Israel Airports Authority; CKAN; licence "Other (Open)"; refresh about every 15 minutes; resource `e83f763b-b7d7-479e-b172-ae981ddc6de5`) | https://data.gov.il/dataset/flydata . TLV only; ETM not confirmed. Endpoint behaviour untested. |
| Global flight status | AeroDataBox (free 600 units/month; from ~$8/month), AirLabs (~1,000 calls/month, [UNVERIFIED]) | AviationStack free tier is 100 requests/month and non-commercial; FlightAware AeroAPI free tier is personal-use only and paid starts at $100/month; OpenSky is non-commercial and live ADS-B, not schedules. Not needed for price comparison. |
| ILS exchange rates | **Bank of Israel** SDMX (`RER_<CCY>_ILS`, e.g. `https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_GBP_ILS?format=csv`) | Official, daily. Terms of use apply, text not read. The engine already uses it. |
| Fallback rates | **open.er-api.com** (no key, daily, attribution link required, redistribution prohibited, 429 blocks for 20 minutes; https://www.exchangerate-api.com/docs/free) and **Frankfurter** (no key, free for commercial use, https://frankfurter.dev/) | ILS is expected on both but was not seen in the fetched text. exchangerate.host is too small (100 requests/month). |

### Airlines and Israeli OTAs
No official public price API or affiliate feed was found for El Al, Israir, Arkia, Wizz Air, easyJet, Aegean, Pegasus, Transavia, or the Israeli OTAs (Issta, Gordon, Flying Carpet, Tripper). Ryanair has no affiliate programme (https://www.travelpayouts.com/blog/ryanair-affiliate-program/). Turkish Airlines is reported to be available through Travelpayouts. Treat all of this as [UNVERIFIED] until the Travelpayouts and Awin dashboards are checked after sign-up. Affiliate networks: Travelpayouts (free sign-up with a public traffic source; Israel eligibility not explicitly verified), Awin, CJ and Impact (nothing found on Israeli publishers or airline programmes).

## 7. Fit against this project

| Requirement | Best available |
|---|---|
| Cheapest dates over a flexible window, free | Travelpayouts Data API (`calendar`, `month-matrix`) |
| Same, managed and reliable, paid | SearchApi.io `google_flights_calendar` (one call ≈ 200 date pairs) |
| Return-leg times, airline names, booking detail for the top pairs | `fast-flights` (free) → SerpApi or SearchApi `google_flights` (paid) |
| Live per-user search | Not available at launch (Travelpayouts Search API needs ≥ 50,000 monthly users) |
| Booking / ticketing | Duffel, later; not needed for redirect |
| Hebrew place names | Bundled table (done); Wikidata/GeoNames to fill gaps |
| ILS | Bank of Israel, fallback Frankfurter / open.er-api.com |

## 8. What to verify with a real token (Phase 0 gate, D1 in `WEB_APP_SPEC.md`)

1. TLV and ETM origin coverage in the Travelpayouts cache: share of sample routes with valid date pairs.
2. Whether `currency=ils` is accepted, or whether ILS conversion must stay entirely on our side (the engine already converts).
3. Actual rate limits on `prices_for_dates`, `calendar` and `month-matrix` (sources conflict: 200/hour vs 300/minute).
4. Whether Hebrew and Israeli traffic sources are accepted at registration, and the affiliate terms on displaying prices and caching.
5. `he/` reference files: Hebrew coverage and licence.
6. Owner decision on scraping-based sources (fast-flights, SearchApi, SerpApi, Apify) given Google's terms and the SerpApi litigation.
7. data.gov.il `flydata`: does it include Eilat (ETM), and the real `datastore_search` behaviour.

## 9. Not covered
IATA, OAG and Cirium pricing and terms; Awin, CJ and Impact eligibility for Israel; licence texts for OpenFlights, the Travelpayouts data files, data.gov.il "Other (Open)" and the Bank of Israel terms of use; Skyscanner's own terms; whether Frankfurter and open.er-api.com carry ILS.
