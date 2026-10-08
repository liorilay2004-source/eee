# Brussels Airlines public dated advertisements

Observed on 2026-10-08 using the ordinary official page:
https://www.brusselsairlines.com/lhg/be/en/o-d/cy-cy/brussels-athens

The page displays a calendar for one traveller, Economy, 14 days. Its visible
anchors include both airport codes and both dates in the official booking URL.
Observed June row: `from 184 €`, BRU–ATH, 2027-06-04–2027-06-18.
Observed July row: `from 184 €`, BRU–ATH, 2027-07-13–2027-07-27.

The headline displayed 151 EUR while a May calendar anchor displayed 150 EUR for
the same date pair. The parser therefore rejects conflicting claims for a date
pair. Headline Product JSON-LD has no dates and must not become a dated quote.
Flight JSON-LD describes schedules including Aegean-operated codeshares; it must
not be attached to an advertised price as if it identifies the selected flight.

The parser accepts only the observed official market/path and explicit round-trip
date pairs. It retains original currency, checked time and advertised-price
classification, with unknown operating carrier. The search adapter reads collected
data only for one adult and exactly matching BRU–ATH dates. Checkout price still
requires verification. These
advertisements do not provide TLV–ATH June 1–5 coverage or arbitrary date coverage.

## Cloudflare collection verification

On 2026-10-08 at 03:37:51 UTC, an actual remote Cloudflare Browser Run binding,
invoked through a local Wrangler Worker, rendered the ordinary official page.
`loadRenderedBrussels` extracted public anchors using Workers HTMLRewriter and
returned 25 accepted advertisements, including June 4–18 and July 13–27 at EUR184.
The conflicting May pair was excluded. The probe used no D1 reads or writes,
did not create a reservation and did not handle security cookies or credentials.
The renderer bounds its response to 4MB and selected anchors to 500.
Type checking and all 12 parser tests passed after this runtime verification.

The integrated collector/provider was then verified with an actual remote Browser
Run binding and Workers Cache API: 25 advertisements collected, June 4–18 returned
EUR184 with zero upstream search calls; June 4–19 returned no offer. Cache lookup
and both provider calls together took 11ms in that probe, not an end-to-end search
latency measurement. No D1 access occurred. Prices retain the collection timestamp
and are rejected after 36 hours. Scheduled collection runs at 06/18 UTC inside the
existing browser queue, which keeps its limit of two concurrent browser jobs.
Future scheduled runs and a complete production search remain unverified while
the production D1 daily read allowance is exhausted.

## Tel Aviv coverage investigation

On 2026-10-08, ordinary browser navigation verified the official outbound pages:

- https://www.brusselsairlines.com/lhg/be/en/o-d/cy-cy/tel-aviv-brussels
- https://www.brusselsairlines.com/lhg/il/en/o-d/cy-cy/tel-aviv-brussels

Both displayed TLV–BRU schedules and an ordinary search form, but no dated price
calendar or priced advertisement anchors. Switching to Israel used the page's
visible Change country link; no market or currency was inferred from geography.
Opening the date picker produced an ordinary two-month date selector, not prices.
Attempting the site's Find flights flow led to a Security Check browser verification
page. No challenge was solved or bypassed, and no security cookies were extracted.
The search did not produce verified prices or verified selected dates. Thus neither
outbound TLV–BRU fares nor the June 1–5 pair is enabled by this adapter. Reverse
BRU–TLV marketing prices in a search index cannot supply outbound TLV–BRU fares.

Next integration step for outbound coverage requires an ordinary booking flow that
returns actual fare data, or an authorized distribution API. The BRU–ATH collector
remains a separate verified source with its explicitly limited observed coverage.
