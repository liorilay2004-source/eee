# Airline website scraping audit

**Checked:** 7 October 2026

**Scope:** The 98 airline records in [`worker/src/source-registry.ts`](../worker/src/source-registry.ts), plus Air Haifa as an Israel-market candidate.
**Related work:** [GitHub Epic #41](https://github.com/liorilay2004-source/eee/issues/41)

## Result

None of the audited sites met all three requirements for a live source: an ordinary public page returns an itinerary price for the requested route, dates, passengers and baggage; the fare and availability are current enough to compare; and the site provides a basis for the proposed commercial reuse and polling frequency. Some public pages show sample “from” prices, but those are not a quote for the user's search. Several search pages are JavaScript shells, blocked, or excluded by robots rules. A page fetch timestamp must not be presented as the time the airline's fare was last updated.

No website source should be marked `LIVE` or polled hourly on the evidence below. Robots permission alone does not grant commercial reuse permission. Where a normal GET returned a bot/access challenge or an access denial, the audit stopped without retries, browser automation, search submission, endpoint probing, proxying, or identity/locale changes.

## Method

The audit used ordinary GET requests to official public pages, robots files, and linked terms pages. It did not use airline APIs or inspect client-side network calls. A redirect to a public page was followed at most once where noted. HTTP outcomes describe this audit environment and may change. “No permission found” means no affirmative permission was verified in the pages reviewed; it is not a legal conclusion.

## Results by airline

### Israel

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| EL AL | The public [Flight Deals](https://www.elal.com/flight-deals/en-il/) page describes round-trip, one-adult Economy fares with taxes/surcharges, but may reflect searches up to 12 hours old. An ordinary GET from this environment returned HTTP 492. It does not provide flight times, stops, or baggage details. | Robots allowed the public page, but this is neither a full quote nor a confirmed current fare. Mark blocked from this environment; do not label verified. |
| Israir | Public sale pages returned a short, empty HTML response (HTTP 200); no usable fare was parsed. | No exact price or affirmative commercial-scraping permission verified. |
| Arkia | Site and robots requests returned HTTP 403. | Blocked; stop. |
| Air Haifa *(outside registry)* | Public site was reachable, but fare/deals pages returned HTTP 403. Indexed “from” prices were not directly retrievable as a fare response. | Website terms prohibit copying, redistribution, or commercial use without prior written permission. Not suitable absent permission. |

### Europe

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| Turkish Airlines | Tested offers pages returned 404; no fares. Robots excludes promotion and booking-availability paths. | Terms prohibit commercial use and automated copying. Not suitable. |
| Pegasus | [Best Deals](https://www.flypgs.com/en/best-deals) returned campaign content, not a selected-trip fare. | Robots blocks search paths; no commercial permission verified. |
| Aegean | [Low-fare calendar](https://en.aegeanair.com/flight-deals/low-fare-calendar/) returned empty fare templates. | Robots blocks parameterized search pages; terms limit use to personal/non-commercial purposes. Not suitable. |
| Wizz Air | Official home request returned HTTP 405 with a human-verification page. | Blocked; stop. |
| Ryanair | [Cheap flights](https://www.ryanair.com/gb/en/cheap-flights) redirected to a JavaScript fare-finder shell with no fares. | Robots blocks `/api`, booking, and flight-search paths. No affirmative commercial permission verified. |
| easyJet | [Example route page](https://www.easyjet.com/en/cheap-flights/BRS/AGP) returned a JavaScript-required page without a date-specific fare. | No commercial scraping permission verified. |
| Lufthansa | [Offers](https://www.lufthansa.com/us/en/offers) returned no fare cards. | Robots blocks deep links/secured services; terms prohibit automated collection and displaying Lufthansa prices on another site. Not suitable. |
| SWISS | Homepage and tested offers page had no query-specific fares. | Terms restrict use to viewing/booking and require written consent for embedding the site elsewhere. Not suitable absent consent. |
| Austrian Airlines | [Offers and destinations](https://www.austrian.com/us/en/offers-destinations) returned no fares. | No scraping permission verified; not an exact-price source. |
| Air France | Tested offers page was unavailable. Robots blocks search, check-in, and payment paths. | Terms require prior written permission for scraping or commercial copying. Not suitable. |
| KLM | [`/deals`](https://www.klm.com/deals) listed destinations and trip types but no amounts or travel dates. | Robots allows that bare path but blocks query variants and `/deals/`; no commercial permission verified. |
| British Airways | [Offers](https://www.britishairways.com/content/en/us/offers) showed promotions/packages, not date-specific flight quotes. | Robots blocks the low-fare search tool. No commercial permission verified. |
| ITA Airways | Homepage contained generic “from” promotions without dates, availability, or a full itinerary quote. | No commercial-scraping permission verified. |
| Iberia | [All offers](https://www.iberia.com/il/all-offers/) returned no flight fares in ordinary HTML. | Robots blocks search/booking paths. No commercial permission verified. |
| TAP Air Portugal | Homepage loaded; `/pt-pt/ofertas` timed out. No price obtained. | Robots blocks `/search` and `/api`; no commercial permission found in the linked legal center. |
| Vueling | [Price calendar](https://www.vueling.com/en/price-calendar) returned a form without route/date fares. | Robots blocks some query parameters; terms restrict commercial use/copying. Not suitable. |
| LOT | [Deals and offers](https://www.lot.com/pl/en/explore/deals-and-offers) showed campaigns only. | Robots blocks APIs, calendar prices, and flight searches; terms prohibit commercial use/copying without written consent. |
| SAS | Homepage loaded; `/en/offers/` returned 404. No fares. | Robots blocks query strings and booking paths. No commercial permission verified. |
| Finnair | [Offers](https://www.finnair.com/en/offers) showed sample one-way “from €133” pricing, without a selected route/date/pax quote. | Robots blocks search/fare selection. Terms were not verified as granting commercial scraping. Not suitable hourly. |
| Icelandair | [Special offers](https://www.icelandair.com/frequent-flyer/special-offers/) showed membership/ancillary campaigns, not flight fares. | Robots blocks `/api/`; no commercial scraping permission verified in the linked terms. |
| Norwegian | [Low-fare calendar](https://www.norwegian.com/uk/low-fare-calendar/) required JavaScript and returned no fares. | Terms prohibit automated commercial extraction. Not suitable. |
| Aer Lingus | Homepage and robots requests returned HTTP 405 “Pardon Our Interruption.” | Blocked; stop. |
| Brussels Airlines | [Promotions](https://www.brusselsairlines.com/il/en/offers) returned no flight prices. | Robots blocks deep links/secured services. No commercial permission verified. |
| Eurowings | [Low-fare calendar](https://www.eurowings.com/en/booking/flights/low-fare-calendar.html) returned no fares; cached response was about 24 hours old. | Terms §3.5 prohibit commercial use of site data and flight prices, including automated access. Not suitable. |
| Air Europa | [Flight offers](https://www.aireuropa.com/en-us/flight-offers) required JavaScript and returned no prices; response was cached up to four hours. | No commercial permission verified. Not suitable for exact hourly prices. |
| Transavia | Homepage showed route/date “from” promotions, not complete itinerary prices. | Terms prohibit commercial collection/extraction from consumer channels absent express authorization; robots blocks search parameters. Not suitable absent authorization. |
| SunExpress | Linked “Sunny Offers” page returned HTTP 400. No fares. | No basis for commercial hourly scraping. |
| Jet2 | [Great deals](https://www.jet2.com/en/great-deals) showed a holiday deposit amount, not a flight fare. | Robots blocks Low Fare Finder; terms explicitly prohibit commercial manual/automated extraction of prices and schedules. Not suitable. |
| Volotea | Robots request returned an Incapsula challenge page. | Blocked; stop. |
| airBaltic | Homepage had no fares; [flight deals](https://www.airbaltic.com/en/flight-deals/flights) returned HTTP 403. | No permission verified; page blocked. |
| Virgin Atlantic | [TLV–JFK fare page](https://flights.virginatlantic.com/en-il/flights-from-tel-aviv-to-new-york) showed monthly/range “from” fares, marked “Seen: 18 hours ago”; page says fares may have been gathered within 48 hours and may no longer be available. | Terms limit use to personal/non-commercial purposes and require written consent for some reuse. Not a quote for selected dates/passengers; not suitable for verified hourly tracking. |
| Air Serbia | [Special offers](https://www.airserbia.com/en/explore/special-offers) returned no prices. | Terms limit use to personal, non-commercial purposes and restrict copying. Not suitable. |
| Croatia Airlines | [Offers](https://www.croatiaairlines.com/offers) showed route “from” prices without dates or availability. | Terms require written consent to reproduce site information. Not suitable absent consent. |
| TAROM | [Destinations](https://www.tarom.ro/en/destinatii) showed a price-evolution heading but no price values. | Robots blocks API paths. No exact fares or commercial permission verified. |
| Bulgaria Air | [Offers](https://air.bg/en/offers) showed “from” prices and an overall travel-validity period, not availability for the selected trip. | Terms prohibit commercial use/reproduction and automated access. Not suitable. |
| Georgian Airways | Homepage showed route “from” prices without dates or availability. | Legal notice requires written permission to copy/distribute content. Not suitable absent consent. |
| Smartwings | Robots request returned HTTP 403 with a managed challenge. | Blocked; stop. |
| Ukraine International Airlines | Robots request timed out. | Unverified; no retry. No basis for use. |

### Middle East and Africa

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| Emirates | [Special offers](https://www.emirates.com/il/english/special-offers/) returned campaign content, not a query-specific fare. | Terms restrict use to personal/non-commercial purposes and prohibit unreasonable automated access. Not suitable for commercial hourly monitoring. |
| Etihad Airways | [Offers](https://www.etihad.com/en/offers) returned promotions, not matched itineraries. | Terms limit use to personal/non-commercial purposes and prohibit copying/distribution. Not suitable. |
| Qatar Airways | [Offers](https://www.qatarairways.com/en/offers.html) returned loading placeholders. | Robots disallows several offer-page variants. No exact fares or affirmative permission verified. |
| flydubai | [Offers](https://www.flydubai.com/en/offers/) returned promotions, not matched itineraries. | Terms limit commercial use and restrict bots/copying. Not suitable. |
| Air Arabia | [Best Offers](https://www.airarabia.com/en/plan/reservation/best-offers) returned Angular placeholders with no amounts. | Terms did not establish commercial scraping permission. Not an exact fare source. |
| Gulf Air | Robots request returned HTTP 403. | Blocked; stop. |
| Oman Air | Guessed public offers page returned 404; homepage had no fare content. | Terms restrict reproduction/distribution absent prior written permission. Not suitable. |
| Saudia | Public promotions request displayed “Pardon Our Interruption” bot text. | Blocked; stop. |
| Royal Jordanian | Student offer page contained a campaign but no fare amount. | No exact fare or commercial scraping permission verified. |
| Kuwait Airways | Robots request returned HTTP 500. | Unverified; no retry or other probing. |
| EgyptAir | Tested offers page returned 404; homepage redirected to a generic page without fares. | No fare or permission evidence. |
| Ethiopian Airlines | Offers pages contained promotions, not ticket-level fares. | Terms explicitly prohibit scraping and displaying Ethiopian prices elsewhere. Not suitable. |
| Kenya Airways | Localized booking page showed route/date “from” cards with a “viewed” age, not user-selected flight details. Some were already 15 hours old. | Website security policy prohibits copying/displaying content for third-party redistribution absent written permission. Not suitable. |
| South African Airways | Flights page and robots requests returned HTTP 403. | Blocked; stop. |
| Royal Air Maroc | Homepage had no fare cards. Robots disallows `/web/` and `/int/` paths. | No exact fares or commercial permission verified. |

### Americas

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| Air Canada | Homepage showed sample route/date “from” fares, disclosed as collected within 48 hours and subject to change. No flight times/stops or selected-bag price. | Terms prohibit data mining/screen scraping and commercial access. Not suitable. |
| American Airlines | [Round-trip deals](https://www.aa.com/en-us/round-trip-deals) showed sample route/date “from” fares and update ages, not arbitrary-query results or baggage totals. | Terms prohibit scraping/extraction and commercial third-party travel services absent written agreement. Not suitable. |
| Delta Air Lines | [Current flight deals](https://www.delta.com/us/en/flight-deals/current-flight-deals) returned headings without fare cards. | Terms require express written permission for scraping; robots disallows flight-search paths. Not suitable. |
| United Airlines | [Deals](https://www.united.com/en/us/deals/flights/fares-from-washington-dc-under-250) returned a JavaScript shell with no fares. | Robots disallows fare-calendar/reservation paths. No commercial scraping permission verified. |
| Southwest | [Flights page](https://www.southwest.com/en/flights/) showed sample route/date “from” fares with “seen” ages, no full itinerary or bag total. | Terms ban page-scraping/automated monitoring and limit content to personal, non-commercial use. Not suitable absent written authorization. |
| Alaska Airlines | Homepage had no parseable fare cards; tested deals path returned 404. | Robots blocks results/calendar/shopping paths. No commercial permission verified. |
| JetBlue | Homepage had no airfare cards; tested deals paths returned 404. | Terms require prior written consent for automated scraping and restrict use to personal/non-commercial purposes. Not suitable. |
| Spirit Airlines | First robots request returned HTTP 403 from the network environment. | Blocked; stop. |
| Frontier | Homepage showed a pass promotion, not route/date fares. Tested deals path returned 404. | Terms explicitly prohibit scraping/automated monitoring. Not suitable. |
| Hawaiian Airlines | Homepage had no parseable fares; tested deals URL redirected to the homepage. | Robots blocks results/calendar/shopping paths. No commercial permission verified. |
| Aeroméxico | Deals URL redirected without yielding a fare page. | No fare or commercial permission evidence. |

### Latin America

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| LATAM Airlines | Homepage returned a booking form and deal-card templates, not displayed fares; getting a quote requires submitting a search. | Some robots exclusions also cover legal pages. No exact fare or commercial permission verified. |
| Avianca | Homepage and robots requests returned HTTP 403. | Blocked; stop. |
| Copa Airlines | Homepage and robots requests returned HTTP 401/challenge content. | Blocked; stop. |
| Azul | Homepage and robots requests returned HTTP 403. | Blocked; stop. |
| GOL | Homepage showed campaign text without a fare; linked deals page returned HTTP 403. | No fare or commercial permission verified; stop after denial. |

### Asia and Oceania

| Airline | Public GET result | Reuse and hourly fit |
|---|---|---|
| Air China | Homepage and robots requests returned HTTP 503 from the upstream connection. | Unverified; stopped without retry or alternate host. |
| China Eastern | Redirected homepage returned a title only; robots returned 404. | No fare data or commercial permission verified. |
| China Southern | Homepage returned minimal HTML without fares; robots disallows `/about/`. | No fare data or commercial permission verified. |
| Hainan Airlines | Public page returned an Imperva interruption page identifying bot traffic. | Blocked; stop. |
| Cathay Pacific | Tested offer URL redirected to a regional home page with campaigns and booking placeholders, but no matched fare. | No exact quote or commercial permission verified. |
| Singapore Airlines | Tested offer page returned 404; homepage booking widget remained “Loading”. | Robots has a crawl delay; no query fare or permission verified. |
| Scoot | Tested deals URL returned 404; no fare page was found. | Terms restrict reuse absent prior written permission. Not suitable. |
| Malaysia Airlines | Promotions page loaded a JavaScript-required shell without amounts. | No exact fares or commercial permission verified. |
| Thai Airways | Promotions page showed route campaigns and validity dates, not a user-matched total. | Robots specifies a crawl delay; terms/permission were not verified. Not suitable for exact hourly tracking. |
| Vietnam Airlines | Tested senior offer page contained no price amount; it was a restricted campaign. | No generic fare quote or commercial permission verified. |
| Philippine Airlines | Tested promotions page returned 404; homepage showed no offer content. | No fare or permission evidence. |
| Garuda Indonesia | Promotion URL returned generic homepage content without fare amounts. | No query quote or commercial permission verified. |
| Japan Airlines | Redirected booking page said JavaScript was required; no result was returned. | Website policy requires consent for reuse outside private/law-permitted use. Not suitable absent consent. |
| ANA | Tested promotion path returned 404 and the site indicated JavaScript was required. | No fare or commercial permission evidence. |
| Korean Air | Promotion page returned empty HTML; booking/calendar paths are excluded by robots. | No fare or permission evidence. |
| Asiana Airlines | Tested promotions endpoint returned 404 JSON; terms page redirected to a temporary-error page. | No fare or permission evidence. |
| EVA Air | Promotions page returned static campaign/navigation text without a price. | No commercial-scraping permission verified. |
| China Airlines | Special-offers page contained static campaign text, including one route/amount, without selected dates, passengers, bags, or availability. | Terms provided no affirmative scraping permission. Not a current quote. |
| Air India | Deals page showed coupon/promotional “from” pricing, not a matched itinerary total. | Terms expressly prohibit scraper/robot access without written permission. Not suitable. |
| IndiGo | Offers page is disallowed by robots; it was not fetched. | Terms restrict copying/transfer/sale of site content. Do not scrape. |
| Qantas | Homepage request returned HTTP 503 due to an upstream reset. | Unverified; no retry. |
| Virgin Australia | Specials link led to a page with an Akamai challenge; no fare was obtained. | Terms prohibit bots/scraping and reuse of fare/availability data without prior written consent. Not suitable absent consent. |
| Air New Zealand | Public booking page showed undated, per-person round-trip “from” cards. | Terms require prior written permission to monitor, extract, publish, or distribute site material. Not suitable. |
| Air Astana | Public homepage returned an Incapsula interruption; robots disallows query strings and booking/result paths. | Blocked; stop. |
| Uzbekistan Airways | Specials page showed undated route “from” prices, without availability, taxes, baggage, or fare class. | Robots allows the path, but that is not reuse permission; no commercial permission verified. Not suitable. |
| Azerbaijan Airlines | Homepage returned almost no visible content; sitemap request returned a challenge. Robots disallows search-like query patterns. | No fare or commercial permission evidence; stop after challenge. |

## Scheduler implications

The existing Worker cron runs hourly, but saved watches are checked roughly once a day from stored fare history. Its limited live fallback is not an airline website scan. EL AL's page reader is used only on an interactive search, is capped locally at 100 requests/month, and has not passed a live request in this environment. A page may be fetched hourly while its displayed fare is still cached or undated; that must not be called an hourly price refresh.

The Epic should remain open. Add a site to the hourly watcher only after the site owner grants the required use/frequency in writing or publishes an explicit permission, a normal request returns exact current quote fields, and a fixture-backed adapter keeps the source-fetched time separate from the fare's own age. Until then, show a direct airline booking link or a clearly labeled promotion rather than presenting the page as an exact price source.
