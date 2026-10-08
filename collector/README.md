# External airline fare collection

This collector runs Chromium on GitHub Actions (or another Node 24 host), not Cloudflare Browser Run. It periodically reads approved public fare pages and sends observed anchors to the authenticated Worker ingestion endpoint. The Worker validates the source, route, dates, amount and currency using its existing parsers, then writes a ten-minute snapshot directly to the shared Durable Object. No D1 writes, passenger information, credentials from airline accounts, or reservations are involved.

Currently supported: the observed Lufthansa ATH–TLV, SWISS ZRH–TLV, Austrian VIE–TLV, and Brussels BRU–ATH advertisement pages. These are dated advertisements, not live checkout inventory. All requested airlines and arbitrary routes are still incomplete.

`COLLECTOR_KEY` must be stored as both a GitHub Actions secret and a Worker secret. Never commit it or place it in a URL. `COLLECTOR_ENDPOINT` is fixed to this project endpoint. Run `npm ci`, `npx playwright install --with-deps chromium`, then `node collect.mjs` on the collector host.

Scheduled collection is gated by the repository variable `EXTERNAL_COLLECTOR_ENABLED=true`; this remains unset until actual collection succeeds. Manual dispatch is available for diagnosis. The workflow requests collection every ten minutes, with one run at a time and a five-minute job timeout. GitHub schedules can be delayed, jobs can fail, and public-repository schedules can be disabled after extended inactivity. Neither the schedule nor upstream availability guarantees continuous fresh data. Expired observations are not guaranteed prices. The website still uses Cloudflare Worker and Durable Object requests; external collection only removes Cloudflare browser usage for sources actually migrated.

`EXTERNAL_LHG_COLLECTOR=true` switches the four existing search providers to direct shared-cache reads (avoiding older regional snapshots and D1 fallback) and suppresses their Cloudflare browser cron jobs. Enable only after a real external run has published usable prices. Other airline collectors and on-demand Aegean still use their existing paths until separately migrated.

Challenges, access denials and invalid pages produce a failed source result; no challenge or session bypass is implemented. One failing source does not discard successfully published snapshots from other sources.

Initial live GitHub runs returned HTTP403 from all four official pages. No usable snapshot was published and `EXTERNAL_LHG_COLLECTOR` was not enabled. This collector is infrastructure for migration, not a working replacement for these sources yet.

## Public JSON calendars

`public-calendar-probe.yml` separately collects Ryanair ATH–FCO and FCO–ATH, and Air Serbia BEG–ATH and ATH–BEG, for June 2027. These observed official public endpoints require no browser or airline account. The authenticated ingestion endpoint parses raw responses with the production parsers and stores ten-minute snapshots. Manual run 37738262906 successfully published 30 priced days per direction (120 total). A subsequent production ATH–FCO search reported Ryanair `calls: 0`, `offers: 1`, demonstrating shared snapshot use without another upstream request.

`EXTERNAL_CALENDARS_ENABLED=true` enables this separate ten-minute GitHub schedule. It covers only these four route/month calendars; arbitrary searches still use existing on-demand collection. Regional and isolate caches can retain an earlier observation until its original ten-minute expiry. GitHub delays can create freshness gaps, and these advertised calendar prices are not guaranteed booking-cart prices. The blocked LHG collector remains disabled.

The collection catalog now covers both June and July 2027 (eight route/month calendars). Run 37738653140 published all 244 daily observations successfully. A production BEG–ATH July 1–5 search returned EUR97.10 with `air_serbia` reporting zero upstream calls and preserved advertisement/calendar provenance tags. These results establish collection and search consumption for the named calendars, not coverage of all routes or all airlines. Calendar target tests check month alignment and malformed inputs.

## Additional browser-free source evidence

Manual `public-page-probe.yml` run 37738820567 fetched six approved official pages from GitHub and parsed them using the unchanged production `parsePublishedFares` parser: Air Canada 4 fares, TAP 10, Philippine Airlines 3, Aer Lingus 10, Virgin Atlantic 10, Air New Zealand 26 (63 dated advertisements total). All returned HTTP200 without a browser. The artifact contains exact dates/routes/currencies for follow-up validation. This probe does not publish snapshots yet, and the counts do not establish June/July 2027 availability, complete airline inventory, or checkout prices. Next step is authenticated ingestion of the validated official page data and production search verification before enabling scheduled collection for these sources.
