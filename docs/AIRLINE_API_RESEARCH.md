# Airline APIs and overlay plan

Updated: 2026-09-30

## What we can ship now

The production site now includes an overlay/bookmarklet flow:

1. Open an airline site.
2. Click the EEE Overlay bookmarklet.
3. The script injects an iframe from `https://eee-web-bly.pages.dev/overlay`.
4. The overlay reads the current page URL only, saves a sanitized link through `POST /api/flight-links`, detects source/airline/route/date where possible, and opens the EEE search page with the route filled so the engine can create date and stay combinations.

This avoids brittle scraping and still lets the user collect direct airline pages and build combinations.

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

Do not scrape airline websites by default. Use one of these layers, in order:

1. Official direct airline API, where credentials exist.
2. Multi-airline API/GDS such as Duffel, Amadeus, Travelport, Sabre.
3. Manual link/overlay memory with route/date parsing.
4. Browser automation only as a manually approved diagnostic tool, not production pricing.
