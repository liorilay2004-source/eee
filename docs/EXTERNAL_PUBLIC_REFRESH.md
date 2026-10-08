# Public airline refresh and selected-date demand

## Implemented coverage

These are dated public airline advertisements, not confirmed checkout offers. Native cash amounts and actual airport codes are preserved. No operating carrier, flight times, baggage allowance or seat availability is inferred from website ownership.

| Collector | Approved public pages | Observed airport-pair identities | Refresh |
| --- | ---: | ---: | --- |
| EVA Air | 50 | 66 | All pages every five minutes |
| Royal Air Maroc | 1 | 26 | Every five minutes |
| China Airlines | 1 | 2 | Every five minutes |
| Korean Air | 1 | 1 | Every five minutes |
| Aegean HTTP calendar | Selected TLV–ATH or ATH–TLV trip | Exact requested dates | Demand poll every minute; existing June 1–5 warm refresh retained |

The catalog contains observed page URLs and airport identities, with no prices. RAM uses the observed French EUR page. China Airlines city pages retain their actual TSA–HND and TPE–NRT airport pairs. Korean's registry identity remains `korean`; its quote source is `korean_air`.

## Refresh guarantees and limits

- Every capture is taken before fetching the source. Publication retains that capture and source-stated relative ages.
- Snapshot lifetime is ten minutes from the original capture. Publication accepts captures at most two minutes old. Refreshing a search cache cannot renew an old quote's capture.
- The collector submits raw source records; the Worker independently parses them and acknowledges the original capture and exact fare count. A failed request, missing schema or nonempty malformed Fare list cannot become a successful empty publication in the additional-source collector.
- EVA publishes each page immediately through two lanes, with a 500 ms start gap, a 260-second collection deadline and a 270-second process deadline. Actual feasibility proof: 50/50 pages in 25.17 seconds, 405 valid fares, no errors. This is one measured run, not a future availability promise.
- Native currencies are not compared directly. Search comparisons use independently dated FX, including a TWD supplement where needed.

## Exact selected-date queue

The queue stores only origin, destination, departure date and return date; no passenger identity, IP address or caller URL. It supports only the two empirically proven public HTTP routes. It deduplicates exact trips, retains at most 64 active/tombstone rows, expires activity after 30 minutes and claims atomically with a five-minute attempt cooldown. Polling returns at most 12 eligible trips and does not mutate the queue.

The private GET/POST `/api/internal/aegean-demand` endpoint uses the existing collector credential in the Authorization header. POST claims one validated trip. Successful exact-trip ingestion acknowledges the queue with the original capture; acknowledgement failure does not discard a valid stored fare.

An empty search returns `source_refresh_pending` only after confirmed active demand. The frontend waits and performs at most three automatic checks, one minute apart. Cancellation, editing, going offline and unmounting clear the waiting timer; leaving the page also aborts an in-flight request. No price or completion time is promised.

## Local scheduling

Collectors use the existing DPAPI-protected credential, an isolated child environment, separate mutexes and output directories outside Git. Tasks run with the current interactive Windows user, hidden child processes, `IgnoreNew` and bounded execution time. Raw observations, receipts and metadata remain in the user's scoped collector directory.

The local computer and user session must be available. Airline throttling, source changes and Cloudflare Worker/DO quotas still apply. D1's exhausted daily read allowance does not prevent an independently stored public snapshot from returning a price, but other pages/features may still depend on D1. This does not establish all-airline/all-route coverage, a globally cheapest result or a fully populated checkout link.

Production receipts and release identifiers are recorded after deployment verification.
