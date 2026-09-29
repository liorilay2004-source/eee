# SPEC — Travel Price Engine (working name: `travel-price-engine`)

> Implementation spec for Claude Code. Read fully before writing code.
> The product UI is **Hebrew only (RTL)**. All code, comments, and this spec are in English.
> Working name is a placeholder — the final brand/domain is not decided yet. Keep the name in one config constant.

---

## 1. Problem & Product Summary

Hebrew-speaking travelers anywhere in the world waste time and money searching flights manually: one source, one date pair, one round-trip ticket. They miss cheaper options on adjacent dates, cheaper split tickets (two one-ways), and price drops after they searched.

The product is a **free public web app (PWA, no install)** that:

1. Finds the **cheapest real price** for a round trip within a flexible date window and stay length.
2. Returns **three recommendations**: 💰 Cheapest, ⚖️ Best Value, 🎯 Matches My Times.
3. Lets users **save a search as a watch** and get alerted (email + in-app banner) when the price drops.
4. Supports **spontaneous search with no destination** ("budget ₪1,500, 5 nights, where is cheapest?").
5. Builds a **shared price database** from every search, so each search makes the next one faster and cheaper.
6. Monetizes via **affiliate booking links** (flights and hotels).

---

## 2. Goals

- G1. For a round-trip request with a date window, return the cheapest option found across all date combinations, sources, and ticket structures.
- G2. First results appear on screen in **< 4 seconds** (from cache or fast source).
- G3. Operating cost **≈ $0/month** at launch scale (free tiers only).
- G4. A saved watch is re-checked automatically and alerts the user when a threshold is crossed, **without the owner's personal computer being on**.
- G5. Every result has a working affiliate booking link.

## 3. Non-Goals (v1)

- No ticketing / booking / payments inside the app (we link out).
- No paid data APIs in v1.
- No hotel price data in v1 — hotels are **affiliate deep links only** (the Hotellook API that Travelpayouts offered was shut down in Oct 2025; no free stable hotel price source exists).
- No browser extension, no background scraping from users' devices.
- No languages other than Hebrew.
- No one-way trip search in v1 (round trip only; one-way legs are used internally for split-ticket checks).

---

## 4. Core Rules (decided — do not change without approval)

### 4.1 Unspecified input semantics
| Field type | If user did NOT fill it | Examples |
|---|---|---|
| **Paid extras** | = user does NOT want it (not added to price) | checked bag, seat selection, meals |
| **Filters** | = no restriction (everything allowed) | departure/arrival hours, max stops, airlines |
| **Basics** | = default value | passengers: 1 adult · cabin: economy · display currency: ILS |

- If an offer **includes** an extra the user did not request (e.g., fare includes a checked bag), that is fine — show it as a 🎁 bonus tag. Never penalize it.
- If the user **did** select an extra (e.g., 23kg bag), compare **total price including that extra** across offers.

### 4.2 Currency
- Sources may return any currency. **Store the original amount + original currency** in the DB. Never overwrite it.
- Convert to **ILS at display/comparison time** using a daily official rate.
- Display format: `≈ ₪606 ($164)` — ILS first, original in parentheses.
- Price history comparisons ("lowest we've seen") use the **original currency**, so FX moves don't look like price changes.
- FX source: Bank of Israel official representative rates (verify the current public endpoint during implementation); fallback to one free FX API. Cache rates for 24h.

### 4.3 Origins & language
- Users can depart from **any airport worldwide**.
- UI is Hebrew only, RTL, mobile-first.
- City/airport input accepts Hebrew or English. Maintain a lookup table with **Hebrew names for ~500 most popular cities**; English/IATA fallback for all others.

---

## 5. User Inputs

| Input | Required | Default |
|---|---|---|
| Origin (city/airport) | yes | — |
| Destination (city/airport) | no | empty → **spontaneous mode** |
| Date window: earliest departure, latest return | yes | — |
| Stay length: min–max nights | yes | — |
| Passengers (adults/children/infants) | no | 1 adult |
| Cabin | no | economy |
| Checked bag / carry-on trolley | no | none |
| Preferred outbound departure hours | no | no restriction |
| Preferred return departure hours | no | no restriction |
| Max stops | no | no restriction |
| Include nearby airports | no | off |
| Budget (spontaneous mode) | only in spontaneous mode | — |
| Watch: alert threshold (price or % drop) | no | alert on ≥10% drop |

---

## 6. Architecture

```
 User (mobile/desktop browser, PWA, Hebrew RTL)
        │
        ▼
 Cloudflare Pages ── React + Vite + TypeScript + Tailwind (RTL)
        │
        ▼
 Cloudflare Worker ── REST API, cache logic, scoring, affiliate links
        │
        ├──► Cloudflare D1 ── prices, searches, watches, users, fx_rates, airports
        ├──► Travelpayouts / Aviasales Data API (live search, fast, free)
        └──► Email provider (free tier, behind an interface)

 GitHub Actions (scheduled, every 6h) ── Python worker
        ├──► fast-flights (Google Flights, unofficial) — deep search
        ├──► Travelpayouts (refresh)
        └──► writes results to D1 via Worker admin endpoint (auth by secret)
```

### Two modes
| | 🔍 Live search | ⏰ Background monitor |
|---|---|---|
| Trigger | user presses search | cron every 6h |
| Latency budget | seconds | minutes |
| Primary engine | Travelpayouts + D1 cache | fast-flights + Travelpayouts |
| Runs on | Cloudflare Worker | GitHub Actions (Python) |
| Split-ticket check | no (uses cached if exists) | yes |

**Why:** Travelpayouts is plain HTTP → runs in the Worker instantly. fast-flights is Python, slower, and may be rate-limited/blocked by Google → run only in the background at a controlled rate, never on the user's critical path.

### Source reliability rule
- **Travelpayouts is the core engine.** The product must work fully if fast-flights is disabled.
- fast-flights is an **enrichment layer behind a feature flag** (`ENABLE_FAST_FLIGHTS`). If it errors/blocks, log it, alert the owner, and continue with Travelpayouts only.

---

## 7. The Search Pipeline (9 steps)

Example: TLV⇄BCN, window 10–25 Nov, stay 5–7 nights, 1 adult, no bag.

1. **Normalize input** (Worker) — resolve city → IATA codes (+ nearby airports if enabled). Apply defaults per §4.1.
2. **Cache check** (D1) — if a result for the same route + window + stay range exists and is < 6h old → return immediately.
3. **Wide scan** (Travelpayouts) — request whole months (e.g., `departure_at=YYYY-MM`, `return_at=YYYY-MM`), get many date pairs in 1–2 calls, filter to pairs matching stay length. Pass `market` based on origin country. Result: all date combinations with estimated price.
4. **Narrow** — keep the Top 5 cheapest combinations.
5. **Deep search** (background only, fast-flights):
   - 1 call: round-trip price calendar/grid for the window.
   - 5 calls: full round-trip itineraries for Top 5 (times, stops, airlines, duration).
   - 10 calls: each direction as a separate one-way (split-ticket check).
6. **Merge** — per date combination, take the lowest price across sources and ticket structures. Keep provenance (`source`, `ticket_structure: roundtrip|split`).
7. **Extras + FX** — add selected extras (bag fees from `bag_fees` table) and convert to ILS for comparison.
8. **Score & rank** — produce the 3 recommendations (§8).
9. **Persist & alert** — write to D1 (shared cache). If this belongs to a watch and threshold is crossed → email + set in-app banner flag.

### Cheapest-price guarantees (the 4 layers)
| Layer | Catches |
|---|---|
| All date pairs in window | ±1 day can save hundreds of ₪ |
| Two sources compared | each source knows different fares |
| Split tickets vs round trip | e.g., low-cost out + different airline back |
| Nearby airports (opt-in) | e.g., GRO/REU vs BCN |

---

## 8. Recommendation Logic

All comparisons in ILS, using total price = base fare + user-selected extras.

### 💰 Cheapest
Lowest total price. No other conditions.

### ⚖️ Best Value
Lowest **score**, where:
```
score = total_price_ils
      + night_departure_penalty   (each leg departing 00:00–05:59 → +₪150)
      + stop_penalty              (each stop, per leg → +₪180)
      + duration_penalty          (each hour above fastest option on that route, per leg → +₪35)
```
Penalty values live in a config file (`scoring.config.ts`), not hard-coded.

### 🎯 Matches My Times
Filter to offers whose outbound and return departures fall inside the user's preferred hour windows (and max stops, if set). Pick the cheapest. If user set no hours → hide this card (it would duplicate Cheapest).

### Display rules
- If two or three recommendations are the same offer → show it once with multiple tags.
- Every card shows: total ≈ ₪ (original currency), dates, airlines, times, stops, 🎁 bonus tags, "checked X hours ago", affiliate booking button.
- Price context line from DB: `לפני שבוע: ₪X | הכי נמוך שראינו: ₪Y` (when data exists).
- Disclaimer: final price is shown on the booking site; card FX fees may apply.

---

## 9. Spontaneous Mode (no destination)

Input: origin, window, stay length, budget.
1. Travelpayouts "cheapest destinations from origin" style query for the window.
2. Filter by stay length and budget (including selected extras).
3. Return a ranked list of destinations: city (Hebrew name), price ≈ ₪, dates.
4. Each row → click opens a full search for that destination.

Also used for the **home page**: "לאן הכי זול לטוס מ-[origin] החודש".

---

## 10. Watches & Alerts

- Logged-in user can save any search as a watch.
- Limit: **5 active watches per user** (config). Watches expire automatically after the latest return date passes.
- **Dedup:** identical (route, window, stay, pax, cabin) watches across users share one check.
- **Check frequency by distance to departure:** > 60 days → once/day · 21–60 days → every 12h · < 21 days → every 6h.
- Alert triggers: total ≤ user threshold price, OR drop ≥ X% vs last check (default 10%).
- Alert channels:
  - **Email**: route, new price, % change, 3 recommendations summary, booking link, unsubscribe link.
  - **In-app banner** on next visit: `🔔 N דרישות שלך ירדו במחיר!`
- No duplicate alerts for the same price level within 24h.

---

## 11. Accounts

- Passwordless **magic link by email**. No passwords.
- Search works without login; saving a watch requires login.
- Store only: email, created_at, marketing consent flag, watches.

---

## 12. Data Model (D1)

```sql
airports(iata PK, city_iata, name_en, city_en, city_he, country_code, lat, lon, popularity)
fx_rates(date, currency, rate_to_ils, source, PRIMARY KEY(date, currency))
bag_fees(airline_iata, bag_type, price_amount, price_currency, updated_at, note)

searches(id PK, origin, destination NULL, window_start, window_end, stay_min, stay_max,
         pax_json, cabin, extras_json, filters_json, created_at, user_id NULL)

prices(id PK, origin, destination, depart_date, return_date,
       price_amount, price_currency, source, ticket_structure,   -- roundtrip|split
       airlines_json, legs_json,    -- times, stops, duration per leg
       includes_json,               -- e.g. {"checked_bag":true}
       deeplink, checked_at)
-- index on (origin, destination, depart_date, return_date, checked_at)

users(id PK, email UNIQUE, marketing_consent, created_at)
watches(id PK, user_id, search_key, threshold_ils NULL, drop_pct, active, expires_at,
        last_price_amount, last_price_currency, last_alert_at)
alerts(id PK, watch_id, price_amount, price_currency, sent_email, seen_in_app, created_at)
source_health(source, last_ok_at, last_error_at, last_error, consecutive_failures)
```

`search_key` = stable hash of (origin, destination, window, stay range, pax, cabin) — used for dedup.

---

## 13. Hotels (v1 = links only)

- On every flight result: button "מלונות ב-[city] לתאריכים האלה" → affiliate deep link to a hotel booking site with check-in/check-out pre-filled from the chosen flight.
- No hotel prices stored or displayed in v1.
- P2: paid hotel price source (e.g., Google Hotels via a paid SERP API) used only for packages the user explicitly requests, cached.

---

## 14. Non-Functional & Safety

- **Never commit secrets.** All tokens (Travelpayouts token + marker, email API key, admin secret) in Cloudflare/GitHub secrets. `.env` in `.gitignore`.
- **Rate control for fast-flights:** max concurrency 1, jitter 2–5s between calls, stop the run after 3 consecutive failures, mark `source_health`.
- **Source health:** if any source fails 3 runs in a row → email the owner.
- Rate-limit public API per IP (e.g., 30 searches/10 min).
- Hebrew RTL throughout; dates shown `DD/MM`; prices with `₪`.
- Mobile-first; Lighthouse PWA installable.
- Legal pages (Hebrew): privacy policy, terms of use, **affiliate disclosure**. Marketing emails only with explicit consent + one-click unsubscribe (Israeli anti-spam law).

---

## 15. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0 — Proof (day 1)** | One Python script in GitHub Actions: TLV⇄BCN, window + stay range → Travelpayouts + fast-flights → prints 3 recommendations, sends to owner by email | Both sources return data for TLV routes; recommendations look correct vs manual Google Flights check |
| **1 — Engine** | D1 schema, Worker API, pipeline §7, scoring §8, FX, airports table (Hebrew top-500) | `/api/search` returns 3 recommendations from cache or Travelpayouts |
| **2 — Web app** | Hebrew RTL PWA: search form, results cards, spontaneous mode, home deals | Usable end-to-end on iPhone and Android |
| **3 — Watches** | Magic-link login, watches, GitHub Actions monitor, email + banner alerts | A watch alerts correctly after a simulated price drop |
| **4 — Growth** | Hotel links, legal pages, analytics (searches → clicks), deal definition (e.g., ≥20% below route 60-day median) | Public launch |

**Start with Phase 0.** Do not build the UI before Phase 0 proves the data sources work for Israeli routes.

---

## 16. Acceptance Criteria (key)

- [ ] Given no bag selected, when offers include a bag, then they are ranked on base price and tagged 🎁.
- [ ] Given a 23kg bag selected, then low-cost fares are ranked on fare + bag fee.
- [ ] Given no preferred hours, then the 🎯 card is hidden.
- [ ] Given a USD price, then it is displayed `≈ ₪X ($Y)` and stored in USD.
- [ ] Given the same search twice within 6h, the second returns from D1 with zero external calls.
- [ ] Given `ENABLE_FAST_FLIGHTS=false`, the whole product still works.
- [ ] Given a split ticket is cheaper than any round trip, then Cheapest shows it with "חסכת ₪X לעומת הלוך-חזור".
- [ ] Given a watch price drops ≥ threshold, then one email + one banner are produced, and no repeat within 24h.
- [ ] Given no destination, then spontaneous mode returns destinations within budget, sorted by price.
- [ ] No secret appears anywhere in the repo.

---

## 17. Open Questions

| Question | Owner | Blocking? |
|---|---|---|
| Final product name + domain | owner | no |
| Travelpayouts coverage/freshness for TLV and ETM routes | engineering (Phase 0) | **yes** |
| Which email provider (free tier) | engineering | no |
| Bag fee table: which airlines to seed first | owner + engineering | no |
| Exact "deal" definition for home page | owner | no |

---

## 18. Delivery Workflow (owner's standard — mandatory)

Follow the owner's standard project workflow, **cloud-first** (owner's computer may be off; do not require him to run git/CLI/Wrangler locally):

1. Verify GitHub and Cloudflare authentication are available via cloud/integrations **before** creating anything. If missing, stop and state exactly what is missing. Never ask for secrets in chat.
2. Create the project, init Git, create a new GitHub repo named after the project (ask about visibility if unspecified), respect `.gitignore`, never commit secrets/.env/node_modules/build artifacts.
3. Initial commit → push.
4. Configure and deploy to Cloudflare (Pages for the frontend, Workers for the API). Derive names from the project name; never overwrite an existing repo/project without explicit confirmation; keep projects isolated.
5. **Verify** the deployment actually works. Never guess or invent a URL.
6. Final output format:

```
GitHub: <repo URL>
Commit: <SHA>
Cloudflare: <deployment type / project or Worker name>
LIVE URL: <verified URL>
```
