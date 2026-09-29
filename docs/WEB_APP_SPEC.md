# WEB_APP_SPEC — Web UI & Public API (SPEC Phase 2 + API contract)

> Status: **Draft v0.4 for owner review** · Date: 2026-09-29 · v0.4 incorporates three independent read-only review rounds of earlier drafts (34 + 49 + 20 confirmed findings; see §14) and a comparison of §7 with the merged Phase 1 Worker (§7.8).
> Extends [`SPEC.md`](SPEC.md). **`SPEC.md` wins on any conflict.** Where this document interprets or extends `SPEC.md`, it says so in §12 ("Clarifications that need owner approval") — nothing there is treated as decided until approved.
> Language: English, per `SPEC.md` ("code, comments and this spec are in English"). The product UI is **Hebrew only, RTL**; Hebrew UI copy appears as quoted data (Appendix A).
> Scope of this document: specification and delivery plan only. **No code is changed and nothing is deployed by this document.**

---

## 0. Conventions

- **MUST / SHOULD / MAY** are used in the RFC 2119 sense.
- "Engine" = the Python Phase 0 engine (`engine/tpe`) **and** its TypeScript port in the Worker (`worker/src`, Phase 1). Both must produce the same recommendations (parity fixture in Phase 1).
- API field names are camelCase and mirror `worker/src/types.ts`, which mirrors `engine/tpe/models.py` (snake_case). Mapping: §7.7.
- Items marked **NEW** are additions to the current Worker contract (they do not exist yet). Items marked **PROVISIONAL** come from the Phase 1 implementation brief and must be re-verified against the merged Worker.
- The product name is a placeholder (`config/project.json`). The UI reads the name from one constant; this document never hard-codes a brand.

---

## 1. Goals, scope, principles

### 1.1 Goal
A Hebrew, RTL, mobile-first web app where a traveler enters **origin, destination, a date window, a number of nights, passengers and baggage**, and gets **up to three recommendations** — 💰 Cheapest, ⚖️ Best Value, 🎯 Matches My Times — each with an honest statement of what is known, estimated or missing. It links out to book (affiliate); it never sells tickets (SPEC §3).

### 1.2 Scope of the first web release ("v1")
| Area | v1 | Later (SPEC phase) |
|---|---|---|
| Search form (origin, destination, window, nights, passengers, checked bag, time and stops preferences; advanced: nearby airports) | ✅ | — |
| Cabin choice and carry-on/trolley option | ❌ (economy fixed; no carry-on control) | when the engine and a live source support them (C7, C11, D5) |
| Results: 3 recommendations, states, data-quality flags, booking links | ✅ | — |
| Shareable search URL, remember last search on device | ✅ | — |
| PWA (installable, offline shell only) | ✅ | — |
| Minimum legal pages (privacy, terms, affiliate disclosure, accessibility statement) | ✅ before any public exposure (see D6) | full legal review — Phase 4 |
| Spontaneous mode (no destination) and home deals | ❌ v1 requires a destination | Phase 2, iteration W5 (SPEC §9) |
| Accounts (magic link), saved searches (= watches), price alerts, in-app banner | ❌ | Phase 3 (SPEC §10, §11) |
| Hotel links | ❌ | Phase 4 (SPEC §13) |
| Analytics (search → click), "deal" definition | ❌ | Phase 4 |
| One-way search, other languages, browser extension | ❌ | non-goals (SPEC §3) |

### 1.3 Product principles
1. **Never guess (P1).** Every displayed datum is *known*, *estimated* or *unknown*, and estimated/unknown data is **labelled**, never filled in with a plausible default. A missing time is shown as "the time will appear on the booking site", never as a made-up time; unknown stops are never shown as "direct".
2. **SPEC §4.1 semantics (P2).** Unselected paid extras are not added to prices; unset filters restrict nothing; basics take defaults (1 adult, economy, ILS).
3. **Original currency is truth (P3).** Amounts are stored and compared in their original currency; ILS is a display/comparison conversion (SPEC §4.2).
4. **A recommendation needs evidence (P4).** A card is shown only when the data supports its claim (§5.3). Hiding a card is always accompanied by a reason when the user could otherwise be confused.
5. **Honest sources (P5).** The UI states how fresh a price is and whether a source was unavailable.
6. **Privacy by default (P6).** No accounts, no third-party scripts/fonts, no cookies of our own in v1 (§8.5).

---

## 2. Current state and dependencies (as of 2026-09-29)

| Item | State | Consequence for the web app |
|---|---|---|
| Phase 0 engine (`engine/`) | Built; CI green; live Google Flights verified for TLV⇄BCN: 31 offers, ≈ ₪968 cheapest, no blocking (README, measured from a cloud IP); the same search also completed in the Phase 0 workflow on GitHub Actions (run 36559139488: 32 offers, about one minute) — not yet recorded in the README | Reference behavior for recommendations. |
| **Travelpayouts coverage for TLV / ETM** | **Unverified — needs the owner's token.** This is the *blocking* open question in SPEC §17 | The web app's value depends on it (D1, R1). |
| Phase 1 Worker (`worker/`, branch `phase1-worker`) | **In implementation; not reviewed, merged or deployed** | The API contract in §7 is aligned with `worker/src/types.ts` at time of writing and lists required additions. Re-verify before W2. |
| Google Flights data | Background monitor only (Python, GitHub Actions, SPEC §6). The live Worker does **not** call Google | Live results come from Travelpayouts (+ any monitor-written offers already in D1). |
| Cloudflare / deployment | Not deployed (owner decision: not in this step) | **No UI code is written before W0(a) passes** (SPEC §15: "Do not build the UI before Phase 0 proves the data sources work for Israeli routes"). This document is specification only (fixture-only scaffolding before the proof is D16). |

Known engine limitations that directly shape the UI. Items 1–5 are documented in `README.md` ("Known limitations" #2, #3, #4, #2 and #5 respectively); items 6–10 are derived from `SPEC.md` §5 and the current code/models, not from the README:
1. Google round-trip results carry **no return-leg times** (second page on Google).
2. Travelpayouts prices are **per adult**; the engine multiplies by passengers → an **approximation**, especially with children/infants.
3. `config/bag_fees.json` is **placeholder** data; unknown carriers get "bag fee unknown".
4. Best Value estimates an unknown return leg from the outbound leg.
5. When a checked bag is selected, Google is asked to include bag fees in its price; whether it does for every carrier is **unverified**.
6. Carry-on baggage is **not modeled** (only `checkedBag`); cabin class is **not applied** by the live source (Travelpayouts is never queried by cabin).
7. Split tickets have **one** booking link in the model (for Google-sourced splits it is a round-trip search link); a split needs two one-way links.
8. Offers carry airline **codes** only (no names), and Travelpayouts rows carry no arrival time.
9. Best Value gives **zero penalty** to an unknown outbound leg (stops, duration) and to an unknown departure time (`scoring.py`); an unknown return leg is estimated from the outbound leg (item 4). This biases the ranking toward offers with missing data unless the pool is gated (§5.3).
10. **No source reports bag inclusion when no bag was requested** (Travelpayouts rows never set `includes`; Google sets `includes.checkedBag` only when a bag was requested), so 🎁 can appear only if a future source reports it.

---

## 3. Architecture (SPEC §6, plus clarifications C12 and C13)

```
Browser (PWA, Hebrew RTL)
   │  HTTPS, JSON
   ▼
Cloudflare Pages  ── React + Vite + TypeScript + Tailwind (RTL)      [web/]
   │  fetch /api/*  (CORS: exact origin)
   ▼
Cloudflare Worker ── REST API, cache, scoring, affiliate links        [worker/]
   ├── D1  (prices, searches, search_cache, fx_rates, rate_limits, …)
   └── Travelpayouts / Aviasales Data API
GitHub Actions (background) ── Python monitor (Google Flights, split checks) → D1   [Phase 3]
```

**Clarification C12 — live split tickets.** SPEC §6 lists "Split-ticket check: no (uses cached if exists)" for live search. The Phase 0 engine composes split tickets from one-way fares; this document assumes v1 live search does the same with Travelpayouts one-way fares (extra HTTP calls, inside the subrequest cap). If not approved (D3), split cards appear only from monitor-written data (Phase 3) and the split parts of AC-R10 / AC-API4 become conditional.

### 3.1 Web app layout (new directory `web/`)
```
web/
  index.html              lang="he" dir="rtl", <meta name="robots" content="noindex,nofollow"> until launch (D8)
  public/                 manifest.webmanifest, icons (incl. maskable), robots.txt, _headers (CSP etc.)
  src/
    copy/he.ts            ALL user-visible strings (single file → easy legal/UX review)
    config.ts             brand name (from config/project.json), API base URL, limits mirrored from API
    api/                  typed client (fetch + AbortController), error mapping
    lib/                  formatters (money, date, hours, bidi), validation, URL state
    components/           Combobox, Stepper, DateField, HourRange, RecommendationCard, DataFlag, StateViews …
    pages/                SearchPage (form + results), LegalPages (static), NotFound, Offline
  tests/                  unit (Vitest + Testing Library), e2e (Playwright), a11y (axe)
```
- **Stack per SPEC:** React + Vite + TypeScript + Tailwind. No routing library is required (one main view + static legal pages); no date-picker, chart or i18n framework in v1 (Hebrew only). Tailwind **logical** utilities (`ms-*`, `pe-*`, `text-start`) MUST be used instead of left/right.
- **Types:** the web client imports response types from a single re-export of the Worker's contract types (no hand-copied interfaces). Contract fixtures are validated in CI (§11.2).
- **API base URL** comes from build-time config (`VITE_API_BASE`); it contains no secret. The Worker allows exactly one origin via `ALLOWED_ORIGIN` (no wildcard). Preflight is reduced with `Access-Control-Max-Age`.
- **Hosting:** Cloudflare Pages (SPEC §6). Cloudflare's current React+Vite guide deploys the SPA to a Worker with static assets (same origin as the API, no CORS). Both serve the same build output; this document is hosting-agnostic and flags the choice as **D2**.
- **Service worker:** app-shell precache only. Routing: the shell for `/` (query string ignored) and the static legal pages are **precached**; `/api/*` is **network-only, never cached** (prices must not be served stale by the browser); the Hebrew offline page is served only for navigations to URLs that are not precached. Offline behavior is therefore: the form is usable offline, and a submit shows the Offline state (§6).

---

## 4. Screens and flows

### 4.1 Primary journey
```
Open app ─► Search form (S1) ─ submit ─► Loading (S2) ─┬─► Results (S3) ─► tap "להזמנה" ─► partner site (new tab)
     ▲              │ invalid                          ├─► Empty (S4)  ─► suggestions ─► edit search
     │              └─► inline errors (stay on S1)     ├─► Error/Unavailable/Rate-limited (S5) ─► retry / edit
     └─── shared URL / last search prefilled ◄─────────┴─► Partial (banner on S3)
```

### 4.2 Screen inventory
| ID | Screen | Notes |
|---|---|---|
| S1 | Search form | Home. Prefilled from URL or last search. Advanced section collapsed. |
| S2 | Loading | Inline below the form summary; skeleton cards; accessible status. |
| S3 | Results | Up to 3 cards + search summary bar + "search details" disclosure. |
| S4 | Empty result | Distinct from error (§6). Suggestions to widen the search. |
| S5 | Error / unavailable / rate limited | One component, variants by API error code (§7.5). |
| S6 | Legal & info pages | Privacy policy, terms, affiliate disclosure, accessibility statement (static, Hebrew). |
| S7 | Offline / Not found | Hebrew, minimal, link back to S1. |

Layout: a single column, `max-width ≈ 42rem`, centered on desktop; the form collapses into a one-line **summary bar** (route · dates · nights · passengers · "עריכה") once results exist, so results are visible without scrolling on mobile.

### 4.3 Search form (S1) — fields
Defaults follow SPEC §4.1 / §5. "API" = request field (§7.2).

| # | Field (Hebrew label) | API | Required | Default | Control | Client validation (mirrors API; **the API is the source of truth**) |
|---|---|---|---|---|---|---|
| 1 | Origin — "מאיפה טסים?" | `origin` | yes | — (v1.1: last used) | Combobox (§4.4) | must resolve to a location |
| 2 | Destination — "לאן טסים?" | `destination` | **yes in v1** (SPEC: empty = spontaneous, W5) | — | Combobox | must resolve; ≠ origin |
| 3 | Earliest departure — "יציאה מוקדמת ביותר" | `windowStart` | yes | — | native date input | ≥ today; ≤ window end |
| 4 | Latest return — "חזרה מאוחרת ביותר" | `windowEnd` | yes | — | native date input | window length ≤ 120 days (PROVISIONAL) |
| 5 | Nights — "כמה לילות?" min / max | `stayMin`, `stayMax` | yes | — | two number steppers | 1 ≤ min ≤ max ≤ 30 (PROVISIONAL); at least one date pair must fit the window |
| 6 | Adults — "מבוגרים" | `adults` | no | 1 | stepper | ≥ 1 |
| 7 | Children — "ילדים (2–11)" | `children` | no | 0 | stepper | total ≤ 9 |
| 8 | Infants — "תינוקות (מתחת לגיל 2)" | `infants` | no | 0 | stepper | infants ≤ adults; total ≤ 9 |
| 9 | Checked bag — "מזוודה 23 ק״ג לכל נוסע" | `checkedBag` | no | off | checkbox | — |
| 10 | Preferred hours — outbound / return | `outHours`, `retHours` | no | none | hour-range control (§4.7) | integers 0–24; start ≠ end (a `[h,h)` window matches nothing; the whole day is 0–24) |
| 11 | Max stops — "עד כמה עצירות" | `maxStops` | no | none | select: any / direct / ≤1 / ≤2; **disabled until an hour window is set** (§4.7) | — |
| 12 | Nearby airports — "כלול שדות תעופה קרובים" | `nearbyAirports` | no | off | checkbox | — |

Sections: **core** (1–9) always visible; **"העדפות לשעות ולעצירות"** (10–11) and **"מתקדם"** (12) collapsed.
Carry-on / trolley (SPEC §5) and cabin class are **not offered in v1** (D5, C11): the engine does not model carry-on, and the live source (Travelpayouts) is never queried by cabin, so a cabin selector would show economy prices under a business/first label. The API accepts only `economy` in v1. A control that changes nothing would be a lie.

**Transparency line** under the dates/nights (client-side, computed from the same rule as the engine's `valid_pairs`): "בטווח הזה יש N צירופי תאריכים אפשריים" — the count of *possible* pairs, not of pairs that will turn out to have a fare (N ≤ 400 PROVISIONAL; over the limit → inline error asking to narrow the window).

**Semantics copy (mandatory, near the fields):**
- Under the bag checkbox: "לא סימנת? לא נוסיף עלות מזוודה למחיר. אם המקור מדווח שהמחיר כולל מזוודה, נסמן 🎁."
- Under preferences: "ההעדפות האלה משפיעות רק על ההמלצה ‘מתאים לשעות שלי’, לא על ‘הכי זול’ ו‘התמורה הטובה ביותר’." (SPEC §8; see C1/D4.)

### 4.4 Location combobox
- WAI-ARIA combobox (listbox popup). Input accepts **Hebrew, English or IATA** (SPEC §4.3), with the Hebrew-aware normalization done **server-side** by `GET /api/airports` (niqqud, final letters, geresh, hyphens).
- Debounce 200 ms; query ≥ 2 characters (3-letter IATA accepted); at most 8 suggestions; each shows city (Hebrew, English secondary), country, and code(s). A city with several airports resolves to the **city code** (engine expands to airports); a specific airport can be chosen. Display name: `nameHe`, else `nameEn` (marked `lang="en"`), else the code — never transliterate.
- Free text that was not selected from the list is resolved on submit **strictly** by the search endpoint: exact names, aliases, IATA codes and forms like "Barcelona, Spain" pass, but prefix or substring text is rejected with `fields.origin` / `fields.destination` (400). So the UI resolves through `GET /api/airports` before submit (selecting the first suggestion when the user presses Enter is allowed) and shows an inline error when nothing matches; it never silently guesses. The resolved name is **shown back** on the results summary, so a wrong guess is visible (§7.8, Δ8).
- Failure of the autocomplete request MUST NOT block searching by 3-letter IATA code.

### 4.5 Dates and nights
Semantics: every (depart, return) pair with `windowStart ≤ depart`, `return ≤ windowEnd`, `stayMin ≤ nights ≤ stayMax` is a **candidate** (SPEC §7, layer 1). Only pairs for which a source holds a fare produce offers — the wide scan reads the source's known fares, it does not verify every pair live — so the UI never claims that all pairs were checked (§5.1 item 4). Helper text: "נחפש מחירים בטווח התאריכים ובמספר הלילות שבחרתם".
- Native `<input type="date">` in v1 (best RTL/mobile accessibility, zero dependencies). **The native control shows the date in the browser/OS locale format (often MM/DD/YYYY on en-US devices) and cannot satisfy SPEC §14's `DD/MM` by itself**, so an **app-rendered echo** beside each date field shows the chosen date as `DD/MM` plus the weekday, wrapped in `<bdi>` (e.g. "10/11 · יום ג׳"); results and every other place use `DD/MM` (the year is shown when the window crosses a year boundary). A custom range calendar is deferred (D12).
- Dates are dates, not instants: no timezone conversion anywhere in the client.

### 4.6 Passengers and baggage
- Steppers with min/max, ≥ 44 px targets, announced values ("מבוגרים: 2").
- If the total number of passengers is greater than 1, show a persistent note (`form.pax.note`): "מחיר לכמה נוסעים הוא הערכה." — the same trigger as the card flag `price_estimated_pax` (§5.4). The sentence "ילדים ותינוקות עשויים לשלם מחיר אחר." (`form.pax.note.kids`) is added only when children or infants > 0 (D13).
- Checked bag semantics per §4.3. When checked, totals include the engine's fee table (labelled **estimated**, §5.4) and unknown-fee offers are labelled, never guessed.

### 4.7 Time preferences
- Two optional controls (outbound departure, return departure). Presets: "בוקר 06–12", "צהריים 12–17", "ערב 17–23", "לילה 23–06" (wrap-around, supported by the engine), plus custom start/end selects (0–24).
- A custom window must have start ≠ end. The whole day is 0–24 and still enables 🎯, which then excludes offers whose departure hour is unknown.
- Leaving both empty = no restriction and **hides** the 🎯 card (SPEC §8).
- The **max stops** select (§4.3 row 11) is **disabled until at least one hour window is chosen**: native `disabled`, with the visible helper "עצירות משפיעות רק יחד עם שעות מועדפות" linked to the preferences group by `aria-describedby` (the helper is plain visible text, so a disabled control does not hide the explanation). Clearing both hour windows **resets max stops to "any"**; when a URL or saved search carries `st` without any hour window, `st` is ignored (with an inline notice) and dropped from the URL and storage. SPEC §8 applies max stops only to 🎯, which exists only when hours are set; an enabled control with no visible effect would violate P1/P4. (D4 offers a hard-filter alternative that removes this restriction.)
- Only departure hours are constrained (that is what the engine models); arrival hours are not offered.

### 4.8 URL state and persistence
- The search is encoded in the URL query (codes and ISO dates only, no personal data): `?o=TLV&d=BCN&ws=2026-11-10&we=2026-11-25&n=5-7&a=1&c=0&i=0&bag=1&oh=6-14&rh=12-23&st=1&nb=1`. Opening such a URL prefills the form, validates it (invalid params fall back to defaults with an inline notice) and runs the search.
- The last search is stored in `localStorage` (device only; every access wrapped in try/catch; the app works without it). A "מחק נתונים שמורים" action clears it. No cookies.

---

## 5. Results (S3)

### 5.1 Layout
1. **Summary bar:** "תל אביב ⇄ ברצלונה · 10/11–25/11 · 5–7 לילות · מבוגר 1" + "עריכה". City names come from the API's `meta.resolved` (NEW) so a mis-resolved place is visible.
2. **Notices** (only when applicable): partial-source banner, truncated-search banner (`meta.noticeCodes`), "why isn't there a ‘matches my times’ card" note (§5.3).
3. **Up to three cards** (§5.2). A card can carry several tags when the same offer wins several categories (SPEC §8 display rule).
4. **"פרטי החיפוש"** disclosure: sources used and their status, FX rate date/source, "נמצאו מחירים ל‑X מתוך Y צירופי תאריכים" (`meta.pairsWithOffers` of `meta.validPairs`), "נבדק לפני X" per source (`sources[].checkedAt`, NEW; omitted when null), and any truncation notice.
5. Footer disclaimers: "המחיר הסופי מוצג באתר ההזמנה. ייתכנו עמלות המרת מטבע בכרטיס האשראי." (SPEC §8) and the affiliate disclosure link.

### 5.2 Recommendation card — content
Tags: "💰 הכי זול", "⚖️ התמורה הטובה ביותר", "🎯 מתאים לשעות שלי" (one or more).

| Element | API source | If unknown / estimated |
|---|---|---|
| Total price | `offer.totalIls`, `offer.priceAmount/priceCurrency`, `offer.extrasAmountIls` | see §5.5 |
| Dates + nights + weekday | `departDate`, `returnDate` | always known |
| Outbound / return legs | `outbound`, `inbound` | per-field rules below |
| Departure time | `leg.departTime` | **unknown → "שעת המראה: תופיע באתר ההזמנה"** (never a default) |
| Arrival time | `leg.arriveTime` | usually null (Travelpayouts) → **omitted**, not labelled |
| Stops | `leg.stops` | **unknown → "עצירות: לא ידוע"** (never "ישירה") |
| Duration | `leg.durationMin` | unknown → omitted with "משך: לא ידוע" in details |
| Airlines | `leg.airlines` (+ name lookup NEW) | none → "חברת תעופה: לא ידועה" |
| Ticket structure | `ticketStructure` | `split` → warning block + savings + two CTAs (§5.6) |
| 🎁 bonus | tag `bonus_checked_bag` | shown when bag not requested but included; never a penalty |
| Freshness | `ageHours` | "נבדק עכשיו" (<1h) / "נבדק לפני X שעות" |
| Price context | `priceContext` | hidden when null (§5.5) |
| CTA | `links` (NEW) | §5.6 |

### 5.3 Card gating — "enough data to support the recommendation" (extends SPEC §8; see C2)
Definitions over the offer set after extras/FX. *Priced* = `totalIls != null`. *Known departure time* = `departTime != null`.

| Card | Shown when | Otherwise |
|---|---|---|
| 💰 Cheapest | ≥ 1 priced offer, ranked in the **base pool**: all priced offers except hour-window split variants (they compete only for 🎯, and can never be cheaper than the unrestricted split). **When a checked bag is requested** the pool is further restricted to offers whose bag cost is fully known (table fee or source-reported inclusion) — an offer with `bag_fee_unknown` would otherwise get a zero fee and look cheaper than it is. If no offer qualifies, the cheapest base offer is shown with "לפחות" and the warning. | no offers → Empty (S4). `meta.recommendations.cheapest.excludedForUnknownBagFee` = the number of excluded offers whose lower-bound total (fare only, no fee) is **below** the shown 💰 total (0 when the fallback applies); when > 0 it is disclosed: "{n} הצעות נוספות עשויות להיות זולות יותר, אך עלות המזוודה שלהן לא ידועה". |
| ⚖️ Best Value | Ranked **only within the pool** of offers that are (a) in the base pool (no hour-window split variants), (b) have known stops and known duration on the outbound leg, and (c) when a bag is requested, have a known bag cost — the engine scores an unknown outbound leg and an unknown departure time as **zero penalty**, which would otherwise make incomplete offers look better; an unknown return leg uses the engine's fallback to the outbound leg and is then flagged. The "fastest option" reference for the duration penalty is computed over the **base pool**, so ⚖️ does **not** move when the user only adds time preferences (AC-R18); this deliberately differs from `recommend()` (whose reference includes the variants), for ⚖️ only. Winner = lowest `(score, totalIls)` in the pool. If it is the same offer as Cheapest, it is **merged** (one card, two tags). | Pool empty → the ⚖️ tag is **not shown**, with the reason: `bag_cost_unknown` (a bag is requested and removing offers with an unknown bag cost leaves nothing — checked first) → "לא ניתן לדרג תמורה כי עלות המזוודה לא ידועה"; otherwise `insufficient_data` (stops/duration unknown) → "אין מספיק נתונים על עצירות וזמני טיסה כדי לדרג תמורה." Fallback used → shown with flag `inbound_estimated_from_outbound`. Unknown departure times (night penalty not assessable) keep their `*_time_unknown` flags on the card. |
| 🎯 Matches My Times | The user set at least one hour window (SPEC §8) **and** ≥ 1 priced offer has a *known* departure hour inside every constrained direction (and known stops ≤ `maxStops` when set). The engine already treats unknown hours/stops as non-matching. When a bag is requested only offers with a known bag cost are eligible; if no matching offer has one, the cheapest matching offer is shown with "לפחות" and the warning. `checkedOffers` = priced offers evaluated; `unverifiableOffers` = those with an unknown departure hour in a constrained direction, or unknown stops when `maxStops` is set. | Not requested → hidden, no note (the UI cannot send `maxStops` without an hour window, §4.7; if a client does, the API ignores it and reports `not_requested`). Requested but no match → hidden, with a note: if `unverifiableOffers > 0`, "לא הצלחנו לאמת שעות ל‑N הצעות"; otherwise "לא מצאנו הצעה בשעות שביקשת". |

The API states which case applies (`meta.recommendations`, NEW, §7.2) so the client never has to re-derive gating, and the numbers in the note are exact. `cards` and `kinds` in the response are **post-gating**: the API drops gated kinds and any card left without kinds, and reports the reason only in `meta.recommendations`. The gate layer computes **all three** picks from the pools defined in the rows above, using the shared scoring functions (C2). The ungated engine `recommend()` (parity-tested Python↔TS) is the reference only when no bag is requested and no hour-window variants are in play; parity fixtures for the bag and hours cases test the gate layer's pools.

### 5.4 Data-quality model
Each card carries `flags` (NEW): a list of stable codes computed by the API from the offer (single source of truth; the client only renders).

| Code | Condition | Severity | UI text (Hebrew) |
|---|---|---|---|
| `outbound_time_unknown` | `outbound.departTime == null` | notice | "שעת המראה בהלוך תופיע באתר ההזמנה" |
| `inbound_time_unknown` | `inbound.departTime == null` | notice | "שעת המראה בחזור תופיע באתר ההזמנה" |
| `stops_unknown` | any leg `stops == null` | notice | "מספר העצירות לא ידוע" |
| `duration_unknown` | any leg `durationMin == null` | info | "משך הטיסה לא ידוע" |
| `inbound_estimated_from_outbound` | Best Value used the fallback | notice | "דירוג התמורה מבוסס על הערכה לרגל החזור" |
| `price_estimated_pax` | source = travelpayouts **and** passengers > 1 | notice | "מחיר משוער: מחיר למבוגר × מספר הנוסעים. ילדים ותינוקות עשויים לשלם אחרת" |
| `bag_fee_estimated` | `extrasAmountIls > 0` (fee from the unverified table) | notice | "עלות המזוודה משוערת" |
| `price_converted_ils` | `ticketStructure = "split"` and `priceCurrency = "ILS"` (a mixed-currency split is stored in ILS after conversion) | info | "המחיר חושב מהמרת שני מטבעות" — shown as "≈ ₪X" |
| `bag_fee_unknown` | tag `bag_fee_unknown` (raised per leg: the fee of a leg whose carrier is known is still added) | **warning** | "עלות המזוודה לא ידועה לחלק מהטיסות — המחיר כולל רק עלויות ידועות" (total shown as "לפחות") |
| `bag_included_bonus` | tag `bonus_checked_bag` | positive | "🎁 כולל מזוודה" |
| `bag_inclusion_unverified` | source = google_flights, a bag was requested and `includes.checkedBag` is true (Google was asked to include bag fees; not verified per carrier) | notice | "המחיר כולל מזוודה לפי Google — כדאי לאמת באתר ההזמנה" |
| `split_ticket` | `ticketStructure == "split"` | **warning** | "שני כרטיסים נפרדים — מזמינים כל אחד בנפרד" (§5.6) |
| `airline_unknown` | no airline codes | info | "חברת תעופה לא ידועה" |
| `stale_price` | `ageHours ≥ 12` (configurable) | warning | "המחיר נבדק לפני X שעות ועשוי להשתנות" |
| `price_suspicious` | tag `price_suspicious` (worker/src/priceguard.ts: a cached Travelpayouts fare at ≤ 50% of its cheapest neighbouring date, or of its own recent history). One signal only tags (the card may still show it, with this warning); when both agree the offer is kept out of the cards unless nothing else is priced; `meta.priceGuard` (present only when something was flagged) counts both | **warning** | "המחיר נמוך בהרבה מהרגיל ועשוי להיות לא עדכני — כדאי לאמת באתר ההזמנה לפני שמתכננים" |

Rules: severity is conveyed by **icon + text + style**, never color alone. Notices collapse behind one "פרטים על הנתונים" toggle per card on mobile, with a count; warnings stay visible. No flag is ever silently dropped.

### 5.5 Price display
- Format (SPEC §4.2): **`≈ ₪606 ($164)`** — ILS first, original currency in parentheses. Original ILS with no extras: `₪606`. With extras: `≈ ₪606 ($164 + מזוודות ₪90)`; ILS with extras: `≈ ₪815 (₪500 + מזוודות ₪315)` (as the engine's report prints it); a converted mixed-currency split (`price_converted_ils`) is shown with "≈" and no original currency.
- Rounding: both amounts are **rounded up to whole units**, as the engine's report does. Numbers use grouping (`₪1,060`). Formatting is custom, **not** `Intl` currency style (`he-IL` renders `606 ₪`, which contradicts SPEC's `₪606`).
- Bidi: amounts, dates (`DD/MM`), times and IATA codes are wrapped as **LTR isolates** (`<bdi>` / `unicode-bidi: isolate`) so they do not reorder inside Hebrew text. Screen-reader label example: "כ‑606 שקלים, שווה ל‑164 דולר".
- `bag_fee_unknown` → prefix "לפחות".
- **Price context line** (SPEC §8): `לפני שבוע: ₪X | הכי נמוך שראינו: ₪Y`, shown only when history exists. The comparison is made in the **original currency** (SPEC §4.2); the ₪ figures come from the API (`priceContext.weekAgoIls` / `lowestIls`, NEW: the original amounts converted at **today's** rate with the same rates as `totalIls`) — the client never derives FX rates. A null half is omitted; both null → the line is hidden (C3).
- Split-ticket savings: **"חסכת ₪X לעומת הלוך-חזור"** (exact SPEC §16 wording) only when `savingsVsRoundtripIls` is set.

### 5.6 Booking CTA and links
- Primary CTA: "להזמנה" → `links.book`. `target="_blank"`, `rel="sponsored noopener noreferrer"`.
- **Split ticket:** two CTAs, "הזמנת הלוך" (`links.book`) and "הזמנת חזור" (`links.bookReturn`), plus the warning: "שני כרטיסים נפרדים: מזמינים בנפרד, כללי כבודה ושינויים חלים על כל כרטיס לחוד, ואין הגנה אם אחד מהם משתנה או מתבטל." (D3)
- For every split, **whatever its source**, the API composes `book` (outbound one-way) and `bookReturn` (return one-way) as Aviasales one-way search links; it never reuses `offer.deeplink`, which for some sources is a round-trip search.
- Every card MUST have a working booking link (SPEC G5); the API composes an Aviasales search link (with the affiliate marker) when the source row has none.
- Affiliate disclosure next to the CTA: "קישור שותפים — ייתכן שנקבל עמלה ללא עלות נוספת עבורך" → disclosure page.
- The client renders a booking URL **only if** it is `https:` and its hostname equals or is a subdomain of an allow-listed registrable domain (`aviasales.com`, plus partner tracking domains confirmed in W0(a)). The API applies the same check and falls back to the composed Aviasales search link, so a disabled CTA ("קישור ההזמנה אינו זמין כרגע") is a defense-in-depth case only. The Google Flights verify link (`links.verify`) is **not shown** in the public UI in v1 (D9).
- **Party size in links:** every link the API returns MUST encode the requested party (adults, children, infants). Aviasales search links are composed with the full party; where a source row's link cannot be rewritten to carry it, the API composes an Aviasales search link instead. Otherwise the booking site would search for one adult while the card shows a multi-passenger total (§7.7 gap 15).
- Hotel button: not in v1 (SPEC §13 → Phase 4). A layout slot is reserved.

---

## 6. States catalog

| State | Trigger | UX | A11y | Actions |
|---|---|---|---|---|
| **Idle** | first load | empty results area; short explainer (`state.idle`) | — | fill form |
| **Client-invalid** | submit with invalid fields | inline field errors + error summary (`err.summary`); focus moves to the summary; no request sent | `role="alert"` summary; `aria-invalid`, `aria-describedby` | fix |
| **Loading** | request in flight | skeleton cards; 0–3 s: "מחפשים מחירים בטווח התאריכים שבחרתם…"; 3–10 s: "עדיין בודקים — זה יכול לקחת כמה שניות"; > 10 s: "המקורות איטיים היום, ממשיכים לנסות" | `role="status"` (polite), announced once per phase; controls disabled except "ביטול" | cancel (AbortController) |
| **Timeout** | no response in 25 s | error variant with retry (`state.timeout`) | — | retry, edit |
| **Success** | `cards.length ≥ 1` (**even if** every enabled source has `ok = false`; the Partial banner is added when any enabled source failed) | summary + cards | focus to results heading | book / edit |
| **Partial** | ≥ 1 source with `enabled && !ok` | banner: "אחד ממקורות המחירים לא זמין כרגע; ייתכנו הצעות זולות יותר שלא הוצגו" | banner is `role="status"` | retry later |
| **Truncated search** | `meta.noticeCodes` contains `truncated_by_subrequest_budget` | banner above the cards: "החיפוש נחתך לפני שנבדקו כל הצירופים — צמצמו את הטווח לתוצאות מלאות יותר"; the 💰 tag reads "הכי זול מבין מה שנבדק" | banner is `role="status"` | narrow the window |
| **Served from cache** | `meta.fromCache` | age shown on cards ("נבדק לפני X שעות"); no extra banner | — | — |
| **Empty** | ≥ 1 source `ok` and 0 offers | "לא נמצאו מחירים לטווח הזה" + suggestions: widen the window, more nights, nearby airports, another destination | heading + list | one-tap edits |
| **Unavailable** | 503 `source_unavailable`, or `cards.length = 0` with no source `ok` | "לא הצלחנו לבדוק מחירים כרגע. נסו שוב בעוד כמה דקות." | `role="alert"` | retry |
| **Rate limited** | 429 `rate_limited`; wait = `error.retryAfterSec` (also the `Retry-After` header) | "ביצעתם הרבה חיפושים. אפשר לנסות שוב בעוד N שניות" with a countdown; submit disabled meanwhile | countdown announced sparingly (start + end) | wait |
| **Server-invalid** | 400 `invalid_request` | per-field Hebrew text from the `error.fields` **codes** via the `err.*` map (§7.5), plus the error summary | as Client-invalid | fix |
| **Payload/other 4xx/5xx** | 413/415/500, or a fetch rejection while `navigator.onLine !== false` (e.g. DNS, CORS, a blocked request) | generic "משהו השתבש" + retry | `role="alert"` | retry |
| **Offline** | a fetch rejection while `navigator.onLine === false` | "אין חיבור לאינטרנט" (form stays usable) | `role="alert"` | retry when online |

**Empty vs Unavailable rule (P1):** "no results" is only claimed when a source actually answered and returned nothing. If sources failed, the UI says it could not check — never "no flights".

---

## 7. Public API contract v1

### 7.1 Conventions
- JSON over HTTPS, UTF-8, camelCase. Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC. Money = original amount + currency (never overwritten), plus ILS comparison values.
- Paths: `/api/search`, `/api/airports`, `/api/health`. Responses carry `meta.apiVersion` (NEW, `1`). Additive changes do not bump the version; a breaking change requires a new path prefix.
- Headers on every API response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. CORS only for `ALLOWED_ORIGIN`; `Access-Control-Expose-Headers: Retry-After` (a cross-origin `fetch` cannot read that header otherwise) and `Access-Control-Max-Age` on preflights. Errors use one envelope (§7.5).

### 7.2 `POST /api/search`
**Request** (`Content-Type: application/json`, body ≤ 8 KB — PROVISIONAL). Field semantics = engine `SearchRequest`.
```jsonc
{
  "origin": "תל אביב",          // Hebrew / English / IATA (city or airport), resolved server-side
  "destination": "ברצלונה",     // required in v1 (empty → 400 destination_required; spontaneous mode = W5)
  "windowStart": "2026-11-10",
  "windowEnd": "2026-11-25",
  "stayMin": 5, "stayMax": 7,
  "adults": 1, "children": 0, "infants": 0,   // defaults 1 / 0 / 0
  "cabin": "economy",                          // v1: only "economy" is accepted; any other value → 400 invalid_request with fields.cabin (C11)
  "checkedBag": false,                         // default false
  "outHours": [6, 14],                         // [start,end) 0–24, wrap-around allowed; null/omitted = no restriction
  "retHours": [12, 23],
  "maxStops": null,                            // null/omitted = no restriction
  "nearbyAirports": false
}
```
**Validation limits** (the Worker is the source of truth and the UI mirrors it from `config.ts`; values below are what the Phase 1 Worker enforces, verified 2026-09-29): window = the day **difference** 1–120 (`windowEnd == windowStart` is rejected; today is allowed as `windowStart`, and `windowStart ≤ today + 365 days`); stay 1–30 nights and `stayMin ≤ stayMax`; `adults` 1–9, `children` / `infants` 0–9, `adults + children + infants ≤ 9` and `infants ≤ adults`; hours integers 0–24 with start ≠ end (wrap-around such as `[22, 6]` accepted); `maxStops` integer 0–5; ≤ 400 valid date pairs; strict types (no numeric strings). Internal caps that shape results: ≤ 30 Travelpayouts requests and ≤ 24 airport pairs per search; cache TTL 6 h (empty scans 1 h); stale fallback ≤ 24 h; monitor rows ≤ 12 h.

**Response `200`** = `SearchResponse` (`worker/src/types.ts`) **plus** the NEW members marked below.
```ts
interface SearchResponse {
  cards: CardView[];                 // 0–3, order: cheapest first; merged offers appear once
  meta: {
    apiVersion: 1;                   // NEW
    searchKey: string;
    fromCache: boolean;              // cache TTL = config cache_ttl_hours (6h): a hit makes zero external calls
    fxSource: string;                // "bank_of_israel" | "open.er-api.com" | "…:stale"
    fxDate: string;
    sources: SourceStatus[];         // { name, enabled, ok, calls, offers, error, checkedAt: string | null (NEW) } — checkedAt = when the fares read from that source were fetched (a cache hit reports the cache row's creation time); null when the source is disabled or returned nothing
    candidatePairs: number;          // the narrowed Top-N pairs (≤ 5), NOT the number of pairs checked
    validPairs: number;              // NEW — date pairs allowed by window and stay range
    pairsWithOffers: number;         // NEW — distinct pairs with ≥ 1 offer
    generatedAt: string;
    resolved: {                      // NEW — what the server understood
      origin: PlaceView;             //   PlaceView is defined once, below
      destination: PlaceView;
    };
    recommendations: {               // NEW — drives gating notes (§5.3)
      cheapest:  { status: "shown" | "no_offers"; excludedForUnknownBagFee: number };   // NEW — semantics in §5.3
      bestValue: { status: "shown" | "merged" | "insufficient_data" | "bag_cost_unknown" | "no_offers" };
      myTimes:   { status: "shown" | "merged" | "not_requested" | "no_verified_match" | "no_offers";
                   checkedOffers: number; unverifiableOffers: number };
    };
    noticeCodes: string[];           // NEW — each code has a Hebrew notice (Appendix A) and an AC; PROVISIONAL set: "truncated_by_subrequest_budget"
  };
}

interface PlaceView {                // used by meta.resolved and GET /api/airports (§7.3)
  code: string;                      //   the CITY IATA code — also when kind is "airport" (as built, §7.8 Δ5)
  kind: "city" | "airport";
  airportCode?: string;              //   set when kind is "airport": the chosen airport. Submit `airportCode ?? code`, otherwise the search expands to every airport of the city
  airportNameEn?: string;            //   kind "airport" only; `airportNameHe` is added when known
  nameHe: string | null;             //   the CITY name; null when no Hebrew name exists → display nameEn (lang="en"), else the code
  nameEn: string;
  countryCode: string;
  airports: string[];                //   airports served by the place
}

interface CardView {
  offer: Offer;                      // existing: origin, destination, departDate, returnDate, priceAmount, priceCurrency,
                                     //   source, ticketStructure, outbound, inbound, includes, deeplink, verifyLink,
                                     //   checkedAt, extrasAmountIls, totalIls, tags
  kinds: ("cheapest" | "best_value" | "my_times")[];
  savingsVsRoundtripIls: number | null;
  priceContext: { currency: string; weekAgoAmount: number | null; lowestAmount: number | null;
                  weekAgoIls: number | null; lowestIls: number | null   // NEW — converted by the API at today's rate
                } | null;
  ageHours: number;                  // age of OUR check (checkedAt), NOT of the fare — see the fare* fields
  // ADDED (worker/src/freshness.ts) — the fare's own age, only when known (never our scan time in disguise):
  fareFoundAt: string | null;        //   when the fare was seen: vendor `found_at` (Travelpayouts v3 sends none today) or, for the Google Flights monitor only, checkedAt; else null
  fareAgeHours: number | null;       //   null = unknown
  fareAgeMinutes: number | null;     //   null = unknown
  fareAgeMaxMinutes: number | null;  //   upper bound: = fareAgeMinutes when known; SerpApi ("bounded") = scan age + its documented 1h cache
  scanAgeMinutes: number;            //   minutes since our own check
  fareAgeBasis: "live" | "source" | "bounded" | "unknown";   // Ignav / Wego / SearchApi promise no freshness → "unknown"
  freshness: "fresh" | "aging" | "stale" | "unknown";   // <24h / <72h / >=72h or source-expired; "unknown" = cached fare, age not stated
  ageLabelKey: "fare_found_ago" | "fare_found_within" | "quote_unknown_age" | "cached_fare_unknown_age" | "fare_expired";
  ageLabelHe: string;                //   ready sentence, e.g. "המחיר נמצא לפני 5 דקות" or "מחיר שמור ממאגר מחירים, נשלף לפני 5 דקות. מתי נמצא המחיר עצמו לא ידוע, וייתכן שהשתנה."
                                     //   A fare whose source-stated `expires_at` has passed is never ranked nor written to the price history.
  flags: string[];                   // NEW — §5.4 codes
  links: {                           // NEW — the client never reads offer.deeplink directly
    book: string;                    //   always non-null (SPEC G5); for splits: the outbound one-way ticket
    bookReturn: string | null;       //   non-null iff ticketStructure == "split"
    verify: string | null;           //   Google Flights check link, not rendered in v1 (D9)
  };
  airlineNames?: Record<string, string>; // NEW, optional — IATA code → display name (§7.7 gap 7)
}
```
Invariants the client MAY rely on: `cards` is empty only with `meta.recommendations.cheapest.status = "no_offers"`; `cards`/`kinds` are post-gating (§5.3); a `my_times` kind never appears unless `outHours`/`retHours` was sent; every `flags` entry is a code from §5.4 (unknown codes are ignored by the client, not rendered raw); `links.book` is always non-null and passes the client's booking-link check (§5.6).

**Example** (TLV⇄BCN, hours 06–14 out / 12–23 back, 1 adult, no bag; FX USD = 3.072; marker fictional):
```json
{
  "cards": [
    {
      "kinds": ["cheapest", "my_times"],
      "savingsVsRoundtripIls": null,
      "ageHours": 0,
      "priceContext": null,
      "flags": [],
      "offer": {
        "origin": "TLV", "destination": "BCN",
        "departDate": "2026-11-12", "returnDate": "2026-11-18",
        "priceAmount": 189, "priceCurrency": "USD",
        "source": "travelpayouts", "ticketStructure": "roundtrip",
        "outbound": { "departTime": "06:15", "arriveTime": null, "stops": 1, "durationMin": 420, "airlines": ["W6"] },
        "inbound":  { "departTime": "21:40", "arriveTime": null, "stops": 1, "durationMin": 480, "airlines": ["W6"] },
        "includes": {}, "deeplink": "https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=123456",
        "verifyLink": null, "checkedAt": "2026-09-29T11:00:00.000Z",
        "extrasAmountIls": 0, "totalIls": 580.61, "tags": []
      },
      "links": { "book": "https://www.aviasales.com/search/TLV1211BCN18111?t=W6_example&marker=123456", "bookReturn": null, "verify": null }
    },
    {
      "kinds": ["best_value"],
      "savingsVsRoundtripIls": null,
      "ageHours": 0,
      "priceContext": null,
      "flags": [],
      "offer": {
        "origin": "TLV", "destination": "BCN",
        "departDate": "2026-11-14", "returnDate": "2026-11-20",
        "priceAmount": 264, "priceCurrency": "USD",
        "source": "travelpayouts", "ticketStructure": "roundtrip",
        "outbound": { "departTime": "08:05", "arriveTime": null, "stops": 0, "durationMin": 290, "airlines": ["LY"] },
        "inbound":  { "departTime": "15:30", "arriveTime": null, "stops": 0, "durationMin": 270, "airlines": ["LY"] },
        "includes": {}, "deeplink": "https://www.aviasales.com/search/TLV1411BCN20111?t=LY_example&marker=123456",
        "verifyLink": null, "checkedAt": "2026-09-29T11:00:00.000Z",
        "extrasAmountIls": 0, "totalIls": 811.01, "tags": []
      },
      "links": { "book": "https://www.aviasales.com/search/TLV1411BCN20111?t=LY_example&marker=123456", "bookReturn": null, "verify": null }
    }
  ],
  "meta": {
    "apiVersion": 1, "searchKey": "…64 hex…", "fromCache": false,
    "fxSource": "bank_of_israel", "fxDate": "2026-09-29",
    "sources": [{ "name": "travelpayouts", "enabled": true, "ok": true, "calls": 3, "offers": 2, "error": null, "checkedAt": "2026-09-29T11:00:00.000Z" }],
    "candidatePairs": 2, "validPairs": 30, "pairsWithOffers": 2, "generatedAt": "2026-09-29T11:00:01.000Z",
    "resolved": {
      "origin": { "code": "TLV", "kind": "city", "nameHe": "תל אביב", "nameEn": "Tel Aviv", "countryCode": "IL", "airports": ["TLV"] },
      "destination": { "code": "BCN", "kind": "city", "nameHe": "ברצלונה", "nameEn": "Barcelona", "countryCode": "ES", "airports": ["BCN"] }
    },
    "recommendations": {
      "cheapest": { "status": "shown", "excludedForUnknownBagFee": 0 }, "bestValue": { "status": "shown" },
      "myTimes": { "status": "merged", "checkedOffers": 2, "unverifiableOffers": 0 }
    },
    "noticeCodes": []
  }
}
```
(Illustrative values, consistent with the engine's rules: W6 is both the cheapest offer and the cheapest one inside the requested hours, so it is one card with two tags; the direct LY flight wins Best Value because W6's two stops and extra flight time add ₪558 of penalty (2 × ₪180 stops + ≈ ₪76 and ≈ ₪123 duration) against a price gap of ₪230. `flags` is empty because every displayed datum is known and there is one passenger. A real response only ever contains §5.4 codes.)

### 7.3 `GET /api/airports?q=<text>&limit=<1..8>`
Autocomplete (Hebrew-aware). `200 { "results": PlaceView[] }` (`PlaceView` is defined once in §7.2). Empty/garbage/too long (> 64 chars) → `200 { "results": [] }` (never an error). The Worker default is 8 results with a hard cap of 10; an invalid `limit` silently becomes 8; a 1-character query already returns matches, so the UI keeps its own minimum of 2 (§4.4). A well-formed 3-letter code missing from the bundled table returns `[]` although `POST /api/search` accepts it, so the UI must still allow searching by a typed IATA code (§4.4). No per-client rate limit in v1: the endpoint is served from a table bundled in the Worker (zero D1 rows), so only the Cloudflare request quota is at stake (D14).

### 7.4 `GET /api/health`
Liveness + D1 reachability for ops; not used by the UI. Body `{ "status": "ok", "db": "ok" }`; when D1 is unreachable `503 { "status": "degraded", "db": "error" }`. It runs `SELECT 1` only, so it does **not** prove the migrations ran. `GET` only (`HEAD` → 405).

### 7.5 Errors
Envelope: `{ "error": { "code": string, "message": string, "reason"?: "no_token" | "scan_budget" | "upstream_down", "fields"?: Record<string, string>, "fieldCodes"?: Record<string, FieldErrorCode>, "retryAfterSec"?: number } }`. `message` is for developers; the UI maps **codes** to Hebrew copy (`code` selects the state; `fields` values select per-field text through the `err.*` map in Appendix A). `FieldErrorCode` is a stable machine code — PROVISIONAL set: `required`, `invalid_format`, `out_of_range`, `place_not_found`, `same_place`, `start_after_end`, `past_date`, `window_too_long`, `stay_range_invalid`, `stay_too_long`, `too_many_pairs`, `too_many_passengers`, `infants_exceed_adults`, `hours_invalid`, `not_supported` (e.g. cabin) — finalised in W0(b). **As built today** `fields` values are English sentences (e.g. `"must be an integer"`) and stay so; the machine codes arrive ADDITIVELY as `error.fieldCodes: Record<string, FieldErrorCode>`, with exactly the keys of `fields` (the request's field names, or `body` for a non-object body). The UI reads `fieldCodes` and must not string-match `fields` (§7.8 Δ2). A 503 `source_unavailable` also carries `error.reason`: `no_token` (the fare source has no token), `scan_budget` (the global upstream budget is spent) or `upstream_down` (the source was asked and failed); `error.retryAfterSec` plus a `Retry-After` header are sent on a 503 only when the wait is known (today: `scan_budget`), never guessed. When the destination is empty the top-level `code` is `destination_required` even if other fields are also invalid, and `fields` still lists all of them, so the UI renders every entry of `fields`, not only the one the code names. No stack traces, upstream bodies or tokens are ever returned.

| HTTP | `code` | Meaning | UI state |
|---|---|---|---|
| 400 | `invalid_request` (+ `fields`) | invalid input; the Phase 1 Worker uses this one code for every validation failure (an earlier draft called it `validation_failed`) | Server-invalid |
| 400 | `destination_required` | empty destination (until W5) | inline error on destination |
| 400 | `invalid_json` | body not JSON | generic |
| 413 | `payload_too_large` | body > 8 KB | generic |
| 415 | `unsupported_media_type` | not JSON | generic |
| 429 | `rate_limited` (+ `Retry-After` header, `error.retryAfterSec` — NEW: today only the header) | > 30 `POST /api/search` per 10 min per client (sliding window, SPEC §14); **every** POST counts, including 400 / 413 / 415. `Retry-After` is 1–1200 s and grows while a blocked client keeps calling, so the copy must format long waits (minutes) and the UI never auto-retries | Rate limited |
| 503 | `source_unavailable` | no fresh/cached data and sources failed, or the global upstream budget (120 fresh Travelpayouts scans per 600 s across all clients) is spent and nothing is stored | Unavailable |
| 503 | `fx_unavailable` | both exchange-rate sources are unreachable and no stored rates exist | Unavailable |
| 404 | `not_found` | unknown path (case-sensitive; one trailing slash tolerated) | generic |
| 405 | `method_not_allowed` (+ `Allow`) | wrong method (`POST, OPTIONS` for search; `GET, OPTIONS` for airports and health) | generic |
| 500 | `internal_error` | unexpected | generic |

The Worker checks in this order: 404, `OPTIONS`, 405, then for search: rate limit, 415, 413, `invalid_json`, validation, pipeline. It never returns 502. When the global upstream budget is spent but stored fares exist, the answer is `200` with `sources[0].ok = false` and a text error, which the UI shows as the **Partial** state.

### 7.6 Later endpoints (not in v1)
`POST /api/explore` (spontaneous mode, SPEC §9, W5); auth / watches / alerts endpoints (SPEC §10–11, Phase 3); background ingest endpoint used by the monitor (SPEC §6, Phase 3). Their design is out of scope here.

### 7.7 Engine ↔ API ↔ UI mapping and contract gaps
| Python `models.py` | Worker / API | UI use |
|---|---|---|
| `SearchRequest.window_start/end, stay_min/max, adults/children/infants, cabin, checked_bag, out_hours, ret_hours, max_stops, nearby_airports` | same, camelCase | form fields §4.3 |
| `Offer.price_amount/price_currency` | `priceAmount/priceCurrency` (original, total for all passengers) | "(… $164)" |
| `Offer.total_ils, extras_amount_ils, tags` | `totalIls, extrasAmountIls, tags` | "≈ ₪…", bag line, 🎁 |
| `Leg.depart_time/arrive_time/stops/duration_min/airlines` | `departTime/arriveTime/stops/durationMin/airlines` | leg rows, §5.2 |
| `Card.kinds, savings_vs_roundtrip_ils` | `kinds, savingsVsRoundtripIls` | tags, savings text |
| `deeplink`, `verify_link` | `deeplink`, `verifyLink` → **`links`** | CTA (§5.6) |

Gaps between the current engine/Worker and this UI spec (each needs an owner decision or Phase 1.x work **before** the dependent UI):
| # | Gap | Impact | Proposed resolution |
|---|---|---|---|
| 1 | Split ticket has **one** link (`deeplink`), and for Google-sourced splits it is a round-trip search link | the return ticket cannot be booked → SPEC G5 violated for split cards | API composes `links.book` + `links.bookReturn` as one-way search links for every split (NEW); or hide split offers (D3) |
| 2 | No `flags` / `recommendations` status | client would re-derive gating and could disagree with the engine | API computes and returns them (NEW) |
| 3 | Google round trips lack return-leg times | `inbound_time_unknown`; 🎯 cannot verify return hours | flag + gating rules (§5.3); Travelpayouts rows do include return time |
| 4 | Passenger price = per-adult × pax | wrong for children/infants | `price_estimated_pax` flag now; refine pricing later (D13) |
| 5 | Bag fees are placeholders; no carry-on | totals with a bag are estimates; no trolley option | `bag_fee_estimated` flag; carry-on out of v1 (D5) |
| 6 | Arrival times null from Travelpayouts | cards can't show arrival | omit arrival; do not label as unknown |
| 7 | Airline codes only | "W6" is opaque to users | small IATA→name table (Hebrew/English) bundled in the web app or returned as `airlineNames` |
| 8 | `priceContext` in original currency vs SPEC §8 line in ₪; the contract carried no FX | the client cannot render the ₪ line | NEW `weekAgoIls` / `lowestIls` from the API (C3) |
| 9 | SPEC §12 `search_key` omits bag, hours and max stops **and** `nearbyAirports` (which changes which airports are fetched); hours also change which split variants are composed (an hour-window variant exists only when hours are set) | a cached entry could serve a later search with different hours/nearby with missing offers → wrong 'cheapest' / 🎯 | key includes `nearbyAirports` (C13); the cache MUST store recomputable inputs (raw round trips + raw one-way fares, not composed splits) or include hours in the key; QA: cached re-rank == fresh search (AC-API5) |
| 10 | Live Worker uses only Travelpayouts (+ monitor-written offers) | "two sources compared" (SPEC layer 2) is only partly true in v1 | say so in "פרטי החיפוש"; do not claim comparison that did not happen |
| 11 | Cabin is not applied by the live source | a cabin selector would mislabel economy prices | cabin excluded from v1; API accepts only `economy` (C11, D5) |
| 12 | Best Value scores an unknown outbound leg and unknown departure time as **zero penalty** (an unknown return leg is estimated from the outbound leg) | offers with missing data can win ⚖️ | pool gating in the API gate layer (§5.3) |
| 13 | SPEC §6 says live search does no split-ticket check | split cards in v1 need live composition from one-way fares | C12 / D3 |
| 14 | With live splits (C12) the hour-window split variants join the offer list when hours are set, and `Offer` carries no marker that identifies them (the split builder also drops a variant identical to the base split) | ⚖️ (its "fastest" reference and pool) and 💰 could change when the user only adds time preferences | the split builder returns base and hour-window variants as separate sets (or tags variants); 💰 and ⚖️ use the base pool; AC-R18 |
| 15 | Booking links do not encode the requested party (Travelpayouts row links are for 1 adult; `aviasales_search_link` takes one passenger number) | the booking site can show a different price than the card | API composes party-aware links (§5.6); verify the link format in W0(a) |
| 16 | With a bag requested, an unknown fee adds 0 to the total | such offers look cheaper than they are | bag-cost pool rule in §5.3; `excludedForUnknownBagFee` |


### 7.8 Phase 1 Worker as built vs this contract (verified 2026-09-29)
A read-only comparison of §7 with the merged Phase 1 Worker (`worker/`, run locally with the repo fixtures). **Disposition:** *Spec* = this document was changed to match the Worker; *Worker* = the Worker changes in W0(b) and the spec stays; *Decision* = owner decision (§13). Nothing was changed in the Worker by this comparison.

| Δ | Area | This spec (target) | Worker as built | Disposition |
|---|---|---|---|---|
| 1 | Validation error code | one code for invalid input | `invalid_request` (also `destination_required`, `invalid_json`, `payload_too_large`, `unsupported_media_type`) | Spec (§7.5, AC-S7, AC-API7) |
| 2 | `fields` values | machine codes (`FieldErrorCode`) | English sentences, some parameterised; the codes now ship ADDITIVELY as `error.fieldCodes` (same keys as `fields`), while `fields` stays English | **Worker** (done additively as `fieldCodes`) |
| 3 | `destination_required` precedence | inline error on destination | wins over other errors; `fields` lists all | Spec (§7.5): render every entry |
| 4 | Airports response key | `matches` | `results` | Spec (§7.3) |
| 5 | Airport match shape | `code` = city or airport | `code` = city code; `airportCode`, `airportNameEn/He` for airports; names are the city's | Spec (§7.2 `PlaceView`): submit `airportCode ?? code` |
| 6 | Airports `limit`, min length, unknown codes | limit 1–8, ≥ 2 chars | default 8, cap 10, bad limit → 8, 1-char works, valid unknown 3-letter code → `[]` | Spec (§7.3, §4.4) |
| 7 | Airports rate limit | separate higher limit | none; bundled table, no D1 rows | Spec (§7.3) / D14 reworded |
| 8 | Submit-time place resolution | top match | strict: exact names, aliases, codes; prefix / substring rejected (400) | Spec (§4.4) |
| 9 | 429 body | `error.retryAfterSec` | header only | **Worker** |
| 10 | `Access-Control-Expose-Headers` | `Retry-After` | not sent (with Δ9 a cross-origin client cannot learn the wait) | **Worker** |
| 11 | 429 semantics | 30 / 10 min | sliding window, `Retry-After` 1–1200 s and growing, every POST counts | Spec (§7.5) |
| 12 | Global upstream budget | not specified | 120 fresh Travelpayouts scans / 600 s across clients, then stored fares or 503 | Spec (§7.5) |
| 13 | `meta.apiVersion` | `1` | absent | **Worker** |
| 14 | `cards[].flags` | 14 codes computed by the API | absent (12 derivable client-side; `bag_fee_unknown` and `bonus_checked_bag` exist as `offer.tags`) | **Worker** (single source of truth) |
| 15 | `links` (`book`, `bookReturn`, `verify`) | party-aware, allow-listed | `offer.deeplink`, optional `offer.returnDeeplink`, `verifyLink` null for Travelpayouts | **Worker** (gap 1, gap 15) |
| 16 | `meta.resolved` | present | absent | **Worker** |
| 17 | `meta.recommendations` | present | absent; an empty result is `200 { cards: [] }` with `sources[0].ok = true` | **Worker** |
| 18 | Best Value pool gating (§5.3) | unknown stops / duration excluded | all priced offers ranked; unknown = zero penalty | **Worker** (gap 12) |
| 19 | Bag-cost pool rule (§5.3) | unknown fee excluded and counted | unknown fee = 0 plus tag `bag_fee_unknown`; can win 💰 | **Worker** (gap 16) |
| 20 | Hour-window split variants | ⚖️ identical with and without hours | variants compete for `best_value` | **Worker** (gap 14) |
| 21 | Truncation notice | `meta.noticeCodes` | text in `sources[0].error` while `ok` stays true; ADDITIVE on the `travelpayouts` entry: `truncated: boolean`, `coverage: { plannedRequests, skippedRequests, abortedRequests } \| null` (null on a cache hit of a complete scan) and `reason: "no_token" \| "scan_budget" \| "upstream_down" \| null`, so the UI never parses `error` | **Worker** (structured fields done; `noticeCodes` open) |
| 22 | `sources[].checkedAt` | present | absent | **Worker** |
| 23 | `sources[]` entries | one per source used | always two; `google_flights` is `{ enabled: offers > 0, ok: offers > 0, calls: 0 }`, so `enabled: false` only means "no monitor rows" | Spec: the UI derives **Partial** from the `travelpayouts` entry until the Phase 3 monitor exists |
| 24 | `validPairs`, `pairsWithOffers` | present | only `candidatePairs` = min(5, distinct priced pairs); helpers exist | **Worker** |
| 25 | `priceContext` | ILS fields (`weekAgoIls`, `lowestIls`) | original currency only, scaled by party size; history is not filtered by ticket structure or source | **Worker** (gap 8) |
| 26 | `airlineNames` | optional | absent | Spec: stays optional; bundled table in the web app (gap 7) |
| 27 | Example response (§7.2) | 2 cards | with the same fixtures the Worker composes a live split and returns 1 card (W6 out + VY back, ₪503.81, `savingsVsRoundtripIls` 76.8) | Spec: the example stays illustrative; W0(b) publishes fixture-derived examples |
| 28 | Extra codes and routing | listed in §7.5 | also 404, 405 (+ `Allow`), 503 `fx_unavailable`; never 502 | Spec (§7.5) |
| 29 | `RATE_LIMIT_SALT` | required; Worker refuses without it | optional: env, else derived from the Travelpayouts token, else random per isolate with an error log; health does not check it | **Decision D18** |
| 30 | `cabin` | non-economy → 400 with `fields.cabin` | same behaviour; code and text differ | Spec |
| 31 | `maxStops` without hours | ignored, status `not_requested` | ignored, no status (there is no `recommendations` block yet) | **Worker** (with Δ17) |
| 32 | Limits | PROVISIONAL numbers | same numbers with the differences now written into §7.2 (window is a day difference, `≤ today + 365 days`, infants count toward the 9) | Spec (§7.2) |

The `Worker` rows are the W0(b) work list (§10). The API keeps the additive-change rule of §7.1: none of them removes a field the Worker returns today.

---

## 8. Non-functional requirements

### 8.1 Accessibility
- Target **WCAG 2.2 AA**. For Israel, confirm the applicable legal requirement (the Israeli standard **ת"י 5568**, based on WCAG, and the duty to publish an accessibility statement) with a qualified adviser before public launch (D6).
- Keyboard: every function operable by keyboard; visible focus ring (≥ 3:1); logical order in RTL; no keyboard traps; skip-to-content link.
- Screen readers (VoiceOver iOS, TalkBack Android, NVDA): combobox and steppers follow ARIA patterns; loading/results/errors announced via live regions (polite for status, assertive only for blocking errors); focus moves to the error summary or the results heading after submit; prices and dates have explicit accessible names (§5.5).
- Color is never the only carrier of meaning; contrast ≥ 4.5:1 text, ≥ 3:1 UI components; supports 200% zoom and text spacing overrides without loss; touch targets ≥ 44×44 px (AA minimum 24×24).
- `prefers-reduced-motion` respected (skeleton shimmer off); `lang="he"` on the document, `lang="en"` on English snippets.
- Automated axe checks in CI **plus** a manual screen-reader pass before launch.

### 8.2 Mobile, browsers, RTL
- Mobile-first from 360 px width; safe-area insets; no horizontal scrolling at 320 px; inputs ≥ 16 px font (prevents iOS zoom).
- Support: current and previous major of iOS Safari, Android Chrome; latest desktop Chrome, Edge, Firefox, Safari. Done means "usable end-to-end on iPhone and Android" (SPEC §15).
- RTL rules: `dir="rtl"` at the root, logical CSS only, mixed-direction content isolated (§5.5), icons that imply direction (arrows, chevrons) mirrored; ⇄ for round trips.
- System font stack in v1 (no font download, no third-party font CDN); self-hosted Hebrew webfont is a later option.

### 8.3 Performance
- Budgets. **Lab** (Lighthouse CI, simulated mid-range Android on 4G): LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms, initial JS ≤ 150 KB gzip, no render-blocking third-party requests. **Interaction:** a scripted Playwright test for input/submit latency. **Field (p75, e.g. INP ≤ 200 ms)** targets apply only once privacy-friendly field measurement exists (Phase 4, D10); until then a manual real-device run on a mid-range Android.
- Search latency (SPEC G2): first results < 4 s from cache or a fast source. v1 returns all cards in **one** response (no streaming); the loading state (§6) covers slower misses. Progressive results are a possible later improvement.
- Client timeout 25 s; requests are cancelable; a new search cancels the previous one.

### 8.4 Security
- **XSS:** React escaping only; no `dangerouslySetInnerHTML`; API strings are treated as untrusted text. **Booking URLs** are validated (`https:` + host allow-list) before becoming `href`.
- **CSP** (via `_headers`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <API origin>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. No inline scripts/styles (Tailwind emits static CSS). Also `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` denying unused features, HSTS via Cloudflare.
- **CORS:** exact origin only; no credentials; no wildcard.
- **Secrets:** none in the client bundle. `VITE_*` variables are public by definition.
- **Abuse:** per-client rate limit on `/api/search` (429 + `Retry-After`); the UI never retries automatically on 429/5xx. Client-side limits do not replace server validation.
- **Supply chain:** lockfile committed, Dependabot enabled, `npm audit` in CI, minimal dependency count.
- **Third parties:** none loaded by the app (no analytics, fonts, maps, chat). Booking happens on the partner site, opened with `noopener`.

### 8.5 Privacy and data handling
| Data | Where | Retention (proposed, D11) | Notes |
|---|---|---|---|
| Search parameters (route, dates, passengers, bag, hours) | D1 `searches` (no user id, no IP) | 90 days | needed for cache/analysis; disclosed in the privacy policy |
| Raw offers cache | D1 `search_cache` | TTL 6 h then purge | no personal data |
| Price history | D1 `prices` | long-term | no personal data |
| Rate-limit key | D1 `rate_limits` = salted SHA-256 of client IP | 1 day | **raw IPs are never stored**; the salt is the Worker secret `RATE_LIMIT_SALT`, **mandatory in the deployment checklist** (runbook `docs/CLOUDFLARE_SETUP.md`). In code it falls back to a value derived from `TRAVELPAYOUTS_TOKEN`, then to a random per-isolate salt with an error log (no public default); pending D18 |
| Last search / prefs | `localStorage`, device only | until cleared | no cookies set by us |
| Cloudflare edge logs | Cloudflare (processor) | per Cloudflare | name Cloudflare in the policy |
| Click-outs to Aviasales/Travelpayouts | third party | — | disclose affiliate relationship and that the partner site has its own policy |

- A retention job (Worker cron trigger, W0(c)) is a **dependency** for these periods (AC-SEC7).
- No accounts, emails or marketing in v1 → no consent banner needed for our own storage; **confirm with an adviser** (D6). Marketing email later requires explicit consent and one-click unsubscribe (SPEC §14).
- Minimum pages (Hebrew): privacy policy, terms of use, **affiliate disclosure** (SPEC §14), accessibility statement. Owner supplies or approves the legal text.

### 8.6 Discoverability
Until public launch: `<meta name="robots" content="noindex,nofollow">` **and** an `X-Robots-Tag: noindex, nofollow` header (via `_headers`, covering all assets), no sitemap, neutral hostname (D8). A `robots.txt` disallow-all is **not** used as the mechanism (a crawler blocked by robots.txt never sees the noindex). At launch the flags are removed as a deliberate release step.

### 8.7 Observability
No third-party analytics in v1. Server-side: structured logs without PII, `source_health` updates (SPEC §12), Worker metrics from Cloudflare. Click/conversion analytics = Phase 4 (D10). **Source-failure alert (SPEC §14):** if any source fails 3 runs in a row the owner is emailed. This needs a scheduled check (Worker cron trigger) reading `source_health` and an email provider (SPEC §17; Resend is used by Phase 0) — scheduled in W0(c) and required before launch; Travelpayouts is the source the web app depends on.

---

## 9. Release scope summary

**v1 (this document's target) = SPEC Phase 2, core:** form, results, states, data-quality flags, PWA, minimum legal pages, accessibility and performance gates.
**Phase 2 follow-up (W5):** spontaneous mode ("לאן הכי זול לטוס מ‑… החודש") and home deals (SPEC §9).
**Phase 3:** accounts (magic link), saving a search as a watch (5 per user, SPEC §10), email + in-app banner alerts, monitor cadence.
**Phase 4:** hotel links, analytics, deal definition, full legal review; **public launch** (SPEC §15) unless D17 decides otherwise.

---

## 10. Delivery plan

Sizes are relative (S/M/L), not calendar promises. Nothing here deploys anything; deployment steps are gated on the owner's approval per SPEC §18.

| Stream | Scope | Depends on | Exit criteria | Size |
|---|---|---|---|---|
| **W0(a) — Phase 0 proof (SPEC §15 gate)** | Owner adds `TRAVELPAYOUTS_TOKEN`/marker; run the coverage test for TLV/ETM sample routes; compare recommendations against a manual Google Flights check (SPEC §15); confirm the affiliate marker, the booking-link domains for the allow-list and the Aviasales party-size link format (§5.6) | owner token | D1 gate passed | S (blocked on owner) |
| **W0(b) — API contract** | Phase 1 Worker reviewed and merged; NEW contract members implemented (`meta.apiVersion`, `flags`, `links` incl. `bookReturn` and party-aware links, `meta.resolved` with the single `PlaceView`, `meta.recommendations` incl. `excludedForUnknownBagFee`, `meta.validPairs/pairsWithOffers`, `sources[].checkedAt`, `priceContext` ILS fields, `noticeCodes`, optional `airlineNames`, `error.retryAfterSec`, field error codes, `Access-Control-Expose-Headers`); Best Value pool gating, the bag-cost pool rule for 💰/⚖️/🎯 and the base pool (the split builder returns hour-window variants separately); cache stores recomputable inputs and `nearbyAirports` is in the key (C13); `cabin` restricted to `economy` (done in Phase 1); `RATE_LIMIT_SALT` per D18; the itemised list is §7.8 (rows marked **Worker**) | Phase 1 | contract fixtures published; SPEC §16 API-level criteria and AC-API*, AC-SEC6 pass locally | M |
| **W0(c) — Operations** | Data-retention job; **source-failure alert** (SPEC §14: owner emailed after 3 consecutive failures) via a Worker cron trigger reading `source_health` | W0(b); W0(d) (or a local-Worker test of the jobs); email provider (SPEC §17) | retention job and alert verified (AC-SEC7); alert test fires | S–M |
| **W0(d) — Staging** | Staging Worker + D1 with `ALLOWED_ORIGIN` — **requires the owner's approval to create/deploy (D15, SPEC §18)** and starts only after the Phase 0 gate (README: no Cloudflare deployment before the proof); until then a local Worker + local D1 + fixtures | D15; W0(a) passed; W0(b) merged | `/api/search` returns real results for the agreed sample routes | S |
| **W1 — Foundations** | Scaffold `web/` (Vite/React/TS/Tailwind RTL), design tokens, `copy/he.ts`, formatters (money/date/bidi) with unit tests, API client + error mapping, CI (typecheck, lint, tests, build), noindex | W0(a) passed (SPEC §15) + W0(b) contract types | CI green; formatter tests cover §5.5 rules | S |
| **W2 — Search form** | Combobox, dates/nights, steppers, bag, preferences, advanced, client validation, URL state, localStorage | W1 | AC-F* pass on Chromium + WebKit emulation; axe clean | M |
| **W3 — Results & states** | Cards, gating, flags, price display, split UX, booking links + allow-list, all states in §6, "פרטי החיפוש" | W2, W0(b), W0(d) (or the offline alternative) | AC-R*, AC-S* pass with fixtures **and** against staging | L |
| **W4 — Quality & launch readiness** | PWA (manifest, SW, offline page, update flow), a11y audit incl. manual SR, perf budgets, CSP/headers, real-device pass (iPhone, Android), legal pages, launch checklist | W3, W0(c), legal text (D6) | AC-A*, AC-M*, AC-P*, AC-SEC* pass; retention job and source-failure alert verified; owner sign-off | M |
| **W5 — Spontaneous mode & home deals** | `/api/explore`, destination-less form path, ranked list → opens full search, home "deals" | W4, Travelpayouts destination query | SPEC §16 spontaneous criterion; own AC set | M–L |
| Later | Phase 3, Phase 4 | per SPEC | per SPEC | — |

Dependency chain (SPEC §15 gate respected: no UI code before the Phase 0 proof):

```
W0(a) Phase 0 proof ──┐
                      ├─► W1 ─► W2 ─► W3 ─► W4 ─► W5 ─► Phase 3 ─► Phase 4 (public launch, SPEC §15)
W0(b) API contract ───┘   (W0(d) staging → W3 contract tests; W0(c) operations → W4 launch readiness)
```

Gates: W1 starts when W0(a) has passed and the W0(b) contract types exist; W0(d) starts only after W0(a) has passed, W0(b) is merged and D15 is approved; W0(c) needs W0(b) and W0(d) (or a local-Worker test); W3 exits against W0(d) (or the offline alternative); W4 needs W3 and W0(c).

If W0(a) fails the D1 gate, W1 does not start (see D1). An earlier limited public launch after W4 is possible only as an explicit owner decision (D17); SPEC §15 defines public launch as the completion of Phase 4.

### 10.1 Risks
| ID | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| R1 | **Travelpayouts coverage/freshness poor for TLV/ETM** (SPEC §17, blocking) | ? | Critical | Run W0(a) first; define the gate (D1). If it fails: **stop and re-scope** (default), or pull a minimal monitor + ingest endpoint forward from Phase 3 (scope/schedule impact; changes SPEC's source-reliability rule, so it needs owner approval) — decide before W1 |
| R2 | Estimates dominate the UI (pax, bag, missing times) and erode trust | M | High | flags (§5.4), honest gating (§5.3), owner verifies `bag_fees.json` |
| R3 | Workers Free limits: **10 ms CPU/request**, 50 external subrequests, 100k requests/day; D1 free daily row limits now enforced (queries fail until 00:00 UTC) | M | High | subrequest cap (30 — PROVISIONAL), cache-first design, measure CPU in staging, alert on 1102/D1 errors; paid plan only by owner choice |
| R4 | Rate limit (30/10 min/IP) hits legitimate users behind shared mobile-carrier IPs | M | Med | monitor 429 rate; adjust limits; user-friendly 429 UX |
| R5 | Google Flights scraping blocked/changed (monitor only) | M | Med | the monitor is optional (SPEC source-reliability rule) and the UI never depends on it — **unless D1 option (b2) is chosen**; source-failure alert (W0(c)) |
| R6 | Legal exposure (affiliate disclosure, privacy, accessibility, marketing email) | M | High | D6: minimum pages before any public exposure; adviser review |
| R7 | Hebrew city data errors (wrong code/name) | M | Med | data audit in Phase 1 review; user-visible "resolved as" echo (§5.1) |
| R8 | Split-ticket misunderstanding (missed connection, separate baggage rules) | M | High | warning copy, two clear CTAs, D3 |
| R9 | Affiliate program approval/marker missing → links not monetized | L | Med | W0(a) checks; `links.book` still works without marker |
| R10 | RTL/bidi glitches on iOS/Android date inputs and mixed content | M | Med | isolates (§5.5), real-device pass (W4) |
| R11 | Hosting choice (Pages vs Workers static assets) causes rework | L | Low | D2 before W1; app is hosting-agnostic |
| R12 | Source failures go unnoticed (a dead Travelpayouts source = empty product) | M | High | source-failure alert (SPEC §14, W0(c)); `source_health` checked in ops routines |

---

## 11. Acceptance criteria and test strategy

### 11.1 Acceptance criteria (Given / When / Then)
Legend: F = form, R = results, S = states, A = accessibility, M = mobile/PWA, P = performance, SEC = security/privacy, API = contract.

**Form**
- **AC-F1** Given the app loads, then defaults are 1 adult, 0 children, 0 infants, bag off, no hour windows, no max stops, economy (SPEC §4.1).
- **AC-F2** Given I type "ברצלונה", "Barcelona" or "BCN", then the combobox offers Barcelona; choosing it sets the code; the results summary later shows the server-resolved name (Hebrew when `nameHe` exists, otherwise the English name marked `lang="en"`, otherwise the code).
- **AC-F3** Given dates/nights with no valid pair (e.g. window 3 days, stay ≥ 5), then submit is blocked with an inline error and no request is made.
- **AC-F4** Given infants > adults or total passengers > 9, then submit is blocked with an inline error.
- **AC-F5** Given a valid search, then the URL contains the search parameters and reloading the URL restores the form and re-runs the search.
- **AC-F6** Given the autocomplete request fails, then I can still search by typing a 3-letter IATA code.
- **AC-F7** Given no hour windows are set, then the 🎯 explainer is not shown and the request omits `outHours/retHours`.
- **AC-F8** Given no hour window is set, then the max-stops select is `disabled` and its helper text is visible; given an hour window is set, it is enabled; clearing both hour windows resets it to "any"; a URL or saved search with `st` but no hour window has `st` ignored and dropped.
- **AC-F9** Given the form, then no cabin or carry-on control exists and every request carries `cabin: "economy"`.
- **AC-F10** Given a custom hour window with start = end, then submit is blocked with an inline error; the whole-day window 0–24 is accepted and still enables 🎯.
- **AC-F11** Given a browser locale of en-US, when I pick 10 November, then the echo beside the field reads "10/11 · יום ג׳" (matching the value), never "11/10".

**Results & gating**
- **AC-R1** Given results, then at most three cards are shown and identical offers appear once with multiple tags (SPEC §8).
- **AC-R2** Given no preferred hours, then the 🎯 card is hidden with no note (SPEC §16).
- **AC-R3** Given preferred hours and `myTimes.status = no_verified_match`: with `unverifiableOffers > 0` the note says times could not be verified for N offers; with `unverifiableOffers = 0` the note says no offer was found in the requested hours; in both cases no 🎯 card is shown.
- **AC-R4** Given no offer has known stops **and** known duration on its outbound leg (`bestValue.status = insufficient_data`), then the ⚖️ tag is not shown and the stops/times note appears; given a cheaper offer with unknown stops and a costlier offer with known stops, then the cheaper one MUST NOT win ⚖️ merely because unknowns score zero penalty; given a bag is requested and every offer has an unknown bag cost (`bestValue.status = bag_cost_unknown`), then the ⚖️ tag is not shown and the bag note appears instead of the stops/times note.
- **AC-R5** Given a USD price, then it is shown `≈ ₪X ($Y)`; given an ILS price with no extras, `₪X`; with extras `≈ ₪X (₪Y + מזוודות ₪Z)`; a `price_converted_ils` split is shown with "≈" and no original currency. Amounts are rounded up to whole units (engine `report.py`; SPEC §4.2 defines the format).
- **AC-R6** Given no bag selected and a source that reports an included bag, then the offer is tagged 🎁 and its price has no bag fee added (SPEC §4.1, §16); given no source reports inclusion, no 🎁 appears (§2 item 10).
- **AC-R7** Given a bag selected and an offer with an unknown fee (`bag_fee_unknown`), then that offer is **not** ranked as if the fee were zero: it is excluded from the 💰, ⚖️ and 🎯 pools; `excludedForUnknownBagFee` counts only excluded offers whose lower-bound total is below the shown 💰 total and is disclosed only when > 0; if no offer (or no matching offer for 🎯) has a known bag cost, the cheapest (matching) offer is shown with "לפחות" and the warning; no fee is invented.
- **AC-R8** Given passengers > 1 and a Travelpayouts offer, then `price_estimated_pax` is rendered on the card.
- **AC-R9** Given an unknown departure time, then the card says the time will appear on the booking site; no time is displayed.
- **AC-R10** Given a split ticket cheaper than every round trip (and C12 approved), then the Cheapest card shows "חסכת ₪X לעומת הלוך-חזור", the warning block, and two booking CTAs (SPEC §16).
- **AC-R11** Given any card, then `links.book` opens in a new tab with `rel` containing `sponsored noopener noreferrer`; a URL that is not `https:` or whose hostname is outside the allow-listed domains (§5.6) renders a disabled CTA — while the API guarantees that its own links pass this check.
- **AC-R12** Given `priceContext` has ILS values, then the line `לפני שבוע: ₪X | הכי נמוך שראינו: ₪Y` shows using the API's `weekAgoIls`/`lowestIls` (a null half is omitted); given both null or `priceContext` null, the line is absent.
- **AC-R13** Given `meta.noticeCodes` contains `truncated_by_subrequest_budget`, then the truncation banner is shown and the 💰 tag reads "הכי זול מבין מה שנבדק".
- **AC-R14** (parametrised) For **every** code in §5.4, a card carrying that flag renders its Hebrew text; an unknown code is ignored, never rendered raw.
- **AC-R15** Given `stops == null` on a leg, then the card reads "עצירות: לא ידוע" and never "ישירה"; given `durationMin == null` or empty `airlines`, then the corresponding label appears instead of a blank or a default.
- **AC-R16** Given a Google-sourced offer with a requested bag and `includes.checkedBag`, then `bag_inclusion_unverified` is rendered; given `extrasAmountIls > 0`, then `bag_fee_estimated` is rendered.
- **AC-R17** Given `checkedBag = true`, then totals and ranking use fare + `extrasAmountIls` and the card total includes the fee: a low-cost fare whose fare + fee exceeds a full-service fare with the bag included does not rank cheaper (SPEC §16).
- **AC-R18** Given the same request with and without hour windows, then the ⚖️ and 💰 results are identical (hour-window split variants are excluded from their pools **and** from the ⚖️ "fastest" reference). Fixture: a candidate with an unknown return duration plus a faster in-window one-way leg must not change the ⚖️ winner when hours are added.

**States**
- **AC-S1** Loading shows the phased messages at 0/3/10 s, is cancelable, and times out at 25 s with retry.
- **AC-S2** Given ≥ 1 source `ok` and 0 offers, then the Empty state with suggestions is shown; given `cards.length = 0` and no source `ok` (or HTTP 503), the Unavailable state is shown, never "no flights"; given `cards.length ≥ 1` the Success state is shown even if a source failed (with the Partial banner).
- **AC-S3** Given 429 with `error.retryAfterSec = 30` (also `Retry-After`), then the submit button is disabled with a countdown and re-enables at zero — including when the API is cross-origin (the header is exposed via CORS; the countdown uses the body value).
- **AC-S4** Given a source with `enabled && !ok`, then the Partial banner is shown.
- **AC-S5** Given offline, then the form (from the precached shell, query string ignored) remains usable and the Offline message appears on submit.
- **AC-S6** Given the API is served from cache, then each card shows its age and the disclaimer; given `ageHours ≥ 12`, `stale_price` is shown.
- **AC-S7** Given 400 `invalid_request` with `fields`, then each field shows its Hebrew message from the `err.*` map, the error summary appears, and focus moves to the summary.
- **AC-S8** Given 413/415/500, or a fetch rejection while the browser reports it is online, then the generic error state with retry is shown (`state.generic`); given a fetch rejection while `navigator.onLine === false`, the Offline state is shown instead (AC-S5).
- **AC-S9** Given no response within 25 s, then the timeout state (`state.timeout`) is shown with retry and edit.

**Accessibility**
- **AC-A1** axe reports no serious/critical violations on S1, S3, S4, S5, S6 in Hebrew RTL.
- **AC-A2** The whole flow (fill form → search → open booking link) is completable by keyboard only.
- **AC-A3** VoiceOver (iOS) and TalkBack (Android) can complete the flow; loading, errors and results are announced once, not repeatedly.
- **AC-A4** At 200% zoom and 320 px width there is no horizontal scroll or clipped content.

**Mobile / PWA / performance**
- **AC-M1** Usable end-to-end on iPhone Safari and Android Chrome (SPEC §15).
- **AC-M2** The app is installable (manifest, service worker, HTTPS, icons); navigating offline to `/` (any query) or a legal page loads the precached page; navigating to an uncached URL shows the Hebrew offline page; `/api/*` is never served from the service-worker cache.
- **AC-P1** Meets the lab budgets in §8.3 in CI (Lighthouse CI) and the interaction test; a manual run on a real mid-range Android before launch.

**Security / privacy**
- **AC-SEC1** The CSP in §8.4 is served; no inline script/style violations in the console.
- **AC-SEC2** No secret or token appears in the built bundle or repo (SPEC §16).
- **AC-SEC3** No third-party requests are made on page load (verified in Playwright network log).
- **AC-SEC4** No cookies are set; `localStorage` is cleared by the "מחק נתונים שמורים" action.
- **AC-SEC5** The privacy, terms, affiliate-disclosure and accessibility pages exist and are linked from the footer and near the CTA.
- **AC-SEC6** `RATE_LIMIT_SALT` is set in production (deployment checklist item; pending D18 on whether the Worker must also refuse to run without it); D1 contains no raw IP, and `rate_limits` keys are salted hashes.
- **AC-SEC7** The retention job deletes `rate_limits` older than 1 day, `searches` older than 90 days and `search_cache` older than 6 h (D11).
- **AC-SEC8** Every static response carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy`, `X-Content-Type-Options: nosniff` and `Permissions-Policy`, and the page has the robots meta, until the recorded launch step removes the indexing flags (D8).

**API contract**
- **AC-API1** Every fixture and every staging response validates against the contract (types + JSON Schema) including NEW members.
- **AC-API2** Given the same search twice within 6 h, the second is served from D1 with zero external calls (SPEC §16) and `meta.fromCache = true`.
- **AC-API3** Given `ENABLE_FAST_FLIGHTS=false` (monitor off), the web app works unchanged (SPEC §16).
- **AC-API4** Every card has a non-null `links.book`; `links.bookReturn` is non-null iff the ticket structure is `split` — for splits of **any** source both are one-way search links (never the round-trip `deeplink`); every returned link encodes the requested party (§5.6).
- **AC-API5** Given a cached search, then a later search that differs only in bag or max stops is re-ranked without new external calls; a search that differs in hours or `nearbyAirports` returns exactly what a fresh search would (the cache key includes `nearbyAirports` and the cache stores recomputable inputs, C13) — verified by a test comparing the cached re-rank against a fresh run.
- **AC-API6** `meta.validPairs` equals the number of pairs allowed by window and stay range (30 for the §7.2 example) and `meta.pairsWithOffers ≤ validPairs`; `candidatePairs ≤ 5`.
- **AC-API7** Given `cabin` other than `economy`, then the API answers `400 invalid_request` with `fields.cabin`.
- **AC-API8** Every entry of `meta.sources` carries `checkedAt` (`string | null`): the fetch time of the fares actually read from that source (the cache row's creation time on a cache hit), `null` only when the source is disabled or returned nothing; the results disclosure shows "נבדק לפני X" per source and omits the line when it is null.
- **AC-API9** Every API response (including 4xx/5xx and OPTIONS) carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; `Access-Control-Allow-Origin` equals `ALLOWED_ORIGIN` only for that exact origin, is never `*`, and credentials are never allowed; with `ALLOWED_ORIGIN` unset no CORS headers are sent.
- **AC-API10** After 30 `POST /api/search` requests within 10 minutes from one client (valid or not), the next returns 429 with `Retry-After` and `error.retryAfterSec`, and `Access-Control-Expose-Headers` lists `Retry-After`.

### 11.2 Test strategy
| Layer | Tooling | Covers |
|---|---|---|
| Unit | Vitest | money/date/hour/bidi formatters, Hebrew number-agreement forms (n = 1, 2, 11), URL state, validation, gating renderers, flag→copy mapping |
| Component | Vitest + Testing Library | Combobox, steppers, card variants (each flag, split, merged tags) |
| Contract | JSON Schema + fixtures; CI job hitting the staging Worker | AC-API* |
| End-to-end | Playwright (Chromium, WebKit, Firefox; mobile emulation) with recorded API fixtures for **every state in §6** | AC-F*, AC-R*, AC-S* |
| Accessibility | axe via Playwright; manual VoiceOver/TalkBack checklist | AC-A* |
| Performance | Lighthouse CI budgets; manual real-device run | AC-P1, AC-M2 |
| Security | header/CSP/robots/CORS assertions (static host and API), dependency audit, network-log assertion | AC-SEC*, AC-API9, AC-API10 |

---

## 12. Consistency with existing documents and clarifications that need approval

### 12.1 Traceability
| `SPEC.md` | Covered in this document |
|---|---|
| §1 product, §2 goals G2/G5 | §1, §6 (latency), §5.6 (links) |
| §3 non-goals | §1.2 |
| §4.1 unspecified input semantics | §1.3 P2, §4.3, §5.2, AC-F1/R6/R7 |
| §4.2 currency | §1.3 P3, §5.5, AC-R5 |
| §4.3 origins/language | §4.4 |
| §5 user inputs | §4.3 |
| §6 architecture, source reliability | §3, AC-API3 |
| §7 pipeline | §4.5, §7.2 (`fromCache`, `candidatePairs`) |
| §8 recommendations, display rules | §5.2–§5.6 |
| §9 spontaneous mode | deferred to W5 |
| §10–§11 watches, accounts | deferred to Phase 3 |
| §12 data model | §8.5 |
| §13 hotels | deferred to Phase 4 |
| §14 non-functional & safety (incl. source-failure owner alert) | §8, §8.7, W0(c) |
| §15 phases | §9, §10 (Phase 2 = W1–W5) |
| §16 acceptance criteria | §11 (web-applicable items restated) |
| §17 open questions | §13 (D1 + "carried over from SPEC §17" table) |
| §18 delivery workflow | §10 header (no deployment in this step) |

Other documents: `README.md` "Known limitations" (Phase 0) are the source of §2 items 1–5; §2 items 6–10 come from `SPEC.md` §5 and the code; `config/scoring.json` penalties and `cache_ttl_hours` are consumed, not duplicated; `config/project.json` supplies the brand constant.

### 12.2 Clarifications that extend or interpret `SPEC.md` (need owner approval)
- **C1 — Max stops scope.** SPEC §5 lists max stops as a filter ("no restriction if unset") but §8 applies it only to 🎯. This document follows §8 and groups hours + max stops under "preferences that affect only the 🎯 recommendation" (D4).
- **C2 — "Enough data" gating.** SPEC §8 hides 🎯 only when no hours were set. This document adds evidence-based gating for ⚖️ and 🎯 (§5.3), including a **pool rule** for ⚖️ because the engine scores an unknown outbound leg and unknown departure time as zero penalty, a **bag-cost pool rule** for 💰, ⚖️ and 🎯 when a bag is requested, and the exclusion of hour-window split variants from the 💰/⚖️ pools.
- **C3 — Price context currency.** SPEC §8 shows the line in ₪; §4.2 requires original-currency comparison. Resolved as: compare in original currency, display converted at today's rate (§5.5).
- **C4 — Split tickets need two links and a warning** (SPEC §16 requires the savings message but not the second link; G5 requires a working link per result).
- **C5 — Minimum legal pages before public exposure** rather than only in Phase 4, because affiliate links exist from the first release.
- **C6 — `noindex` and neutral hostname until launch** (not in SPEC): proposed to avoid exposing an unfinished product and its partner links before the legal pages and quality gates are in place (D8).
- **C7 — Carry-on excluded in v1** because the engine does not model it (SPEC §5 lists it).
- **C8 — Spontaneous mode split into W5 (D7)** although SPEC §15 lists it in Phase 2.
- **C9 — Shareable URL and device-local last search** (no SPEC text; no personal data involved).
- **C10 — Retention periods** for `searches` and `rate_limits` (not in SPEC).
- **C11 — Cabin excluded from v1** (SPEC §5 lists cabin): the live source is never queried by cabin, so a selector would mislabel prices (D5).
- **C12 — Live split-ticket composition** from Travelpayouts one-way fares, although SPEC §6 lists "no split-ticket check" for live search (D3, §3).
- **C13 — Cache key and recomputation.** SPEC §12's `search_key` omits `nearbyAirports`, which changes which raw offers are fetched; hours change only which split variants are composed from the same raw fares. The key includes `nearbyAirports`, and the cache stores recomputable inputs (raw round trips and one-way fares) so ranking re-applies exactly (§7.7 gap 9).

---

## 13. Open decisions (owner input needed)

**Blocking**
| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Data-source gate: what counts as "enough Travelpayouts coverage" for TLV/ETM, and what happens if it fails? | Gate: (a) ≥ 80 % of 10 agreed sample routes return ≥ 5 valid date pairs in two sample windows. If it fails: (b1) **stop and re-scope** the web app, or (b2) pull a minimal Google monitor + ingest endpoint forward from Phase 3 (scope/schedule impact; changes SPEC's source-reliability rule) | Gate (a); on failure (b1) unless you approve (b2). Needs the owner's Travelpayouts token first. |
| **D2** | Web hosting: Cloudflare Pages (SPEC §6) vs a Worker with static assets (Cloudflare's current React+Vite guide; same origin as the API, no CORS/preflight) | Pages · Workers static assets | Keep **Pages** per SPEC unless you approve the switch; decide before W1. |
| **D6** | Legal: who provides Hebrew privacy policy / terms / affiliate disclosure / accessibility statement, and are they required before any public URL is shared? | owner/adviser text · generated draft for adviser review | Pull them into W4 (before any public traffic); adviser reviews. |

**Product defaults (approve or change)**
| ID | Decision | Recommendation |
|---|---|---|
| D3 | Split tickets in v1: compose them live from Travelpayouts one-way fares (C12, deviates from SPEC §6 live mode; needs `links.bookReturn`), show them only from monitor data (Phase 3), or hide them | Compose live, with the warning and two links |
| D4 | Max stops applies only to 🎯 (SPEC §8) — the select is disabled until hours are set (§4.7) — or as a hard filter on all cards | Keep SPEC (🎯 only); choose the hard filter if "direct only" without hours matters to you |
| D5 | Carry-on/trolley and cabin class: omit in v1 (C11) or extend the engine and sources | Omit in v1 |
| D7 | Spontaneous mode + home deals in the same release or right after core search | Right after (W5); destination required in v1 |
| D8 | Keep the product unindexed (`noindex` meta + `X-Robots-Tag`, no sitemap) and on a neutral hostname until you decide to launch | Yes |
| D9 | Show the Google Flights "verify" link in the public UI | No (owner/debug use only) |
| D10 | Analytics / click tracking in v1 | None; first-party, privacy-friendly events in Phase 4 |
| D11 | Retention: `searches` 90 days, `rate_limits` 1 day, `search_cache` 6 h | Approve |
| D12 | Date input: native date fields vs custom range calendar | Native in v1 |
| D13 | Children/infants pricing: keep multiplication with an "estimated" flag vs disable children/infants until accurate | Keep with flag |
| D14 | Rate limits: 30 `POST /api/search` per 10 min per client; no per-client limit on `/api/airports` in v1 (bundled table, zero D1 rows) | Approve; revisit after real traffic (shared mobile IPs) or abuse |
| D15 | Approve creating a staging Worker + D1 (SPEC §18) once W0(a) has passed and W0(b) is ready, and who holds the Cloudflare credentials; until then CI uses a local Worker + fixtures | Approve then |
| D16 | Fixture-only UI scaffolding before the Phase 0 proof (SPEC §15 forbids building the UI before the proof) | No — wait for W0(a) |
| D17 | Public launch timing: end of Phase 4 (SPEC §15) or a limited launch right after W4 | SPEC §15 unless you decide otherwise |
| D18 | `RATE_LIMIT_SALT`: keep it optional in code (token-derived fallback, then per-isolate random) and mandatory in the deployment checklist, or make the Worker refuse `/api/search` without it (§7.8 Δ29) | Keep optional in code, mandatory in the checklist: a missing secret then degrades rate limiting instead of taking the API down |

**Carried over from SPEC §17**

| Item | Status for this plan |
|---|---|
| Final product name and domain | non-blocking; needed before W4 (legal pages, hostname, `ALLOWED_ORIGIN`); the UI reads the name from one constant |
| Email provider (free tier) | non-blocking; Resend is used by Phase 0; needed for the §14 source-failure alert (W0(c)) and Phase 3 |
| Bag-fee table: airlines to seed first | non-blocking; drives the share of `bag_fee_estimated` results; owner verification needed before launch |
| Exact "deal" definition for the home page | Phase 4; not needed for v1 |

---

## 14. Change log

- **v0.4 (2026-09-29)** — after review round 3 (22 findings examined, 20 confirmed): the ⚖️ "fastest" reference and pool are independent of hour-window split variants; the bag-cost pool now applies consistently to 💰, ⚖️ and 🎯 and the closing gating paragraph no longer contradicts it; `bag_cost_unknown` status and note; `excludedForUnknownBagFee` counts only offers that could be cheaper, with matching copy; network errors map to Offline or generic by `navigator.onLine`; `checkedAt` defined as `string | null`; DD/MM echo beside native date fields; native `disabled` for the max-stops select; ACs added for robots/header/CORS/rate-limit enforcement; Hebrew plural forms use one/two/other. **Delta pass:** §7 compared with the merged Phase 1 Worker (32 differences, §7.8): the spec now uses `invalid_request`, `results`, the city-code `PlaceView`, strict submit-time resolution, the Worker's real limits and error codes, the sliding-window 429 semantics, and treats the remaining differences as the W0(b) work list; D18 added.
- **v0.3 (2026-09-29)** — after review round 2 (55 findings examined, 49 confirmed): loading copy no longer claims every pair is checked; one trigger for the passenger-estimate note; W0(d) staging gated on the Phase 0 proof and dependencies of W0(c)/W4 fixed; one `PlaceView` (nullable `nameHe`, `airports`); `myTimes.insufficient_data` removed and the 🎯 statuses defined; `sources[].checkedAt`; max-stops reset/restore rules; **bag-cost pool rule** (unknown fee no longer ranks as zero); ⚖️ independent of hour-window split variants, fastest-reference defined; party-aware booking links; `price_converted_ils`; hour window start ≠ end; error `fields` as machine codes, `retryAfterSec` and exposed `Retry-After`; service-worker routing and offline ACs; `RATE_LIMIT_SALT` required; lab/field performance budgets; `X-Robots-Tag` instead of a robots.txt disallow; Hebrew number-agreement forms and missing copy keys; README figures corrected.
- **v0.2 (2026-09-29)** — after an independent review (3 reviewers, a skeptic per finding; 34 of the 42 examined findings confirmed): UI work gated on the Phase 0 proof (W1 no longer starts early); the fallback for poor coverage no longer assumes a monitor that does not exist yet (D1); public launch stays at the end of Phase 4 unless decided otherwise (D17); cabin removed from v1 (C11); Best Value pool gating for unknown data (§5.3); max-stops control disabled until hours are set; price-context ILS fields; `validPairs` / `pairsWithOffers`; split links composed for every source; cache-key and recompute requirement (C13); live split composition made explicit (C12); source-failure alert scheduled (W0(c)); staging approval decision (D15); SPEC §17 items carried into §13; README/code attribution of limitations corrected; wrong cross-references fixed.
- **v0.1 (2026-09-29)** — first draft.
- Round 1 examined at most 14 findings per reviewer (30 lowest-severity ones were not examined); round 2 examined at most 20 per reviewer (8 lowest-severity ones were not examined); round 3 (high/medium only) examined all 22 findings raised. Rounds 1–2 unexamined items are low severity and were not re-run.

---

## Appendix A — Hebrew copy deck (initial; final wording is the owner's)

**Number agreement:** every string with `{n}` needs a singular form for 1, a dual form for 2 and a general form for everything else (`Intl.PluralRules('he')` selects `one`, `two` or `other`; render `other` with the ordinary plural wording, e.g. "{n} שעות"). The forms are written out for the keys that will realistically show 1 and 2 (`card.age.hours`, `state.rate`, `form.combos`, `note.bag.excluded`); the same rule applies to `note.times.unverified` and every other `{n}` key, and is unit-tested for n = 0, 1, 2, 3, 11. The flag texts in §5.4 are part of the copy deck.


| Key | Hebrew |
|---|---|
| form.origin.label | מאיפה טסים? |
| form.origin.placeholder | עיר או שדה תעופה (עברית / English / TLV) |
| form.destination.label | לאן טסים? |
| form.window.start | יציאה מוקדמת ביותר |
| form.window.end | חזרה מאוחרת ביותר |
| form.stay.label | כמה לילות? |
| form.stay.min / max | מינימום / מקסימום |
| form.stay.helper | נחפש מחירים בטווח התאריכים ובמספר הלילות שבחרתם |
| form.combos | בטווח הזה יש צירוף תאריכים אפשרי אחד / שני צירופי תאריכים אפשריים / {n} צירופי תאריכים אפשריים (one / two / other) |
| form.adults / children / infants | מבוגרים / ילדים (2–11) / תינוקות (מתחת לגיל 2) |
| form.bag | מזוודה 23 ק״ג לכל נוסע |
| form.bag.helper | לא סימנת? לא נוסיף עלות מזוודה למחיר. אם המקור מדווח שהמחיר כולל מזוודה, נסמן 🎁. |
| form.prefs.title | העדפות לשעות ולעצירות (לא חובה) |
| form.prefs.helper | ההעדפות האלה משפיעות רק על ההמלצה ‘מתאים לשעות שלי’, לא על ‘הכי זול’ ו‘התמורה הטובה ביותר’. |
| form.pax.note | מחיר לכמה נוסעים הוא הערכה. |
| form.pax.note.kids | ילדים ותינוקות עשויים לשלם מחיר אחר. |
| form.maxstops.helper | עצירות משפיעות רק יחד עם שעות מועדפות |
| form.advanced | מתקדם |
| form.nearby | כלול שדות תעופה קרובים |
| form.submit | חפשו את המחיר הזול ביותר |
| tag.cheapest / best_value / my_times | 💰 הכי זול / ⚖️ התמורה הטובה ביותר / 🎯 מתאים לשעות שלי |
| card.book | להזמנה |
| card.book.out / ret | הזמנת הלוך / הזמנת חזור |
| card.affiliate | קישור שותפים — ייתכן שנקבל עמלה ללא עלות נוספת עבורך |
| card.age.now | נבדק עכשיו |
| card.age.hours | נבדק לפני שעה / נבדק לפני שעתיים / נבדק לפני {n} שעות (one / two / other) |
| card.savings | חסכת ₪{n} לעומת הלוך-חזור |
| card.context | לפני שבוע: ₪{a} \| הכי נמוך שראינו: ₪{b} |
| card.time.unknown | שעת המראה: תופיע באתר ההזמנה |
| card.stops.unknown | עצירות: לא ידוע |
| card.stops.direct / one / many | ישירה / עצירה אחת / {n} עצירות |
| card.atleast | לפחות |
| note.value.insufficient | אין מספיק נתונים על עצירות וזמני טיסה כדי לדרג תמורה. |
| note.value.bag | לא ניתן לדרג תמורה כי עלות המזוודה לא ידועה |
| note.times.none | לא מצאנו הצעה בשעות שביקשת. |
| note.times.unverified | לא הצלחנו לאמת שעות ל‑{n} הצעות. |
| footer.disclaimer | המחיר הסופי מוצג באתר ההזמנה. ייתכנו עמלות המרת מטבע בכרטיס האשראי. |
| state.loading.0 | מחפשים מחירים בטווח התאריכים שבחרתם… |
| state.loading.3 | עדיין בודקים — זה יכול לקחת כמה שניות |
| state.loading.10 | המקורות איטיים היום, ממשיכים לנסות |
| state.empty.title | לא נמצאו מחירים לטווח הזה |
| state.empty.tips | הרחיבו את טווח התאריכים · הוסיפו לילות · כללו שדות תעופה קרובים · נסו יעד אחר |
| state.unavailable | לא הצלחנו לבדוק מחירים כרגע. נסו שוב בעוד כמה דקות. |
| state.rate | ביצעתם הרבה חיפושים. אפשר לנסות שוב בעוד שנייה / שתי שניות / {n} שניות. (one / two / other) |
| state.partial | אחד ממקורות המחירים לא זמין כרגע; ייתכנו הצעות זולות יותר שלא הוצגו. |
| state.truncated | החיפוש נחתך לפני שנבדקו כל הצירופים — צמצמו את הטווח לתוצאות מלאות יותר |
| tag.cheapest.truncated | 💰 הכי זול מבין מה שנבדק |
| details.pairs | נמצאו מחירים ל‑{x} מתוך {y} צירופי תאריכים |
| flag.bag.unverified | המחיר כולל מזוודה לפי Google — כדאי לאמת באתר ההזמנה |
| state.offline | אין חיבור לאינטרנט |
| state.generic | משהו השתבש. נסו שוב. |
| state.timeout | הבדיקה לוקחת יותר מדי זמן. אפשר לנסות שוב או לשנות את החיפוש. |
| state.idle | הזינו מוצא, יעד, טווח תאריכים ומספר לילות, ונמצא לכם את המחיר הזול ביותר. |
| err.summary | יש שדות שצריך לתקן לפני החיפוש |
| err.required | שדה חובה |
| err.invalid_format | הערך אינו תקין |
| err.out_of_range | הערך מחוץ לטווח המותר |
| err.place_not_found | לא מצאנו מקום כזה — נסו שם אחר או קוד שדה תעופה |
| err.same_place | המוצא והיעד זהים |
| err.start_after_end | תאריך היציאה מאוחר מתאריך החזרה |
| err.past_date | התאריך עבר |
| err.window_too_long | טווח התאריכים ארוך מדי — קצרו אותו |
| err.stay_range_invalid | טווח הלילות אינו תקין |
| err.stay_too_long | מספר הלילות גדול מדי |
| err.too_many_pairs | יש יותר מדי צירופי תאריכים — צמצמו את הטווח |
| err.too_many_passengers | עד 9 נוסעים |
| err.infants_exceed_adults | מספר התינוקות לא יעלה על מספר המבוגרים |
| err.hours_invalid | טווח השעות אינו תקין |
| err.not_supported | האפשרות הזו אינה נתמכת כרגע |
| link.unavailable | קישור ההזמנה אינו זמין כרגע |
| btn.cancel / btn.retry / btn.edit | ביטול / נסו שוב / עריכה |
| preset.morning / noon / evening / night | בוקר 06–12 / צהריים 12–17 / ערב 17–23 / לילה 23–06 |
| card.split.warning | שני כרטיסים נפרדים: מזמינים בנפרד, כללי כבודה ושינויים חלים על כל כרטיס לחוד, ואין הגנה אם אחד מהם משתנה או מתבטל. |
| card.details.toggle | פרטים על הנתונים |
| search.details | פרטי החיפוש |
| note.bag.excluded | הצעה אחת נוספת עשויה להיות זולה יותר, אך עלות המזוודה שלה לא ידועה / {n} הצעות נוספות עשויות להיות זולות יותר, אך עלות המזוודה שלהן לא ידועה (one / other) |
| link.disclosure | קישור שותפים — למידע נוסף |
