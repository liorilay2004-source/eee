# travel-price-engine

**Owner, start here:** [docs/OWNER_START.md](docs/OWNER_START.md), a short Hebrew checklist of what to do now, in order.

> Working name. The brand lives in [`config/project.json`](config/project.json), and only there.

A free Hebrew (RTL) web app that finds the cheapest real round-trip price across a flexible date window, gives three recommendations (💰 cheapest, ⚖️ best value, 🎯 matches my times) and watches for price drops. The full spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Status: preview is live

| Phase | Status |
|---|---|
| 0: Proof (Python in GitHub Actions: Travelpayouts + fast-flights → 3 recommendations → email) | ✅ built · ⏳ waiting on the Travelpayouts token |
| 1: Engine (D1, Worker API) | ✅ deployed · live search awaits Travelpayouts token |
| 2: Web app (PWA) | ✅ deployed as a preview |
| 3: Watches & alerts | not started |
| 4: Growth | not started |

**Preview:** [https://eee-web-bly.pages.dev](https://eee-web-bly.pages.dev)\
**API health:** [https://eee-api.liorilay2004.workers.dev/api/health](https://eee-api.liorilay2004.workers.dev/api/health)

The preview supports a clearly labeled demonstration mode. Live prices are unavailable until `TRAVELPAYOUTS_TOKEN` is added as a Cloudflare Worker secret. The privacy, terms, affiliate, and accessibility pages are draft copy and need review before a public launch.

## תוסף לדפדפן: מחיר זול בזמן חיפוש בגוגל

תוסף ל־Chrome,‏ Edge ו־Brave: כשמחפשים טיסה בגוגל או ב־Google Flights, מופיע בפינת המסך המחיר הזול ביותר שמצאנו לאותו מסלול וחודש, עם קישור להזמנה ולאתר. התוסף קורא רק את מה שהקלדתם (לא את תוכן הדף ולא את המחירים של גוגל), ושולח לשרת שלנו רק מוצא, יעד וחודש. הוא לא פורסם בחנות (Chrome Web Store גובה 5 דולר), ומתקינים אותו ידנית ב„מצב מפתח”. הוראות התקנה, פרטיות ומגבלות: [extension/README.md](extension/README.md).

## Run Phase 0 (no local computer needed)

GitHub → **Actions** → **Phase 0 - price proof** → **Run workflow**. You can do this from the GitHub mobile app too.
The results appear in the run's **Summary** (Hebrew, RTL) and as a downloadable `phase0-result` artifact (JSON with every offer). They're also emailed to you once Resend is set up.

### One-time setup (by the owner, in GitHub, never in chat)

Settings → Secrets and variables → Actions:

| Kind | Name | What |
|---|---|---|
| Secret | `TRAVELPAYOUTS_TOKEN` | Travelpayouts API token (Profile → API token) |
| Secret | `TRAVELPAYOUTS_MARKER` | Your affiliate marker (a number), added to booking links |
| Secret | `RESEND_API_KEY` | resend.com → API Keys (free tier) |
| Secret | `OWNER_EMAIL` | Where Phase 0 results go. With the default sender this must be the email you signed up to Resend with |
| Variable (optional) | `EMAIL_FROM` | Sender address after you verify a domain in Resend. Default: `onboarding@resend.dev` |
| Variable (optional) | `ENABLE_FAST_FLIGHTS` | `false` turns Google Flights enrichment off. Default: on |

Every secret is optional: a missing source is reported as "off" and the run continues with whatever is available.

## Layout

```
config/                 project name, scoring penalties (SPEC §8), bag-fee seed table
engine/                 Python engine (Phase 0 now, the background monitor in Phase 3)
  phase0.py             CLI entry point
  tpe/sources/          travelpayouts.py (core) · google_flights.py (enrichment, feature flag)
  tpe/pipeline.py       SPEC §7 steps: wide scan → top 5 → deep search → split tickets → extras/FX
  tpe/scoring.py        SPEC §8 recommendations
  tpe/fx.py             Bank of Israel rates, open.er-api fallback
  tpe/report.py         Hebrew text / Markdown / HTML email
  tests/                offline tests for the SPEC §16 acceptance criteria
.github/workflows/      ci.yml (tests on every push) · phase0-proof.yml (manual run)
web/                    React/Vite Hebrew RTL PWA (Cloudflare Pages)
extension/              browser extension (Chromium MV3, no build step): cheapest known fare while searching on Google
```

Run the tests locally (optional): `pip install -r engine/requirements.txt && python -m pytest -q engine/tests`

## Phase 0 findings so far

Measured 2026-09-29 from a cloud IP, TLV⇄BCN, 10–25/11, 5–7 nights:

- **fast-flights 3.1.0 (Google Flights)** works for TLV routes from a datacenter IP: 15 sequential calls with 2–5s jitter, no blocking, 31 offers. The cheapest was ≈ ₪968 ($315) round trip on OS.
- **Travelpayouts** is reachable (it answers 401 without a token). Coverage and freshness for TLV and ETM are **still unverified**. This is the blocking open question in SPEC §17, and it needs your token.
- **Bank of Israel FX:** `https://boi.org.il/PublicApi/GetExchangeRates` works. Some currencies are quoted per `unit` (JPY per 100), and the code handles that.

Known limitations (documented, not hidden):

1. fast-flights 3.x has **no price-calendar endpoint**, so the spec's "1 calendar call" is replaced by Travelpayouts' wide scan. Without a token, Phase 0 samples 5 date pairs evenly across the window.
2. Google round-trip results only describe the **outbound** leg; the return leg's times appear on a second page. Those cards say "the time will appear on the booking site". Best Value estimates the return leg's stops and duration from the outbound leg. 🎯 never claims a match it can't verify.
3. Travelpayouts prices are per adult. For more than one passenger the engine multiplies them, which is an approximation.
4. `config/bag_fees.json` holds **placeholder** low-cost bag fees. The owner has to verify them (SPEC §17). Airlines that aren't in the table get "⚠️ bag fee unknown" instead of a guessed fee.
5. When a checked bag is selected, Google is asked to include bag fees in its price. Whether it actually does for every carrier is still to be verified manually.
