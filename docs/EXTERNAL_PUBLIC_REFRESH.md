# Public airline refresh and selected-date demand

## Implemented coverage

These are dated public airline advertisements, not confirmed checkout offers. Native cash amounts and actual airport codes are preserved. No operating carrier, flight times, baggage allowance or seat availability is inferred from website ownership.

| Collector | Approved public pages | Observed airport-pair identities | Refresh |
| --- | ---: | ---: | --- |
| EVA Air | 50 | 66 | Scheduled page collection disabled |
| Royal Air Maroc | 1 | 26 | Scheduled page collection disabled |
| China Airlines | 1 | 2 | Scheduled page collection disabled |
| Korean Air | 1 | 1 | Scheduled page collection disabled |
| Aegean HTTP calendar | Selected TLV–ATH or ATH–TLV trip | Exact requested dates | Automatic demand collector disabled |

The catalog contains observed page URLs and airport identities, with no prices. RAM uses the observed French EUR page. China Airlines city pages retain their actual TSA–HND and TPE–NRT airport pairs. Korean's registry identity remains `korean`; its quote source is `korean_air`.

## Push versus scheduled collection

Airline pages are not live subscriptions. The supported collectors in this project fetch published pages when explicitly run; no airline fare-change webhook or public fare event stream is configured. Scheduled page collection is disabled by default and the local Windows collector tasks have been disabled. Normal user searches can still request configured sources.

IATA NDC is an airline-to-seller API standard, not a universal airfare push feed. NDC OrderChangeNotification is for changes to an existing order (such as a schedule change), not notifications when an unbooked fare or seat inventory changes. A real price listener requires a provider contract that offers fare events/webhooks and credentials; without that, the system cannot receive silent fare changes from airline websites.

## Refresh guarantees and limits

- Every capture is taken before fetching the source. Publication retains that capture and source-stated relative ages.
- Snapshot lifetime is ten minutes from the original capture. Publication accepts captures at most two minutes old. Refreshing a search cache cannot renew an old quote's capture.
- The collector submits raw source records; the Worker independently parses them and acknowledges the original capture and exact fare count. A failed request, missing schema or nonempty malformed Fare list cannot become a successful empty publication in the additional-source collector.
- EVA publishes each page immediately through two lanes, with a 500 ms start gap, a 260-second collection deadline and a 270-second process deadline. Actual feasibility proof: 50/50 pages in 25.17 seconds, 405 valid fares, no errors. This is one measured run, not a future availability promise.
- Native currencies are not compared directly. Search comparisons use independently dated FX, including a TWD supplement where needed.

## Exact selected-date queue (paused)

The exact-date queue is disabled with `AEGEAN_ON_DEMAND_ENABLED=false` until a push-capable provider or explicit user-triggered flow replaces its local polling collector. Existing queue records expire after 30 minutes.

An empty search no longer waits on the local demand queue or shows a queued-refresh state. Cached public calendar data may still appear with its age label; normal direct search providers remain request-driven.

## Local collection controls

Collectors use the existing DPAPI-protected credential, an isolated child environment, separate mutexes and output directories outside Git. Their scheduled Windows tasks are currently disabled. Raw observations, receipts and metadata remain in the user's scoped collector directory.

The local computer and user session must be available. Airline throttling, source changes and Cloudflare Worker/DO quotas still apply. D1's exhausted daily read allowance does not prevent an independently stored public snapshot from returning a price, but other pages/features may still depend on D1. This does not establish all-airline/all-route coverage, a globally cheapest result or a fully populated checkout link.

Production receipts and release identifiers are recorded after deployment verification.
