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

A Cloudflare Browser Run probe failed at the rendering response on 2026-10-08.
Automatic collection through Cloudflare has not been proven. No source, schedule
or production feature flag is enabled for Austrian. Cache/storage integration,
search-provider integration and checkout-price verification remain incomplete.
No passenger details, reservation, account sign-in or payment were submitted.
