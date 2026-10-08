# Icelandair official published fares

Verified on 2026-10-08 using the real Cloudflare Browser Run binding and the
production collector/parser/cache-source code.

Official page: https://www.icelandair.com/en-gb/flights/flights-from-london-to-iceland

The ordinary rendered page exposes cash economy round-trip advertisements in
`__NEXT_DATA__`. Airport-specific LHR/LGW–KEF records are accepted. City-only
LON/REK, reward fares, promo fares, missing/unknown cabin, incomplete dates and
nonpositive prices are excluded. Dates and decimal totals are retained exactly.

The verification collected eight valid fares. The cached source returned
LHR–KEF 2026-11-28 to 2026-12-03 at GBP 172.25. Changing the return to December 4
returned no offer. The source made zero upstream requests during the search.
The probe deliberately disabled history writes; it did not write to production D1.

Scheduled collection uses the existing bounded browser queue at 02, 08, 14 and
20 UTC. Public cache is populated before optional history persistence. A failed
history write leaves valid collected prices available from the cache. Existing
browser and storage allowances still apply; future scheduled success is unproven.

These are sparse published advertisements, not booking-session prices. The source
does not establish inventory for arbitrary routes/dates, flight times, stops or
baggage. Its link points to the official published page. Final booking price and
availability require verification at the airline. Only one adult is supported.

Production end-to-end search remains unverified while the D1 daily read allowance
is exhausted. A successful browser probe and cache quote do not prove a successful
production search or an automatically executed scheduled collection.
