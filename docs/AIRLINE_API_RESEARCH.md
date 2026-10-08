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
| `https://www.voegol.com.br/en/flights-from-sao-paulo` | 200 | 34 raw records | Integration pending: origin page mixes CGH, GRU and SAO. Parser/cache must preserve actual origins instead of attributing all records to one airport. |
| `https://www.avianca.com/en_us/flights-from-miami-to-cali` | 403 | 0 | Not connected. |
| `https://www.copaair.com/en/flights-from-panama-city` | 503 | 0 | Not connected. |

The SKY express source returns official published advertisements, not held inventory or a final checkout. It remains limited to the dated fares actually exposed by its Athens origin page. This does not prove coverage of every route, date, passenger count, or airline.
