# Aegean selected round-trip calendar

## Observed source

The official public controller at `https://en.aegeanair.com/en/sys/lowfares/RouteLowFares/` supplies contextual outbound and inbound calendar rows. The implemented HTTP path is restricted to the observed TLV–ATH and ATH–TLV routes, valid dates and round trips. Other existing Aegean routes retain their previous collection path.

The selected TLV–ATH trip of 1–5 June 2027 was fetched successfully on 8 October 2026. Its selected cash rows were EUR 104.63 outbound and EUR 127.74 inbound, totaling EUR 232.37. Both rows reported an update on 7 October 2026. This is an advertised calendar price, without checkout, availability, operating-carrier, time, stops or baggage confirmation.

Only exact selected rows are used. The parser rejects missing dates, duplicate days, non-economy records, errors, unknown service fees, unequal displayed/full prices, future update times and unexpected currency. The two contextual rows are never exposed as independent one-way tickets or replaced with monthly minima.

## Refresh and storage

The Durable Object coalesces requests for one selected trip and stores successful results for ten minutes from the original pre-fetch capture. The public HTTP route does not reserve or fall back to Browser Rendering. Failures have a five-minute cooldown and cannot renew an existing capture.

`collector/probe-aegean-http-calendar.mjs` can publish the original raw records through authenticated ingestion. `collector/run-local-aegean.ps1` selects at most twelve unique trips, uses the existing protected local collector credential only in its hidden child process and stores observations and receipts outside Git. The default is the exact 1–5 June trip. Local scheduled collection requires the computer and user session to be available; Worker and Durable Object limits still apply.

Ingestion authenticates before reading the body, requires a canonical capture no more than two minutes old and reparses the raw selected rows. Invalid or empty extraction cannot erase a saved price. It writes no D1 rows and never fetches a caller-provided URL.

Original outbound/inbound `Updated` values and their decoded UTC timestamps remain separate from capture time. Search displays the oldest update when both directions are known, without claiming that this was the time the price was found or verified for booking.

Cache-hit searches use the adapter's separate stored-snapshot reader, with zero airline requests. They preserve existing Travelpayouts capture/expiry while incorporating newer selected Aegean captures. Wider flexible searches still inspect only the bounded date-pair sample; this does not prove that every date or the globally cheapest fare was searched.

## Production verification, 8 October 2026

Commit `b6a41a740ce5` was pushed and deployed as Worker version `ddb510ec-3fa3-4223-b977-bb8133b599f3`; health confirmed that build. All 4,295 Worker tests passed in the full root run, typecheck passed, five collector tests passed and the unchanged frontend built successfully.

The first cold production search still returned HTTP 503 with `storage_daily_limit`; direct HTTP collection from Cloudflare did not establish a usable selected snapshot in that request. Local authenticated publication then succeeded. The next exact TLV–ATH search returned HTTP 200 in 2,126 ms with EUR 232.37, original capture `2026-10-08T12:19:25.032Z`, source update `2026-10-07T00:00:00.000Z`, and Aegean `enabled=true`, `ok=true`, `offers=1`, `calls=0`. The stable frontend was reloaded and visibly showed the exact 1–5 June 2027 trip, EUR 232.37 / approximately ILS 799, the update label and official selected-trip calendar link. This proves the external snapshot path, not cold-search availability for every trip.

`EEE-Aegean-HttpCalendarCollector` is enabled with a five-minute repetition interval. Its first automatic trigger at 15:21 Israel time completed successfully: task `Ready`, result 0, one selected trip/one accepted fare and zero errors. Original observations and receipts are outside Git under `%USERPROFILE%\.codex\eee-local-collector\aegean\20261008T122109406Z-953d44c6`. The default refresh currently covers this one selected trip only. Arbitrary-date external demand collection and full airline coverage remain unfinished.

Additional read-only HTTP evidence for the existing ATH–FCO route on 25–29 January 2027 showed EUR 49.44 outbound and EUR 71.36 inbound, totaling EUR 120.80. This route has not yet been added to the new HTTP allowlist; its production behavior remains the earlier collection path.
