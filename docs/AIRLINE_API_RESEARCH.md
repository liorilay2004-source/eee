# Airline APIs and overlay plan

Updated: 2026-09-30

## Runtime investigation: Air Serbia, 2026-10-08

The production page https://www.airserbia.com/en-bg/flights-to-athens exposes a dated cash calendar. A normal browser initially displayed its security verification page, then loaded successfully without interacting with the verification. The selected trip type was `oneWay`, with one adult and EUR currency.

Advancing the visible calendar generated this observed GET request:

`https://www.airserbia.com/api/destination/flight-prices/BEG/ATH?year=2027&month=1&pos=GLOBAL`

The browser received HTTP 200. The response contains `origin`, `destination`, `year`, `month`, `source: "db"`, and `prices`, keyed by exact ISO dates. Each day contains `price`, `currency`, `direct` (nullable), and `soldOut`. Observed examples: January 4 and 8, 2027, EUR 60.36; January 5 and 7, EUR 73.36. These are cached calendar advertisements, not reserved tickets or a current checkout price. Null `direct` must remain unknown, not become a nonstop flight.

The identical unauthenticated server request returned HTTP 403. Therefore this source is **not connected to production price search**. Do not mark it active, inject static observed prices, replay browser security cookies, or treat indexed prices as runtime search results. Next integration gate: demonstrate regular supported server or browser-rendering access, validate route/month/currency and sold-out handling, then obtain the reverse direction independently before composing a return trip. The source still requires evidence for TLV routes and the user's June 1–5 search.

SAS investigation on the same date: `https://www.flysas.com/se-en/flight-routes/copenhagen/athens` loaded normally in a browser, but a direct server fetch returned 403. The page displays monthly minima and a trip-length calendar. Monthly minima alone do not establish prices for an exact selected date pair. A dated calendar response still needs investigation before enabling a SAS price adapter.

## What we can ship now

The production site now includes an overlay/bookmarklet flow:

1. Open an airline site.
2. Click the EEE Overlay bookmarklet.
3. The script injects an iframe from `https://eee-web-bly.pages.dev/overlay`.
4. The overlay reads the current page URL only, saves a sanitized link through `POST /api/flight-links`, detects source/airline/route/date where possible, and opens the EEE search page with the route filled so the engine can create date and stay combinations.

The overlay remembers links. It does not collect prices by itself and does not fulfill the automatic airline-price collection objective.

## API findings from official sources

| Source | API status | What it can do | Blocker |
| --- | --- | --- | --- |
| Lufthansa Group | Official developer APIs exist. Fares/Availability covers Lufthansa, SWISS, Austrian, Eurowings, fare/availability and deep links. | Good candidate for direct API adapter. | Requires API account and use case approval for fare/availability plan. |
| Turkish Airlines | Official developer portal includes Get Availability, Get Timetable, airport data. | Good candidate for Turkish adapter. | Account setup uses OTP/MFA and app approval. |
| Air France-KLM | Official developer/NDC portal exists. | Candidate for Air France and KLM NDC content. | Registration and NDC access approval required. |
| British Airways / IAG | NDC hub and developer documents exist. | Candidate for BA/IAG NDC adapter. | Commercial/developer onboarding required. |
| Emirates | Emirates Gateway Direct exposes NDC APIs to trade partners. | Candidate for Emirates direct content. | Trade partner onboarding required. |
| Qatar Airways | Oryx Connect includes Oryx Direct API for offers, fares and ancillaries. | Candidate for Qatar direct content. | Trade partner/agency onboarding required. |
| easyJet | Distribution Charter defines Direct API Agreement and approved API channels. | Candidate through approved channels or direct agreement. | Agreement required, no open public API. |
| Ryanair | Public materials describe data access through approved/direct distribution arrangements. | Candidate only through approved access. | No open public scraping; approved access needed. |
| Duffel | Public Flights API for offers and booking flow. | Best near-term multi-airline API candidate if account is approved. | Requires Duffel account/API key and commercial terms. |
| Amadeus | Flight Offers Search/Price APIs are available through Amadeus for Developers. | Strong multi-airline API candidate for shopping and pricing. | Requires Amadeus credentials and production approval for live use. |
| Travelport | Flights API v11 provides REST/JSON air shopping workflows. | Strong multi-airline/GDS candidate. | Provisioning and credentials required. |
| Sabre | Offers and Orders / GDS APIs exist. | Strong multi-airline/GDS candidate. | Sabre account/provisioning required. |

## Implementation rule

The current user explicitly requested automatic collection of public airline prices. Prefer working official APIs, and collect public dated fares or normally accessible rendered pages when appropriate. A manual link is not evidence of price coverage.

1. Official direct airline API, where credentials exist.
2. Multi-airline API/GDS such as Duffel, Amadeus, Travelport, Sabre.
3. Automatic parsing of public official fare pages with exact departure/return dates, currency and ticket structure, using the shared public cache.
4. Normal server-side browser rendering where needed, with bounded runtime and cache reuse. Do not solve or bypass security challenges, replay private browser cookies, or present empty/challenge pages as price sources.
5. Manual link/overlay memory remains a supplementary feature, not a replacement for automatic prices.

## Runtime collection probes — 2026-10-08 UTC

- Cloudflare Browser Run Quick Actions were exercised using an isolated local Wrangler worker with a real remote browser binding, not deployed publicly. No credentials, cookies, custom identity headers or challenge interaction were supplied.
- Official EL AL page: `https://www.elal.com/flight-deals/en-il/`. The Quick Action JSON envelope reported success, but the rendered HTML result was only 574 characters, with no `__NEXT_DATA__`, round-trip text or USD fare values. Browser transport success therefore does not prove usable airline data. No automatic EL AL adapter was enabled from this probe.
- Quick Actions return an envelope containing a string `result`; future adapters must unwrap it before parsing HTML and validate actual fare records. Reference: https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/
- The isolated probe was stopped after inspecting the result. Existing production bindings and source behavior were preserved.
- Aeromexico official origin page discovered from its own indexed page: `https://www.aeromexico.com/en_us/flights-from-los-angeles`. A normal server request returned HTTP 403. Indexed prices were not imported or represented as fresh runtime prices. No Aeromexico adapter was enabled.
- These results leave all-airline automatic coverage incomplete. Next work must establish a usable, repeatable runtime response before connecting either source.

### Worker-origin verification supersedes desktop-only failures

Normal requests were repeated from an isolated **remote Cloudflare Worker preview** (not a browser-cookie session). Results differ from desktop Python requests, so a desktop 403 alone must not mark an airline inaccessible in production.

| Official page | Worker response | Dated structured records | Current action |
| --- | --- | --- | --- |
| `https://www.skyexpress.gr/en/flights-from-athens` | 200 | 43 raw records, including business fares | Economy-only adapter deployed; exact ATH–FCO December 13–18, 2026 price EUR 101.80 confirmed in production D1. Source participates in combinations and hourly collection. |
| `https://www.aerlingus.com/en-ie/flights-from-dublin` | 200 | 14 raw records | Integration pending: cabin label `low` and each-way versus round-trip meaning must be validated. Explicit one-way examples exist; do not treat transatlantic each-way prices as complete round trips. |
| `https://www.voegol.com.br/en/flights-from-sao-paulo` | 200 | 34 raw records | Connected and verified in production: GRU–MCZ, 2026-12-09 to 2026-12-16, USD 341.23. Parser/cache preserve actual CGH, GRU and SAO origins; exact-query matching rejects fares from other airports. |
| `https://www.avianca.com/en_us/flights-from-miami-to-cali` | 403 | 0 | Not connected. |
| `https://www.copaair.com/en/flights-from-panama-city` | 503 | 0 | Not connected. |

The SKY express source returns official published advertisements, not held inventory or a final checkout. It remains limited to the dated fares actually exposed by its Athens origin page. This does not prove coverage of every route, date, passenger count, or airline.

## Aer Lingus Cloudflare execution evidence — 2026-10-08

A fresh isolated Cloudflare remote Worker preview fetched `https://www.aerlingus.com/en-ie/flights-from-dublin` using ordinary HTTPS fetch (no browser cookies or authentication). HTTP 200; 1,085,604 HTML characters; 14 raw `Fare` records. Explicit dated one-way examples:

| Airports | Departure | Amount | Raw cabin | Structure |
| --- | --- | --- | --- | --- |
| DUB–AMS | 2027-01-26 | EUR 41.45 | low | ONE_WAY |
| DUB–FAO | 2027-04-13 | EUR 77.47 | low | ONE_WAY |
| DUB–ACE | 2027-02-01 | EUR 76.25 | low | ONE_WAY |
| DUB–MAN | 2026-12-07 | EUR 23.32 | ECONOMY | ONE_WAY |

This establishes a usable public transport and exact dated fare records, not production integration. Next implementation must accept explicitly one-way fares only, verify the cabin mapping for `low`, and exclude transatlantic ROUND_TRIP records whose visible price is per direction. Do not treat those amounts as round-trip totals or infer the missing return price. The remote preview was stopped after verification.

### Aer Lingus production integration verified

Worker b432c57377ef enabled the Aer Lingus adapter and hourly public cache warming. Full worker suite: 2,142 tests passed; TypeScript and frontend production build passed. Production exact DUB–MAN 2026-12-07 to 2026-12-10 generated a real cross-carrier fare: EI outward EUR 23.32 plus FR return EUR 30.99 = EUR 54.31. Production D1 preserved both independently priced legs. FR alone EUR 48.61 was cheaper and won ranking. Aer Lingus transatlantic partial round-trip records are excluded. Coverage remains sparse dated advertisements and one adult; no checkout or universal coverage claim.

## Air Serbia ordinary Cloudflare fetch — 2026-10-08

Both previously observed public calendar endpoints returned HTTP 200 JSON from a fresh remote Worker preview with no cookies, authentication, challenge solving or special browser headers:

- `https://www.airserbia.com/api/destination/flight-prices/BEG/ATH?year=2027&month=1&pos=GLOBAL`
- `https://www.airserbia.com/api/destination/flight-prices/ATH/BEG?year=2027&month=1&pos=GLOBAL`

Response keys: origin, destination, year, month, source, prices. Both source values were `db`. Each daily record exposes price, currency, direct, soldOut; direct was null and soldOut false. Observed BEG–ATH 2027-01-04 EUR 60.36; ATH–BEG 2027-01-08 EUR 74.74. Do not yet sum these as a purchasable itinerary: one-way passenger/cabin semantics, cached-fare age and agreement with booking results still require validation. Many later days share the same amount; this alone neither proves inventory nor invalidity. This public transport is accessible and is the next actionable candidate for integration, not a confirmed production source.

Aeromexico `https://www.aeromexico.com/en_us/flights-from-los-angeles` returned HTTP 200 but only 5,340 characters and zero NEXT_DATA fare records from the same Worker. Indexed public HTML exposes dated round-trip advertisements, but normal Worker response currently does not. Do not interpret HTTP 200 as collected fare data. The preview was stopped after two-direction verification.

Follow-up browser verification: the official destination page loaded normally after its automatic security check. The visible departure calendar (BEG to ATH, EUR, one adult) showed 4 January 2027 = 60 EUR, 8 January = 60 EUR, 11 January = 48 EUR, matching the API amounts after display rounding. Its notice says displayed fares were recorded within the last 24 hours and may no longer be available at booking. This supports calendar-advertisement classification, not final checkout validation. Next: establish selected one-way fare semantics and verify the reverse calendar before enabling the runtime adapter.

Further UI contract verification: DOM radio input `tripType=oneWay` was checked, `return` unchecked, with one adult and EUR. Selecting 4 January set departure to 2027-01-04 and enabled Show flights without requiring a return. Opening the return calendar then showed 8 January = 75 EUR, matching the independently fetched ATH–BEG API EUR 74.74 after rounding. A pure parser now retains dated one-way amounts, route/month identity and known db provenance, and excludes sold-out, missing, non-EUR and invalid-date entries. Three parser tests and TypeScript passed. Runtime adapter and quote/cache integration remain pending; the calendar is not final checkout inventory.

### Air Serbia production source enabled and verified

Commit 8d4387dc01b4 connected the verified BEG–ATH/ATH–BEG monthly calendars, ten-minute isolate/shared public cache, independent direction amounts and cross-carrier combination input. No unsupported route requests or group fare scaling. Full suite: 2,147 tests passed; TypeScript and frontend build passed. Production exact 2027-01-04 to 2027-01-08 returned source air_serbia enabled/ok, two calls and one offer: EUR 60.36 outward + EUR 74.74 return = EUR 135.10 (ILS 464.22). Result retains both ticket prices, unknown hours/stops and calendar advertisement notice. It is two separately priced one-way tickets, not guaranteed combined checkout inventory. Other Air Serbia routes remain unverified and unconnected.

## American Airlines Cloudflare execution evidence — 2026-10-08

Ordinary fetch from a fresh isolated remote Worker returned HTTP 200 for `https://www.aa.com/en-us/flights-from-los-angeles-to-mexico-city`, 2,168,045 HTML characters and 10 raw Fare records (including duplicates/incomplete headline). Explicit cash ECONOMY ROUND_TRIP LAX–MEX 2027-01-20 to 2027-01-27 was USD 451.63, consistent with the visible official card rounded to USD 452. Other observed pairs with the same published amount: 2026-12-01 to 12-08, 2027-01-21 to 01-28, 01-22 to 01-29, 01-26 to 02-02, 01-27 to 02-03, 02-02 to 02-09, 02-05 to 02-12. No authentication, cookies or browser challenge replay. Preview stopped after verification.

Parser now recognizes the official AA host and allows this carrier up to 3 MB HTML, retaining the original 2 MB bound for other sources and the existing 100,000-node limit. Three added tests preserve exact date pairs/cash amounts, reject incomplete/redemption records and enforce both size bounds. Runtime source, cache and background collection wiring remain pending. These are dated advertisements, not guaranteed final checkout fares or route-wide inventory.

### American Airlines production source verified

Commit 2b98838f8785 connected LAX–MEX dated published fares to quote comparisons, shared/isolate cache and hourly background collection. Full suite: 2,152 tests passed; TypeScript and frontend production build passed. Production exact 2027-01-20 to 2027-01-27 returned american enabled/ok, one call and one offer. AA airline row was ILS 1,388.31, corresponding to the official USD 451.63 fare. A competing USD 306 SerpApi offer won ranking; connecting the official source does not privilege it over a lower comparable fare. Repeated same query returned fromCache true with zero American calls. This proves current sparse exact-route source operation, not all American routes/dates or final checkout availability. Worker version 4e6d1724-81a6-4747-ab16-3adc845661a0; Pages deployment 2e7fab5c.

## Automatic production collection observed — 2026-10-08 00:43 UTC

Read-only production D1 inspection immediately after the hourly schedule found official published fare rows with identical job checked_at `2026-10-08T00:43:20.000Z`: air_baltic 8, air_canada 3, air_europa 16, air_new_zealand 25, american 8, ethiopian 29, gol 19, philippine 2, sky_express 20, tap 9, virgin_atlantic 12. Total 151 dated round-trip fare rows across 11 airline sources. This is authoritative evidence of the scheduled collector executing and persisting real official prices, rather than merely a deployed timer or manually requested search. Aer Lingus exposes one-way rows only, which the collector warms in the public cache but does not store as round-trip D1 offers; its cache warming is not independently proven by this query. The same timestamp also had 60 travelpayouts rows from the separate scheduled snapshot task, excluded from the official-airline total. No user searches were submitted during this job observation.

## Remaining-source Cloudflare transport checks — 2026-10-08

A fresh isolated remote Worker with ordinary HTTPS fetch (no authentication/cookies) requested these discovered official pages:

| Source/page | HTTP | Evidence | Next action |
| --- | --- | --- | --- |
| United `/en/us/deals/flights-from-tel-aviv-to-orange-county` | 520 | 16 characters, no fares | Examine official browser booking/calendar transport or authorized distribution route; no usable price source yet. |
| Qatar `/en-eg/destinations/flights-to-doha/from-london.html` | 520 | 16 characters, no fares | Examine official browser booking/calendar transport or authorized distribution route; no usable price source yet. |
| American `/en-il/flights-from-tel-aviv` | 200 | 1,462,405 characters; only an incomplete Fare with null dates/airports/amount | Keep it excluded until the page actually publishes dated cash fares. Existing LAX–MEX source is not evidence for TLV coverage. |

The remote preview was stopped. A failure for one page is not proof that every endpoint or source-access method for that airline is unavailable.

## KLM rendered collection route proven — 2026-10-08

Normal remote Worker fetch of `https://www.klm.co.il/en-il/flights-from-tel-aviv` and Air France `https://wwws.airfrance.co.il/en-il/flights-from-tel-aviv` returned HTTP 520, 16 characters and no fares. A separate development probe using the existing account's Cloudflare Browser Run binding then loaded both pages through `BROWSER.quickAction("content", { url, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }, rejectResourceTypes: ["image","font","media"] })`. No authentication, copied cookies, challenge solving or billing upgrade. The returned JSON envelope must be unwrapped via `result` to obtain rendered HTML.

KLM: success true, HTTP 200, title Cheapest flights from Tel Aviv | KLM, 1,035,009 HTML characters, NEXT_DATA present, no challenge text. Actual dated Economy Round Trip records: TLV–AMS 2026-12-07 to 12-14 and 12-05 to 12-08 USD 419.17; TLV–YYZ 12-02 to 12-09 and 12-03 to 12-31 USD 829.87; TLV–SFO 12-08 to 12-29 and 12-03 to 12-31 USD 1003.96; TLV–GOT 12-05 to 12-12 USD 341.17. One incomplete headline record is excluded. Parser now recognizes the exact official KLM host and validates dated cash Economy records.

Air France: rendered success true, HTTP 200, 778,455 HTML characters, NEXT_DATA present, no challenge text, but only an incomplete Fare with all identifying/price fields null. Do not enable this empty page as a priced source.

Both isolated rendering probes completed in about six seconds each and the dev process was stopped. Next implementation: render KLM in bounded background collection, persist its dated advertisements and serve cached/D1 results to searches; do not launch a browser per user search or claim unlimited rendering capacity. Existing Browser Run free daily limits remain in force; no upgrade authorized or applied. Runtime KLM source integration remains pending.

### KLM background integration and search proven

Commit 20a6acfe87c1 added a fixed-page, 20-second navigation, one-render-per-hour background collector with Browser Run binding. Search adapter reads public cache only (zero network/browser calls); pipeline D1 enrichment supplies longer-lived stored dated offers. The collector unwraps success/result HTML, limits envelope and HTML size, persists exact dated economy fare rows and contains failures so other cron tasks continue. No billing upgrade, arbitrary URLs or browser launch per user query.

A one-use verification harness invoked the same collector with remote production D1 and Browser Run: ok true, 7 fares, 7 saved. The harness was stopped. Production exact TLV–AMS 2026-12-07 to 12-14 returned KLM enabled/ok, calls 0, offers 1 and a displayed KLM card USD 419.17 (ILS 1,288.53). A competing SerpApi USD 405 card ranked ahead. Worker version 8fdaae60-40f3-465c-8ab7-51dc9719587f; Pages 9d7b691f. The deployed hourly timer has not yet been independently observed firing this new rendered collector; manual harness execution and actual production search are proven. Other routes/dates and checkout inventory remain unproven.

## Aeromexico hosted-browser evidence — 2026-10-08

The standard Cloudflare Browser Run content action successfully rendered
https://www.aeromexico.com/en_us/flights-from-los-angeles in approximately eight seconds.
The response was successful, contained dated Fare records in __NEXT_DATA__, and showed no challenge.
Selected records include LAX–MEX, 2027-06-02 through 2027-06-09, USD 431.63,
MAIN_BASIC, ROUND_TRIP; and LAX–ACA, 2027-01-17 through 2027-01-23,
USD 775.50, MAIN_CLASSIC, ROUND_TRIP.
The visible official page identifies these as economy round-trip advertisements
available within the previous 48 hours, with possible extra baggage charges.
The parser now supports only the observed economy cabin identifiers for AM.
Automatic collection, search-source wiring, cache integration and production verification
remain outstanding; this evidence does not imply Aeromexico is enabled in production.
Same-day round-trip records remain unsupported rather than receiving invented dates.

The reusable Aeromexico background loader was subsequently run with the real
remote Cloudflare browser binding and its ten-second navigation bound. It returned
28 valid dated fares, including the exact LAX–MEX June 2–9, 2027 USD 431.63 record.
The loader bounds the rendering payload at four million bytes before JSON parsing.
Eighteen targeted tests and the Worker typecheck pass. Production scheduling and
search integration are still pending; no additional hourly browser usage is enabled.

## Aeromexico production integration — 2026-10-08
The background collector saved 28 exact round-trip advertisements to production D1.
Deployment f03f98c enables hourly collection and a cache-only user search source.
The production search LAX–MEX June 2–9 2027 returned aeromexico enabled/ok,
one offer and zero upstream calls; the airline price was ILS 1326.83 (USD 431.63).
SerpApi returned a cheaper USD 297 offer, which correctly ranked first.
All 2164 Worker tests passed with two workers; typecheck and web build passed.
The first highly parallel run timed out two tests and caused cascading log assertions;
the bounded rerun passed every test. A registry expectation was updated for the new source.
Both browser collectors have ten-second navigation bounds. Hourly scheduled Aeromexico
execution has not yet been observed; the actual collector was verified by a one-time run.
Coverage is only the published LAX-origin dated fares, not all airline routes or final checkout.
