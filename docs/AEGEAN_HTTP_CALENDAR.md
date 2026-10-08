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
