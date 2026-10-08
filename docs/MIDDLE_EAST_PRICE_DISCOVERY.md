# Official airline source observations — 2026-10-08

Scope: public official HTTP pages. No authentication, payment, reservation, or challenge bypass.

- Royal Jordanian https://www.rj.com/ returned HTTP 200. Its linked public script /scripts/NextFrontend/nextFrontend.min.js?v=1.0.0 defines /redirect/to/Bookings/BookRestFlight and route lookup /redirect/to/Bookings/GetFlightRouteOriginDestination. These are website search/route interfaces, not proven fare APIs. The home-page calendar initializer passes an empty price map (const e={}); do not treat calendar decoration code as price inventory. Next action: inspect the search redirect response and its actual booking engine, preserving session-bound links where needed.
- EgyptAir https://www.egyptair.com/ returned HTTP 403. No price inventory demonstrated.
- Oman Air https://www.omanair.com/ returned HTTP 200 with only 212 characters. No price inventory demonstrated.
- Saudia https://www.saudia.com/ returned HTTP 200 with 6,183 characters. No price inventory demonstrated.

These observations do not establish working production price adapters. Raw capture evidence is kept outside the repository. Kenya Airways already provides explicit dated public fares through observed official pages; other sources still require separate research and integration.

## Royal Jordanian public search validation

A public round-trip search AMM–LHR, 2026-11-08 to 2026-11-13, one adult, succeeded after using the form's observed economy cabin value E (not Y). The website requires its own freshly issued anti-forgery context and cookies; these were obtained normally from the public home page and were not logged or committed. HTTP 200 returned an auto-submitting form to https://booking.rj.com/plnext/royaljordanianB2CDX/Override.action. This proves a search handoff, not fare retrieval or a reservation. Next step: submit that search form within its original session and inspect the price response. Do not present the handoff alone as a working price adapter.

## Search-engine and Gulf source follow-up

Royal Jordanian's observed Override.action search handoff returned HTTP 200 with 30,187 characters, but the body is an Imperva/hCaptcha protection page rather than flight results. Status 200 is not proof of fare access; no price adapter was enabled. No CAPTCHA bypass attempted.

flydubai's official home page provided concrete destination-page links. The observed https://www.flydubai.com/en-il/flights-to-tbilisi/ returned HTTP 200, 333,058 characters, with zero standard Fare records. It links /system/js/search-widget.min.js?v=12 and a Next.js page bundle. Next action: inspect the actual public data schema and search widget, rather than guessing prices or APIs. Air Arabia returned 403, Kuwait Airways fetch failed, and Etihad's home page returned 200 without observed fare-page links in this pass.

flydubai's observed production Next.js runtime configuration and route bundle both specify https://www.flydubai.com/api/Calendar, passed as the search-widget calendarurl attribute. The widget bundle also embeds a development default; that default must not be used as the production source. Runtime configuration is evidence of a public interface location, not successful fare retrieval. Continue by tracing the calendarurl consumer and the exact request schema.

## flydubai low-fare request traced

The official route bundle calls GET /{siteLang}-{siteCountry}/flights/api/lowfare/ with the page's seofaremonthlycardtabs.data[].apiParams and journeytype overwritten to OWRT. The client accepts only array rows with amount, owAmount, owDepartureDate, departureDate and returnDate. Observed en-il Tbilisi page parameters: sitelang=en, resultype=distinctdate, org=TLV, dest=TBS, searchrange=6, totalcards=1, rangetype=Months, faretype=Low, pagelayout=to-city. The actual request returned HTTP 200 JSON null. The independently observed Male page provided dest=MLE and otherwise the same parameters; that request also returned HTTP 200 JSON null. Neither is usable price inventory. Next: investigate other routes/locales actually linked by the official pages and the calendar request schema, without assuming null means no flights globally.
