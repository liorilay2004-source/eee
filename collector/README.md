# External airline fare collection

This collector runs Chromium on GitHub Actions (or another Node 24 host), not Cloudflare Browser Run. It periodically reads approved public fare pages and sends observed anchors to the authenticated Worker ingestion endpoint. The Worker validates the source, route, dates, amount and currency using its existing parsers, then writes a ten-minute snapshot directly to the shared Durable Object. No D1 writes, passenger information, credentials from airline accounts, or reservations are involved.

Currently supported: the observed Lufthansa ATH–TLV, SWISS ZRH–TLV, Austrian VIE–TLV, and Brussels BRU–ATH advertisement pages. These are dated advertisements, not live checkout inventory. All requested airlines and arbitrary routes are still incomplete.

`COLLECTOR_KEY` must be stored as both a GitHub Actions secret and a Worker secret. Never commit it or place it in a URL. `COLLECTOR_ENDPOINT` is fixed to this project endpoint. Run `npm ci`, `npx playwright install --with-deps chromium`, then `node collect.mjs` on the collector host.

Scheduled collection is gated by the repository variable `EXTERNAL_COLLECTOR_ENABLED=true`; this remains unset until actual collection succeeds. Manual dispatch is available for diagnosis. The workflow requests collection every ten minutes, with one run at a time and a five-minute job timeout. GitHub schedules can be delayed, jobs can fail, and public-repository schedules can be disabled after extended inactivity. Neither the schedule nor upstream availability guarantees continuous fresh data. Expired observations are not guaranteed prices. The website still uses Cloudflare Worker and Durable Object requests; external collection only removes Cloudflare browser usage for sources actually migrated.

`EXTERNAL_LHG_COLLECTOR=true` switches the four existing search providers to direct shared-cache reads (avoiding older regional snapshots and D1 fallback) and suppresses their Cloudflare browser cron jobs. Enable only after a real external run has published usable prices. Other airline collectors and on-demand Aegean still use their existing paths until separately migrated.

Challenges, access denials and invalid pages produce a failed source result; no challenge or session bypass is implemented. One failing source does not discard successfully published snapshots from other sources.

Initial live GitHub runs returned HTTP403 from all four official pages. No usable snapshot was published and `EXTERNAL_LHG_COLLECTOR` was not enabled. This collector is infrastructure for migration, not a working replacement for these sources yet.
