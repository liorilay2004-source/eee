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
classification, with unknown operating carrier. No production adapter is enabled
yet: Worker collection and checkout price still require verification. These
advertisements do not provide TLV–ATH June 1–5 coverage or arbitrary date coverage.
