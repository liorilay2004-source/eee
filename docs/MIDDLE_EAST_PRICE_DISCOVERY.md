# Official airline source observations — 2026-10-08

Scope: public official HTTP pages. No authentication, payment, reservation, or challenge bypass.

- Royal Jordanian https://www.rj.com/ returned HTTP 200. Its linked public script /scripts/NextFrontend/nextFrontend.min.js?v=1.0.0 defines /redirect/to/Bookings/BookRestFlight and route lookup /redirect/to/Bookings/GetFlightRouteOriginDestination. These are website search/route interfaces, not proven fare APIs. The home-page calendar initializer passes an empty price map (const e={}); do not treat calendar decoration code as price inventory. Next action: inspect the search redirect response and its actual booking engine, preserving session-bound links where needed.
- EgyptAir https://www.egyptair.com/ returned HTTP 403. No price inventory demonstrated.
- Oman Air https://www.omanair.com/ returned HTTP 200 with only 212 characters. No price inventory demonstrated.
- Saudia https://www.saudia.com/ returned HTTP 200 with 6,183 characters. No price inventory demonstrated.

These observations do not establish working production price adapters. Raw capture evidence is kept outside the repository. Kenya Airways already provides explicit dated public fares through observed official pages; other sources still require separate research and integration.
