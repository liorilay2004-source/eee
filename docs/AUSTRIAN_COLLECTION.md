# Austrian Airlines collection evidence

Verified in an ordinary browser on 2026-10-08:

- https://www.austrian.com/lhg/at/en/o-d/cy-cy/tel-aviv-vienna
- https://www.austrian.com/lhg/at/en/o-d/cy-cy/vienna-tel-aviv

The first page displayed schedules and a booking form without priced calendar
advertisements. The second was reached through its visible return-flight link
after rejecting optional cookies. It displayed one Economy traveller and 14-day
round trips, with both dates explicit in official aircore booking links.

Observed dated advertisements:

- VIE–TLV June5–19 2027: EUR252.
- VIE–TLV July1–15 2027: EUR377.
- September8–22 2027: EUR253 headline versus EUR252 calendar; rejected as conflicting.

The parser validates the original EUR, direction, both real dates, exact official
host and Austrian market. It never derives carrier, stops, baggage or flight times
from unrelated schedules, nor reverses a round trip into a TLV departure.

An initial Cloudflare rendering probe failed; a subsequent ordinary Browser Run request succeeded. At 2026-10-08T04:19:57.168Z the bounded renderer returned 25 advertisements, including the June EUR252 and July EUR377 pairs, and excluded the contradictory September pair. Direct public HTTP retrieval returned 403 and is not used as a collection fallback.
No passenger details, reservation, account sign-in or payment were submitted.

The integrated collector caches public fares before optional monthly D1 snapshot writes. A probe at 2026-10-08T04:22:16.419Z used a deliberately unavailable D1 stub and still cached 25 advertisements. The provider returned EUR252 for VIE–TLV June5–19 2027, rejected June20 return and reverse direction, and used zero airline calls. Three adapter queries took 18ms; this is not full production search latency. The source/UI and twice-daily schedule (11/23 UTC) are implemented. Production cron execution, D1 persistence after quota reset, full arbitrary-date coverage and checkout-price verification remain unproven.
