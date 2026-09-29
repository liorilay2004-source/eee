# WEB_APP_SPEC — Web UI & Public API (SPEC Phase 2 + API contract)

> Status: **Draft v0.1 for owner review** · Date: 2026-09-29
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
| Search form (origin, destination, window, nights, passengers, checked bag, time preferences, advanced: cabin / max stops / nearby airports) | ✅ | — |
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
| Phase 0 engine (`engine/`) | Built; CI green; live Google Flights verified for TLV⇄BCN (31–32 offers, ≈ ₪968 cheapest, no blocking, including from a GitHub Actions runner) | Reference behavior for recommendations. |
| **Travelpayouts coverage for TLV / ETM** | **Unverified — needs the owner's token.** This is the *blocking* open question in SPEC §17 | The web app's value depends on it (D1, R1). |
| Phase 1 Worker (`worker/`, branch `phase1-worker`) | **In implementation; not reviewed, merged or deployed** | The API contract in §7 is aligned with `worker/src/types.ts` at time of writing and lists required additions. Re-verify before W2. |
| Google Flights data | Background monitor only (Python, GitHub Actions, SPEC §6). The live Worker does **not** call Google | Live results come from Travelpayouts (+ any monitor-written offers already in D1). |
| Cloudflare / deployment | Not deployed (owner decision: not in this step) | Web app is developed against fixtures and a locally run Worker until W0 completes. |

Known engine limitations that directly shape the UI (documented in `README.md`, not hidden):
1. Google round-trip results carry **no return-leg times** (second page on Google).
2. Travelpayouts prices are **per adult**; the engine multiplies by passengers → an **approximation**, especially with children/infants.
3. `config/bag_fees.json` is **placeholder** data; unknown carriers get "bag fee unknown".
4. Best Value estimates an unknown return leg from the outbound leg.
5. Carry-on baggage is **not modeled** (only `checkedBag`).
6. Split tickets have **one** booking link in the model; a split needs two.
7. Offers carry airline **codes** only (no names), and Travelpayouts rows carry no arrival time.

---

## 3. Architecture (unchanged from SPEC §6)

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

### 3.1 Web app layout (new directory `web/`)
```
web/
  index.html              lang="he" dir="rtl", <meta name="robots" content="noindex"> until launch (D8)
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
- **Service worker:** app-shell precache only; `/api/*` is **network-only, never cached** (prices must not be served stale by the browser).

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
| 8 | Infants — "תינוקות (עד 2)" | `infants` | no | 0 | stepper | infants ≤ adults; total ≤ 9 |
| 9 | Checked bag — "מזוודה 23 ק״ג לכל נוסע" | `checkedBag` | no | off | checkbox | — |
| 10 | Preferred hours — outbound / return | `outHours`, `retHours` | no | none | hour-range control (§4.7) | integers 0–24 |
| 11 | Max stops — "עד כמה עצירות" | `maxStops` | no | none | select: any / direct / ≤1 / ≤2 | — |
| 12 | Nearby airports — "כלול שדות תעופה קרובים" | `nearbyAirports` | no | off | checkbox | — |
| 13 | Cabin — "מחלקה" | `cabin` | no | economy | select | one of 4 |

Sections: **core** (1–9) always visible; **"העדפות לשעות ולעצירות"** (10–11) and **"מתקדם"** (12–13) collapsed.
Carry-on / trolley (SPEC §5) is **not offered in v1** because the engine does not model it (D5) — a control that changes nothing would be a lie.

**Transparency line** under the dates/nights (client-side, computed from the same rule as the engine's `valid_pairs`): "נבדוק עד N צירופי תאריכים" (N ≤ 400 PROVISIONAL; over the limit → inline error asking to narrow the window).

**Semantics copy (mandatory, near the fields):**
- Under the bag checkbox: "לא סימנת? לא נוסיף עלות מזוודה למחיר. הצעות שכוללות מזוודה בכל מקרה יסומנו 🎁."
- Under preferences: "ההעדפות האלה משפיעות רק על ההמלצה ‘מתאים לשעות שלי’, לא על ‘הכי זול’ ו‘התמורה הטובה ביותר’." (SPEC §8; see C1/D4.)

### 4.4 Location combobox
- WAI-ARIA combobox (listbox popup). Input accepts **Hebrew, English or IATA** (SPEC §4.3), with the Hebrew-aware normalization done **server-side** by `GET /api/airports` (niqqud, final letters, geresh, hyphens).
- Debounce 200 ms; query ≥ 2 characters (3-letter IATA accepted); at most 8 suggestions; each shows city (Hebrew, English secondary), country, and code(s). A city with several airports resolves to the **city code** (engine expands to airports); a specific airport can be chosen.
- Free text that was not selected from the list is resolved on submit through the same endpoint (top match) and the resolved name is **shown back** on the results summary, so a wrong guess is visible.
- Failure of the autocomplete request MUST NOT block searching by 3-letter IATA code.

### 4.5 Dates and nights
Semantics: the engine searches **every** (depart, return) pair with `windowStart ≤ depart`, `return ≤ windowEnd`, `stayMin ≤ nights ≤ stayMax` (SPEC §7, layer 1). Helper text: "נבדוק את כל הצירופים בטווח שמתאימים למספר הלילות".
- Native `<input type="date">` in v1 (best RTL/mobile accessibility, zero dependencies). Display and copy use `DD/MM` (SPEC §14); the year is shown when the window crosses a year boundary. A custom range calendar is deferred (D12).
- Dates are dates, not instants: no timezone conversion anywhere in the client.

### 4.6 Passengers and baggage
- Steppers with min/max, ≥ 44 px targets, announced values ("מבוגרים: 2").
- If children or infants > 0, show a persistent note: "מחירים למספר נוסעים הם הערכה" (§5.4 flag `price_estimated_pax`).
- Checked bag semantics per §4.3. When checked, totals include the engine's fee table (labelled **estimated**, §5.4) and unknown-fee offers are labelled, never guessed.

### 4.7 Time preferences
- Two optional controls (outbound departure, return departure). Presets: "בוקר 06–12", "צהריים 12–17", "ערב 17–23", "לילה 23–06" (wrap-around, supported by the engine), plus custom start/end selects (0–24).
- Leaving both empty = no restriction and **hides** the 🎯 card (SPEC §8).
- Only departure hours are constrained (that is what the engine models); arrival hours are not offered.

### 4.8 URL state and persistence
- The search is encoded in the URL query (codes and ISO dates only, no personal data): `?o=TLV&d=BCN&ws=2026-11-10&we=2026-11-25&n=5-7&a=1&c=0&i=0&bag=1&oh=6-14&rh=12-23&st=1&nb=1&cab=economy`. Opening such a URL prefills the form, validates it (invalid params fall back to defaults with an inline notice) and runs the search.
- The last search is stored in `localStorage` (device only; every access wrapped in try/catch; the app works without it). A "מחק נתונים שמורים" action clears it. No cookies.

---

## 5. Results (S3)

### 5.1 Layout
1. **Summary bar:** "תל אביב ⇄ ברצלונה · 10/11–25/11 · 5–7 לילות · מבוגר 1" + "עריכה". City names come from the API's `meta.resolved` (NEW) so a mis-resolved place is visible.
2. **Notices** (only when applicable): partial-source banner, cache/freshness note, "why isn't there a ‘matches my times’ card" note (§5.3).
3. **Up to three cards** (§5.2). A card can carry several tags when the same offer wins several categories (SPEC §8 display rule).
4. **"פרטי החיפוש"** disclosure: sources used and their status, FX rate date/source, number of date combinations checked, "נבדק לפני X" per source.
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
| 💰 Cheapest | ≥ 1 priced offer | no offers → Empty (S4) |
| ⚖️ Best Value | The winning offer has **known stops or known duration on at least one leg**, so penalties are computed from data. If it is the same offer as Cheapest, it is **merged** (one card, two tags). | If the winner has stops **and** duration unknown on both legs, the ⚖️ tag is **not shown**; note: "אין מספיק נתונים על עצירות וזמני טיסה כדי לדרג תמורה." If the ranking used the engine's fallback (return leg estimated from outbound) → shown with flag `inbound_estimated_from_outbound`. |
| 🎯 Matches My Times | The user set at least one hour window (SPEC §8) **and** ≥ 1 offer has a *known* departure hour inside every constrained direction (and known stops ≤ `maxStops` when set). The engine already treats unknown hours/stops as non-matching. | Not requested → hidden, no note. Requested but none verified → hidden, with note: "לא מצאנו הצעה בשעות שביקשת" (all checked, none inside) **or** "לא הצלחנו לאמת שעות ל‑N הצעות" (some offers lacked times). |

The API states which case applies (`meta.recommendations`, NEW, §7.3) so the client never has to re-derive gating, and the numbers in the note are exact.

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
| `bag_fee_unknown` | tag `bag_fee_unknown` | **warning** | "עלות המזוודה לא ידועה — המחיר אינו כולל מזוודה" (total shown as "לפחות") |
| `bag_included_bonus` | tag `bonus_checked_bag` | positive | "🎁 כולל מזוודה" |
| `split_ticket` | `ticketStructure == "split"` | **warning** | "שני כרטיסים נפרדים — מזמינים כל אחד בנפרד" (§5.6) |
| `airline_unknown` | no airline codes | info | "חברת תעופה לא ידועה" |
| `stale_price` | `ageHours ≥ 12` (configurable) | warning | "המחיר נבדק לפני X שעות ועשוי להשתנות" |

Rules: severity is conveyed by **icon + text + style**, never color alone. Notices collapse behind one "פרטים על הנתונים" toggle per card on mobile, with a count; warnings stay visible. No flag is ever silently dropped.

### 5.5 Price display
- Format (SPEC §4.2): **`≈ ₪606 ($164)`** — ILS first, original currency in parentheses. Original ILS with no extras: `₪606`. With extras: `≈ ₪606 ($164 + מזוודות ₪90)`.
- Rounding: both amounts are **rounded up to whole units**, as the engine's report does. Numbers use grouping (`₪1,060`). Formatting is custom, **not** `Intl` currency style (`he-IL` renders `606 ₪`, which contradicts SPEC's `₪606`).
- Bidi: amounts, dates (`DD/MM`), times and IATA codes are wrapped as **LTR isolates** (`<bdi>` / `unicode-bidi: isolate`) so they do not reorder inside Hebrew text. Screen-reader label example: "כ‑606 שקלים, שווה ל‑164 דולר".
- `bag_fee_unknown` → prefix "לפחות".
- **Price context line** (SPEC §8): `לפני שבוע: ₪X | הכי נמוך שראינו: ₪Y`, shown only when history exists. Comparison and trend arrow are computed in the **original currency** (SPEC §4.2); the ₪ figures shown are those original amounts converted at **today's** rate, so the line stays consistent with the headline price (C3).
- Split-ticket savings: **"חסכת ₪X לעומת הלוך-חזור"** (exact SPEC §16 wording) only when `savingsVsRoundtripIls` is set.

### 5.6 Booking CTA and links
- Primary CTA: "להזמנה" → `links.book`. `target="_blank"`, `rel="sponsored noopener noreferrer"`.
- **Split ticket:** two CTAs, "הזמנת הלוך" (`links.book`) and "הזמנת חזור" (`links.bookReturn`), plus the warning: "שני כרטיסים נפרדים: מזמינים בנפרד, כללי כבודה ושינויים חלים על כל כרטיס לחוד, ואין הגנה אם אחד מהם משתנה או מתבטל." (D3)
- Every card MUST have a working booking link (SPEC G5); the API composes an Aviasales search link (with the affiliate marker) when the source row has none.
- Affiliate disclosure next to the CTA: "קישור שותפים — ייתכן שנקבל עמלה ללא עלות נוספת עבורך" → disclosure page.
- The client renders a booking URL **only if** it is `https:` and its host is on an allow-list (`aviasales.com`, plus partner tracking hosts confirmed in W0); otherwise the CTA is disabled with "קישור ההזמנה אינו זמין כרגע". The Google Flights verify link (`links.verify`) is **not shown** in the public UI in v1 (D9).
- Hotel button: not in v1 (SPEC §13 → Phase 4). A layout slot is reserved.

---

## 6. States catalog

| State | Trigger | UX | A11y | Actions |
|---|---|---|---|---|
| **Idle** | first load | empty results area; short explainer | — | fill form |
| **Client-invalid** | submit with invalid fields | inline field errors + error summary; focus moves to the summary; no request sent | `role="alert"` summary; `aria-invalid`, `aria-describedby` | fix |
| **Loading** | request in flight | skeleton cards; 0–3 s: "בודקים מחירים בכל צירופי התאריכים…"; 3–10 s: "עדיין בודקים — זה יכול לקחת כמה שניות"; > 10 s: "המקורות איטיים היום, ממשיכים לנסות" | `role="status"` (polite), announced once per phase; controls disabled except "ביטול" | cancel (AbortController) |
| **Timeout** | no response in 25 s | error variant with retry | — | retry, edit |
| **Success** | `cards.length ≥ 1` | summary + cards | focus to results heading | book / edit |
| **Partial** | ≥ 1 source with `enabled && !ok` | banner: "אחד ממקורות המחירים לא זמין כרגע; ייתכנו הצעות זולות יותר שלא הוצגו" | banner is `role="status"` | retry later |
| **Served from cache** | `meta.fromCache` | age shown on cards ("נבדק לפני X שעות"); no extra banner | — | — |
| **Empty** | ≥ 1 source `ok` and 0 offers | "לא נמצאו מחירים לטווח הזה" + suggestions: widen the window, more nights, nearby airports, another destination | heading + list | one-tap edits |
| **Unavailable** | 503 `source_unavailable`, or all sources failed | "לא הצלחנו לבדוק מחירים כרגע. נסו שוב בעוד כמה דקות." | `role="alert"` | retry |
| **Rate limited** | 429 `rate_limited` + `Retry-After` | "ביצעתם הרבה חיפושים. אפשר לנסות שוב בעוד N שניות" with a countdown; submit disabled meanwhile | countdown announced sparingly (start + end) | wait |
| **Server-invalid** | 400 `validation_failed` | field errors mapped from `error.fields` | as Client-invalid | fix |
| **Payload/other 4xx/5xx** | 413/415/500 | generic "משהו השתבש" + retry | `role="alert"` | retry |
| **Offline** | `navigator.onLine === false` / fetch network error | "אין חיבור לאינטרנט" (form stays usable) | `role="alert"` | retry when online |

**Empty vs Unavailable rule (P1):** "no results" is only claimed when a source actually answered and returned nothing. If sources failed, the UI says it could not check — never "no flights".

---

## 7. Public API contract v1

### 7.1 Conventions
- JSON over HTTPS, UTF-8, camelCase. Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC. Money = original amount + currency (never overwritten), plus ILS comparison values.
- Paths: `/api/search`, `/api/airports`, `/api/health`. Responses carry `meta.apiVersion` (NEW, `1`). Additive changes do not bump the version; a breaking change requires a new path prefix.
- Headers on every API response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. CORS only for `ALLOWED_ORIGIN`. Errors use one envelope (§7.5).

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
  "cabin": "economy",                          // economy | premium-economy | business | first
  "checkedBag": false,                         // default false
  "outHours": [6, 14],                         // [start,end) 0–24, wrap-around allowed; null/omitted = no restriction
  "retHours": [12, 23],
  "maxStops": null,                            // null/omitted = no restriction
  "nearbyAirports": false
}
```
**Validation limits — PROVISIONAL** (from the Phase 1 brief; the Worker is the source of truth and the UI mirrors it from `config.ts`): window 1–120 days; `windowStart ≥ today (UTC)`; stay ≤ 30 nights and `stayMin ≤ stayMax`; passengers ≤ 9 and `infants ≤ adults`; hours integers 0–24; ≤ 400 valid date pairs; strict types (no numeric strings).

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
    sources: SourceStatus[];         // { name, enabled, ok, calls, offers, error }
    candidatePairs: number;
    generatedAt: string;
    resolved: {                      // NEW — what the server understood
      origin: PlaceView;             //   { code, kind: "city"|"airport", nameHe, nameEn, countryCode }
      destination: PlaceView;
    };
    recommendations: {               // NEW — drives gating notes (§5.3)
      cheapest:  { status: "shown" | "no_offers" };
      bestValue: { status: "shown" | "merged" | "insufficient_data" | "no_offers" };
      myTimes:   { status: "shown" | "merged" | "not_requested" | "no_verified_match" | "insufficient_data" | "no_offers";
                   checkedOffers: number; unverifiableOffers: number };
    };
    noticeCodes: string[];           // NEW — e.g. "truncated_by_subrequest_budget" (PROVISIONAL)
  };
}

interface CardView {
  offer: Offer;                      // existing: origin, destination, departDate, returnDate, priceAmount, priceCurrency,
                                     //   source, ticketStructure, outbound, inbound, includes, deeplink, verifyLink,
                                     //   checkedAt, extrasAmountIls, totalIls, tags
  kinds: ("cheapest" | "best_value" | "my_times")[];
  savingsVsRoundtripIls: number | null;
  priceContext: { currency: string; weekAgoAmount: number | null; lowestAmount: number | null } | null;
  ageHours: number;
  flags: string[];                   // NEW — §5.4 codes
  links: {                           // NEW — the client never reads offer.deeplink directly
    book: string;                    //   always non-null (SPEC G5); split → the outbound ticket
    bookReturn: string | null;       //   non-null iff ticketStructure == "split"
    verify: string | null;           //   Google Flights check link, not rendered in v1 (D9)
  };
  airlineNames?: Record<string, string>; // NEW, optional — IATA code → display name (§7.7 gap 7)
}
```
Invariants the client MAY rely on: `cards` is empty only with `meta.recommendations.cheapest.status = "no_offers"`; a `my_times` kind never appears unless `outHours`/`retHours` was sent; every `flags` entry is a code from §5.4 (unknown codes are ignored by the client, not rendered raw).

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
    "sources": [{ "name": "travelpayouts", "enabled": true, "ok": true, "calls": 4, "offers": 2, "error": null }],
    "candidatePairs": 2, "generatedAt": "2026-09-29T11:00:01.000Z",
    "resolved": {
      "origin": { "code": "TLV", "kind": "city", "nameHe": "תל אביב", "nameEn": "Tel Aviv", "countryCode": "IL" },
      "destination": { "code": "BCN", "kind": "city", "nameHe": "ברצלונה", "nameEn": "Barcelona", "countryCode": "ES" }
    },
    "recommendations": {
      "cheapest": { "status": "shown" }, "bestValue": { "status": "shown" },
      "myTimes": { "status": "merged", "checkedOffers": 2, "unverifiableOffers": 0 }
    },
    "noticeCodes": []
  }
}
```
(Illustrative values, consistent with the engine's rules: W6 is both the cheapest offer and the cheapest one inside the requested hours, so it is one card with two tags; the direct LY flight wins Best Value because W6's two stops and extra flight time add ₪558 of penalty (2 × ₪180 stops + ≈ ₪76 and ≈ ₪123 duration) against a price gap of ₪230. `flags` is empty because every displayed datum is known and there is one passenger. A real response only ever contains §5.4 codes.)

### 7.3 `GET /api/airports?q=<text>&limit=<1..8>`
Autocomplete (Hebrew-aware). `200 { "matches": PlaceView[] }` where `PlaceView = { code, kind: "city"|"airport", airportCode?, nameHe: string|null, nameEn, countryCode, airports: string[] }`. Empty/garbage/too long (> 64 chars) → `200 { "matches": [] }` (never an error). Not rate-limited as strictly as search (a separate, higher limit — D14).

### 7.4 `GET /api/health`
Liveness + D1 reachability for ops; not used by the UI.

### 7.5 Errors
Envelope: `{ "error": { "code": string, "message": string, "fields"?: Record<string,string> } }`. Messages are for developers; the UI maps **codes** to Hebrew copy. No stack traces, upstream bodies or tokens are ever returned.

| HTTP | `code` | Meaning | UI state |
|---|---|---|---|
| 400 | `validation_failed` (+ `fields`) | invalid input | Server-invalid |
| 400 | `destination_required` | empty destination (until W5) | inline error on destination |
| 400 | `invalid_json` | body not JSON | generic |
| 413 | `payload_too_large` | body > 8 KB | generic |
| 415 | `unsupported_media_type` | not JSON | generic |
| 429 | `rate_limited` (+ `Retry-After`) | > 30 searches / 10 min per client (PROVISIONAL, SPEC §14) | Rate limited |
| 502/503 | `source_unavailable` | no fresh/cached data and sources failed | Unavailable |
| 500 | `internal_error` | unexpected | generic |

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
| 1 | Split ticket has **one** link (`deeplink` = outbound) | user cannot book the return ticket → SPEC G5 violated for split cards | `links.book` + `links.bookReturn` (NEW); or hide split offers (D3) |
| 2 | No `flags` / `recommendations` status | client would re-derive gating and could disagree with the engine | API computes and returns them (NEW) |
| 3 | Google round trips lack return-leg times | `inbound_time_unknown`; 🎯 cannot verify return hours | flag + gating rules (§5.3); Travelpayouts rows do include return time |
| 4 | Passenger price = per-adult × pax | wrong for children/infants | `price_estimated_pax` flag now; refine pricing later (D13) |
| 5 | Bag fees are placeholders; no carry-on | totals with a bag are estimates; no trolley option | `bag_fee_estimated` flag; carry-on out of v1 (D5) |
| 6 | Arrival times null from Travelpayouts | cards can't show arrival | omit arrival; do not label as unknown |
| 7 | Airline codes only | "W6" is opaque to users | small IATA→name table (Hebrew/English) bundled in the web app or returned as `airlineNames` |
| 8 | `priceContext` in original currency vs SPEC §8 line in ₪ | ambiguity | C3 |
| 9 | Search key excludes bag/hours/max-stops (cache stores **raw** offers; ranking re-applied per request) | none for the UI; note for QA | tests in §11 |
| 10 | Live Worker uses only Travelpayouts (+ monitor-written offers) | "two sources compared" (SPEC layer 2) is only partly true in v1 | say so in "פרטי החיפוש"; do not claim comparison that did not happen |

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
- Budgets (measured on a mid-range Android over 4G, p75): LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms; initial JS ≤ 150 KB gzip; no render-blocking third-party requests.
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
| Rate-limit key | D1 `rate_limits` = salted SHA-256 of client IP | 1 day | **raw IPs are never stored**; salt kept as a Worker secret |
| Last search / prefs | `localStorage`, device only | until cleared | no cookies set by us |
| Cloudflare edge logs | Cloudflare (processor) | per Cloudflare | name Cloudflare in the policy |
| Click-outs to Aviasales/Travelpayouts | third party | — | disclose affiliate relationship and that the partner site has its own policy |

- A retention job (Worker cron trigger) is a **dependency** for these periods (W0/W4).
- No accounts, emails or marketing in v1 → no consent banner needed for our own storage; **confirm with an adviser** (D6). Marketing email later requires explicit consent and one-click unsubscribe (SPEC §14).
- Minimum pages (Hebrew): privacy policy, terms of use, **affiliate disclosure** (SPEC §14), accessibility statement. Owner supplies or approves the legal text.

### 8.6 Discoverability
Until public launch: `<meta name="robots" content="noindex,nofollow">`, `robots.txt` disallow-all, no sitemap, neutral hostname (D8). At launch the flag flips as a deliberate release step.

### 8.7 Observability
No third-party analytics in v1. Server-side: structured logs without PII, `source_health` updates (SPEC §12), Worker metrics from Cloudflare. Click/conversion analytics = Phase 4 (D10).

---

## 9. Release scope summary

**v1 (this document's target) = SPEC Phase 2, core:** form, results, states, data-quality flags, PWA, minimum legal pages, accessibility and performance gates.
**Phase 2 follow-up (W5):** spontaneous mode ("לאן הכי זול לטוס מ‑… החודש") and home deals (SPEC §9).
**Phase 3:** accounts (magic link), saving a search as a watch (5 per user, SPEC §10), email + in-app banner alerts, monitor cadence.
**Phase 4:** hotel links, analytics, deal definition, full legal.

---

## 10. Delivery plan

Sizes are relative (S/M/L), not calendar promises. Nothing here deploys anything; deployment steps are gated on the owner's approval per SPEC §18.

| Stream | Scope | Depends on | Exit criteria | Size |
|---|---|---|---|---|
| **W0 — Data & API gate** | (a) Owner adds `TRAVELPAYOUTS_TOKEN`/marker; run the coverage test for TLV/ETM sample routes (D1). (b) Phase 1 Worker reviewed, merged, and its NEW contract members implemented (`flags`, `links`, `meta.resolved`, `meta.recommendations`). (c) Data-retention job. (d) Staging Worker reachable with `ALLOWED_ORIGIN`. | owner token; Phase 1 | `/api/search` returns real results for the agreed sample routes; contract fixtures published; SPEC §16 API-level criteria pass | M (blocked on owner) |
| **W1 — Foundations** | Scaffold `web/` (Vite/React/TS/Tailwind RTL), design tokens, `copy/he.ts`, formatters (money/date/bidi) with unit tests, API client + error mapping, CI (typecheck, lint, tests, build), noindex | W0(b) contract types | CI green; formatter tests cover §5.5 rules | S |
| **W2 — Search form** | Combobox, dates/nights, steppers, bag, preferences, advanced, client validation, URL state, localStorage | W1 | AC-F* pass on Chromium + WebKit emulation; axe clean | M |
| **W3 — Results & states** | Cards, gating, flags, price display, split UX, booking links + allow-list, all states in §6, "פרטי החיפוש" | W2, W0(b) | AC-R*, AC-S* pass with fixtures **and** against staging | L |
| **W4 — Quality & launch readiness** | PWA (manifest, SW, offline page, update flow), a11y audit incl. manual SR, perf budgets, CSP/headers, real-device pass (iPhone, Android), legal pages, launch checklist | W3, legal text (D6) | AC-A*, AC-M*, AC-P*, AC-SEC* pass; owner sign-off | M |
| **W5 — Spontaneous mode & home deals** | `/api/explore`, destination-less form path, ranked list → opens full search, home "deals" | W4, Travelpayouts destination query | SPEC §16 spontaneous criterion; own AC set | M–L |
| Later | Phase 3, Phase 4 | per SPEC | per SPEC | — |

Dependency chain: `owner token → W0(a) → W0(b) → W1 → W2 → W3 → W4 → (public launch decision) → W5 → Phase 3 → Phase 4`. W1 may start before W0(a) completes using fixtures.

### 10.1 Risks
| ID | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| R1 | **Travelpayouts coverage/freshness poor for TLV/ETM** (SPEC §17, blocking) | ? | Critical | Run W0(a) first; define the gate (D1); fallback = Google-based monitor cache with delayed results (changes UX promise) — decide before W2 |
| R2 | Estimates dominate the UI (pax, bag, missing times) and erode trust | M | High | flags (§5.4), honest gating (§5.3), owner verifies `bag_fees.json` |
| R3 | Workers Free limits: **10 ms CPU/request**, 50 external subrequests, 100k requests/day; D1 free daily row limits now enforced (queries fail until 00:00 UTC) | M | High | subrequest cap (30 — PROVISIONAL), cache-first design, measure CPU in staging, alert on 1102/D1 errors; paid plan only by owner choice |
| R4 | Rate limit (30/10 min/IP) hits legitimate users behind shared mobile-carrier IPs | M | Med | monitor 429 rate; adjust limits; user-friendly 429 UX |
| R5 | Google Flights scraping blocked/changed (monitor only) | M | Med | monitor is optional (SPEC source-reliability rule); UI never depends on it |
| R6 | Legal exposure (affiliate disclosure, privacy, accessibility, marketing email) | M | High | D6: minimum pages before any public exposure; adviser review |
| R7 | Hebrew city data errors (wrong code/name) | M | Med | data audit in Phase 1 review; user-visible "resolved as" echo (§5.1) |
| R8 | Split-ticket misunderstanding (missed connection, separate baggage rules) | M | High | warning copy, two clear CTAs, D3 |
| R9 | Affiliate program approval/marker missing → links not monetized | L | Med | W0(a) checks; `links.book` still works without marker |
| R10 | RTL/bidi glitches on iOS/Android date inputs and mixed content | M | Med | isolates (§5.5), real-device pass (W4) |
| R11 | Hosting choice (Pages vs Workers static assets) causes rework | L | Low | D2 before W1; app is hosting-agnostic |

---

## 11. Acceptance criteria and test strategy

### 11.1 Acceptance criteria (Given / When / Then)
Legend: F = form, R = results, S = states, A = accessibility, M = mobile/PWA, P = performance, SEC = security/privacy, API = contract.

**Form**
- **AC-F1** Given the app loads, then defaults are 1 adult, 0 children, 0 infants, bag off, no hour windows, no max stops, economy (SPEC §4.1).
- **AC-F2** Given I type "ברצלונה", "Barcelona" or "BCN", then the combobox offers Barcelona; choosing it sets the code; the results summary later shows the Hebrew name the server resolved.
- **AC-F3** Given dates/nights with no valid pair (e.g. window 3 days, stay ≥ 5), then submit is blocked with an inline error and no request is made.
- **AC-F4** Given infants > adults or total passengers > 9, then submit is blocked with an inline error.
- **AC-F5** Given a valid search, then the URL contains the search parameters and reloading the URL restores the form and re-runs the search.
- **AC-F6** Given the autocomplete request fails, then I can still search by typing a 3-letter IATA code.
- **AC-F7** Given no hour windows are set, then the 🎯 explainer is not shown and the request omits `outHours/retHours`.

**Results & gating**
- **AC-R1** Given results, then at most three cards are shown and identical offers appear once with multiple tags (SPEC §8).
- **AC-R2** Given no preferred hours, then the 🎯 card is hidden with no note (SPEC §16).
- **AC-R3** Given preferred hours and `myTimes.status = no_verified_match` with `unverifiableOffers > 0`, then the note says times could not be verified for N offers and no 🎯 card is shown.
- **AC-R4** Given the winning Best Value offer has stops and duration unknown on both legs (`bestValue.status = insufficient_data`), then the ⚖️ tag is not shown and the note appears.
- **AC-R5** Given a USD price, then it is shown `≈ ₪X ($Y)`; given an ILS price, `₪X`; both rounded up (SPEC §4.2).
- **AC-R6** Given no bag selected and an offer that includes one, then the offer is tagged 🎁 and its price has no bag fee added (SPEC §4.1, §16).
- **AC-R7** Given a bag selected and an offer with an unknown fee (`bag_fee_unknown`), then the total is prefixed "לפחות" with a warning; no fee is invented.
- **AC-R8** Given passengers > 1 and a Travelpayouts offer, then `price_estimated_pax` is rendered on the card.
- **AC-R9** Given an unknown departure time, then the card says the time will appear on the booking site; no time is displayed.
- **AC-R10** Given a split ticket cheaper than every round trip, then the Cheapest card shows "חסכת ₪X לעומת הלוך-חזור", the warning block, and two booking CTAs (SPEC §16).
- **AC-R11** Given any card, then `links.book` opens in a new tab with `rel` containing `sponsored noopener noreferrer`; a non-allow-listed or non-https URL renders a disabled CTA.
- **AC-R12** Given `priceContext` exists, then the line `לפני שבוע: ₪X | הכי נמוך שראינו: ₪Y` shows; given null, it is absent.

**States**
- **AC-S1** Loading shows the phased messages at 0/3/10 s, is cancelable, and times out at 25 s with retry.
- **AC-S2** Given ≥ 1 source `ok` and 0 offers, then the Empty state with suggestions is shown; given all sources failed, the Unavailable state is shown, never "no flights".
- **AC-S3** Given 429 with `Retry-After: 30`, then the submit button is disabled with a countdown and re-enables at zero.
- **AC-S4** Given a source with `enabled && !ok`, then the Partial banner is shown.
- **AC-S5** Given offline, then the form remains usable and the Offline message appears on submit.
- **AC-S6** Given the API is served from cache, then each card shows its age and the disclaimer; given `ageHours ≥ 12`, `stale_price` is shown.

**Accessibility**
- **AC-A1** axe reports no serious/critical violations on S1, S3, S4, S5, S6 in Hebrew RTL.
- **AC-A2** The whole flow (fill form → search → open booking link) is completable by keyboard only.
- **AC-A3** VoiceOver (iOS) and TalkBack (Android) can complete the flow; loading, errors and results are announced once, not repeatedly.
- **AC-A4** At 200% zoom and 320 px width there is no horizontal scroll or clipped content.

**Mobile / PWA / performance**
- **AC-M1** Usable end-to-end on iPhone Safari and Android Chrome (SPEC §15).
- **AC-M2** The app is installable (manifest, service worker, HTTPS, icons); offline navigation shows the Hebrew offline page; `/api/*` is never served from the service-worker cache.
- **AC-P1** Meets the budgets in §8.3 in CI (Lighthouse CI) and on a real mid-range Android.

**Security / privacy**
- **AC-SEC1** The CSP in §8.4 is served; no inline script/style violations in the console.
- **AC-SEC2** No secret or token appears in the built bundle or repo (SPEC §16).
- **AC-SEC3** No third-party requests are made on page load (verified in Playwright network log).
- **AC-SEC4** No cookies are set; `localStorage` is cleared by the "מחק נתונים שמורים" action.
- **AC-SEC5** The privacy, terms, affiliate-disclosure and accessibility pages exist and are linked from the footer and near the CTA.

**API contract**
- **AC-API1** Every fixture and every staging response validates against the contract (types + JSON Schema) including NEW members.
- **AC-API2** Given the same search twice within 6 h, the second is served from D1 with zero external calls (SPEC §16) and `meta.fromCache = true`.
- **AC-API3** Given `ENABLE_FAST_FLIGHTS=false` (monitor off), the web app works unchanged (SPEC §16).
- **AC-API4** Every card has a non-null `links.book`; `links.bookReturn` is non-null iff the ticket structure is `split`.
- **AC-API5** Given a search that only changes bag, hours or max stops, then results are re-ranked without new external calls.

### 11.2 Test strategy
| Layer | Tooling | Covers |
|---|---|---|
| Unit | Vitest | money/date/hour/bidi formatters, URL state, validation, gating renderers, flag→copy mapping |
| Component | Vitest + Testing Library | Combobox, steppers, card variants (each flag, split, merged tags) |
| Contract | JSON Schema + fixtures; CI job hitting the staging Worker | AC-API* |
| End-to-end | Playwright (Chromium, WebKit, Firefox; mobile emulation) with recorded API fixtures for **every state in §6** | AC-F*, AC-R*, AC-S* |
| Accessibility | axe via Playwright; manual VoiceOver/TalkBack checklist | AC-A* |
| Performance | Lighthouse CI budgets; manual real-device run | AC-P1, AC-M2 |
| Security | header/CSP assertions, dependency audit, network-log assertion | AC-SEC* |

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
| §14 non-functional & safety | §8 |
| §15 phases | §9, §10 (Phase 2 = W1–W5) |
| §16 acceptance criteria | §11 (web-applicable items restated) |
| §17 open questions | §13 |
| §18 delivery workflow | §10 header (no deployment in this step) |

Other documents: `README.md` "Known limitations" (Phase 0) are the source of §2 limitations 1–5; `config/scoring.json` penalties and `cache_ttl_hours` are consumed, not duplicated; `config/project.json` supplies the brand constant.

### 12.2 Clarifications that extend or interpret `SPEC.md` (need owner approval)
- **C1 — Max stops scope.** SPEC §5 lists max stops as a filter ("no restriction if unset") but §8 applies it only to 🎯. This document follows §8 and groups hours + max stops under "preferences that affect only the 🎯 recommendation" (D4).
- **C2 — "Enough data" gating.** SPEC §8 hides 🎯 only when no hours were set. This document adds evidence-based gating for ⚖️ and 🎯 (§5.3) to honor "never guess".
- **C3 — Price context currency.** SPEC §8 shows the line in ₪; §4.2 requires original-currency comparison. Resolved as: compare in original currency, display converted at today's rate (§5.5).
- **C4 — Split tickets need two links and a warning** (SPEC §16 requires the savings message but not the second link; G5 requires a working link per result).
- **C5 — Minimum legal pages before public exposure** rather than only in Phase 4, because affiliate links exist from the first release.
- **C6 — `noindex` and neutral hostname until launch** (not in SPEC; matches the owner's stated wish to keep the repository/site low-profile).
- **C7 — Carry-on excluded in v1** because the engine does not model it (SPEC §5 lists it).
- **C8 — Spontaneous mode split into W5** although SPEC §15 lists it in Phase 2.
- **C9 — Shareable URL and device-local last search** (no SPEC text; no personal data involved).
- **C10 — Retention periods** for `searches` and `rate_limits` (not in SPEC).

---

## 13. Open decisions (owner input needed)

**Blocking**
| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Data-source gate: what counts as "enough Travelpayouts coverage" for TLV/ETM, and the fallback if it fails? | (a) ≥ 80 % of 10 agreed sample routes return ≥ 5 valid date pairs in two sample windows; fallback = delayed results from the Google monitor cache · (b) other threshold · (c) proceed regardless | (a). Needs the owner's Travelpayouts token first. |
| **D2** | Web hosting: Cloudflare Pages (SPEC §6) vs a Worker with static assets (Cloudflare's current React+Vite guide; same origin as the API, no CORS/preflight) | Pages · Workers static assets | Keep **Pages** per SPEC unless you approve the switch; decide before W1. |
| **D6** | Legal: who provides Hebrew privacy policy / terms / affiliate disclosure / accessibility statement, and are they required before any public URL is shared? | owner/adviser text · generated draft for adviser review | Pull them into W4 (before any public traffic); adviser reviews. |

**Product defaults (approve or change)**
| ID | Decision | Recommendation |
|---|---|---|
| D3 | Show split tickets in v1 (with warning + two links; needs `links.bookReturn`) or hide them until supported | Show, with the API change |
| D4 | Max stops applies only to 🎯 (SPEC §8) or as a hard filter on all cards | Keep SPEC (🎯 only), clearly labelled |
| D5 | Carry-on/trolley: omit in v1 or extend the engine | Omit in v1 |
| D7 | Spontaneous mode + home deals in the same release or right after core search | Right after (W5); destination required in v1 |
| D8 | Keep `noindex` + neutral hostname until you decide to launch | Yes |
| D9 | Show the Google Flights "verify" link in the public UI | No (owner/debug use only) |
| D10 | Analytics / click tracking in v1 | None; first-party, privacy-friendly events in Phase 4 |
| D11 | Retention: `searches` 90 days, `rate_limits` 1 day, `search_cache` 6 h | Approve |
| D12 | Date input: native date fields vs custom range calendar | Native in v1 |
| D13 | Children/infants pricing: keep multiplication with an "estimated" flag vs disable children/infants until accurate | Keep with flag |
| D14 | Rate limits: 30 searches/10 min/client on `/api/search`; separate, higher limit for `/api/airports` | Approve; revisit after real traffic (shared mobile IPs) |

---

## Appendix A — Hebrew copy deck (initial; final wording is the owner's)

| Key | Hebrew |
|---|---|
| form.origin.label | מאיפה טסים? |
| form.origin.placeholder | עיר או שדה תעופה (עברית / English / TLV) |
| form.destination.label | לאן טסים? |
| form.window.start | יציאה מוקדמת ביותר |
| form.window.end | חזרה מאוחרת ביותר |
| form.stay.label | כמה לילות? |
| form.stay.min / max | מינימום / מקסימום |
| form.stay.helper | נבדוק את כל הצירופים בטווח שמתאימים למספר הלילות |
| form.combos | נבדוק עד {n} צירופי תאריכים |
| form.adults / children / infants | מבוגרים / ילדים (2–11) / תינוקות (עד 2) |
| form.bag | מזוודה 23 ק״ג לכל נוסע |
| form.bag.helper | לא סימנת? לא נוסיף עלות מזוודה למחיר. הצעות שכוללות מזוודה בכל מקרה יסומנו 🎁. |
| form.prefs.title | העדפות לשעות ולעצירות (לא חובה) |
| form.prefs.helper | ההעדפות האלה משפיעות רק על ההמלצה ‘מתאים לשעות שלי’. |
| form.advanced | מתקדם |
| form.nearby | כלול שדות תעופה קרובים |
| form.submit | חפשו את המחיר הזול ביותר |
| tag.cheapest / best_value / my_times | 💰 הכי זול / ⚖️ התמורה הטובה ביותר / 🎯 מתאים לשעות שלי |
| card.book | להזמנה |
| card.book.out / ret | הזמנת הלוך / הזמנת חזור |
| card.affiliate | קישור שותפים — ייתכן שנקבל עמלה ללא עלות נוספת עבורך |
| card.age.now / hours | נבדק עכשיו / נבדק לפני {n} שעות |
| card.savings | חסכת ₪{n} לעומת הלוך-חזור |
| card.context | לפני שבוע: ₪{a} \| הכי נמוך שראינו: ₪{b} |
| card.time.unknown | שעת המראה: תופיע באתר ההזמנה |
| card.stops.unknown | עצירות: לא ידוע |
| card.stops.direct / one / many | ישירה / עצירה אחת / {n} עצירות |
| card.atleast | לפחות |
| note.value.insufficient | אין מספיק נתונים על עצירות וזמני טיסה כדי לדרג תמורה. |
| note.times.none | לא מצאנו הצעה בשעות שביקשת. |
| note.times.unverified | לא הצלחנו לאמת שעות ל‑{n} הצעות. |
| footer.disclaimer | המחיר הסופי מוצג באתר ההזמנה. ייתכנו עמלות המרת מטבע בכרטיס האשראי. |
| state.loading.0 | בודקים מחירים בכל צירופי התאריכים… |
| state.loading.3 | עדיין בודקים — זה יכול לקחת כמה שניות |
| state.loading.10 | המקורות איטיים היום, ממשיכים לנסות |
| state.empty.title | לא נמצאו מחירים לטווח הזה |
| state.empty.tips | הרחיבו את טווח התאריכים · הוסיפו לילות · כללו שדות תעופה קרובים · נסו יעד אחר |
| state.unavailable | לא הצלחנו לבדוק מחירים כרגע. נסו שוב בעוד כמה דקות. |
| state.rate | ביצעתם הרבה חיפושים. אפשר לנסות שוב בעוד {n} שניות. |
| state.partial | אחד ממקורות המחירים לא זמין כרגע; ייתכנו הצעות זולות יותר שלא הוצגו. |
| state.offline | אין חיבור לאינטרנט |
| state.generic | משהו השתבש. נסו שוב. |
| link.unavailable | קישור ההזמנה אינו זמין כרגע |
