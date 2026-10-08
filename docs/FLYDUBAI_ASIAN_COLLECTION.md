# Official fare collection: flydubai, EVA Air and Vietnam Airlines

## Observed coverage, 8 October 2026

| Provider | Approved price pages | Actual page–airport-pair identities | Wider observed inventory |
| --- | ---: | ---: | ---: |
| flydubai | 17 | 17 | 451 |
| EVA Air | 10 | 24 | 116 |
| Vietnam Airlines | 1 | 1 | 1 |

Approval records only identities found in actual public response data. It does not mean every route, date or airline is covered. Price snapshots are advertisements and are not verified checkout reservations.

EVA's observed economy records include TPE–NRT on 13–17 June and 12–16 July 2027 at TWD 17,532. Vietnam's numeric records and rounded website display values are kept distinct in collector evidence. These examples describe observations; later refreshes can change them.

## Capture and search contract

- Collectors send unchanged bounded raw records to authenticated `/api/internal/public-fares`; the Worker reparses only approved official pages and airport identities.
- The original capture timestamp is required and must be no more than two minutes old at ingestion. Snapshots expire ten minutes after that original capture.
- flydubai accepts explicit one-way amounts or round trips whose return is after departure. Same-day advertised return fields cannot become a holiday itinerary. Its cabin, operating carrier, times, stops and baggage are unknown.
- EVA accepts explicit Economy Basic with economy metadata; Vietnam accepts Economy Super Lite with economy metadata. Rewards and promotion records are excluded. Website ownership does not establish an operating carrier.
- Searches use exact selected dates, one adult, no children or infants. Cached adapters issue zero upstream airline requests. Same-currency combinations require two explicit one-way prices. Different-currency combinations are not inferred.
- Reported relative price age is preserved independently of capture time. Reading a page again does not change the vendor's reported age.
- Empty clearing requires a validated explicit price schema. Failed fetches or missing schemas do not renew or erase existing captures.

## Refresh execution

GitHub publication workflows are separately gated by `EXTERNAL_FLYDUBAI_ENABLED`, `EXTERNAL_EVA_ENABLED`, and `EXTERNAL_VIETNAM_ENABLED`. They must remain disabled until runner connectivity and refresh timing are verified. flydubai discovery run `37769423691` timed out for its first two GitHub batches while local requests succeeded; its terminal status was verified as `completed` with conclusion `cancelled`, last updated `2026-10-08T11:43:19Z`. It was not restarted and does not establish price coverage.

Local runners `collector/run-local-flydubai.ps1` and `collector/run-local-asian.ps1` use a separate `LOCAL_COLLECTOR_KEY`. The encrypted DPAPI credential is outside Git at `%USERPROFILE%\.codex\secrets\eee-local-collector.dpapi`. It is decrypted only into a hidden child process environment; it is never written to logs. The existing GitHub credential remains independent.

Local runs use provider-specific mutexes, a 270-second execution bound, at most twenty approved pages, and original raw observations plus receipts under `%USERPROFILE%\.codex\eee-local-collector\<provider>`. Local scheduling depends on this computer and user session being available. It avoids Cloudflare browser minutes; Worker and Durable Object quotas still apply.

## Comparison currency

Missing requested AED/TWD rates are supplemented from the existing no-key ILS endpoint documented at https://www.exchangerate-api.com/docs/free . Original UTC and Unix publication timestamps must agree and be within seven days. Conversion is reciprocal because the payload is foreign units per ILS. Primary rates remain unchanged and the oldest contributing publication day is retained. Results include the required provider attribution link.

No paid plan, reservation, payment, challenge bypass or airline account was created by this integration.
