"""Phase 0 proof (SPEC §15): run one search on both sources, print 3 recommendations, email the owner.

Usage:
    python engine/phase0.py --origin TLV --destination BCN \
        --window-start 2026-11-10 --window-end 2026-11-25 --stay-min 5 --stay-max 7
Every flag also accepts an empty string (GitHub Actions inputs) meaning "use the default".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tpe import emailer, report  # noqa: E402
from tpe.config import enable_fast_flights  # noqa: E402
from tpe.fx import FxRates  # noqa: E402
from tpe.models import SearchRequest  # noqa: E402
from tpe.pipeline import run_search  # noqa: E402
from tpe.sources.google_flights import GoogleFlights  # noqa: E402
from tpe.sources.travelpayouts import Travelpayouts  # noqa: E402


def parse_hours(s: str | None) -> tuple[int, int] | None:
    if not s or not s.strip():
        return None
    a, b = s.replace(" ", "").split("-")
    start, end = int(a), int(b)
    if not (0 <= start <= 24 and 0 <= end <= 24):
        raise ValueError(f"bad hour window: {s}")
    return (start, end)


def parse_args(argv=None) -> SearchRequest:
    p = argparse.ArgumentParser()
    for name in ["origin", "destination", "window-start", "window-end", "stay-min", "stay-max",
                 "adults", "out-hours", "ret-hours", "max-stops", "checked-bag", "nearby"]:
        p.add_argument(f"--{name}", default="")
    a = p.parse_args(argv)

    def v(x, default):
        return x.strip() if x and x.strip() else default

    start = date.fromisoformat(v(a.window_start, (date.today() + timedelta(days=40)).isoformat()))
    end = date.fromisoformat(v(a.window_end, (start + timedelta(days=15)).isoformat()))
    req = SearchRequest(
        origin=v(a.origin, "TLV").upper(),
        destination=v(a.destination, "BCN").upper(),
        window_start=start,
        window_end=end,
        stay_min=int(v(a.stay_min, "5")),
        stay_max=int(v(a.stay_max, "7")),
        adults=int(v(a.adults, "1")),
        out_hours=parse_hours(a.out_hours),
        ret_hours=parse_hours(a.ret_hours),
        max_stops=int(a.max_stops) if v(a.max_stops, "") else None,
        checked_bag=v(a.checked_bag, "false").lower() in ("1", "true", "yes"),
        nearby_airports=v(a.nearby, "false").lower() in ("1", "true", "yes"),
    )
    if req.stay_min > req.stay_max or not req.valid_pairs():
        p.error("date window / stay length combination has no valid date pairs")
    return req


def main(argv=None) -> int:
    req = parse_args(argv)
    fx = FxRates.fetch()
    tp = Travelpayouts()
    gf = GoogleFlights() if enable_fast_flights() else None

    result = run_search(req, tp, gf, fx)

    text = report.to_text(result, fx)
    print(text)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(report.to_markdown(result, fx))

    out = Path(os.environ.get("OUT_DIR", "out"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps({
        "request": {k: str(v) for k, v in vars(req).items()},
        "fx": {"source": fx.source, "USD": fx.rates.get("USD"), "EUR": fx.rates.get("EUR")},
        "sources": [vars(s) for s in result.sources],
        "cards": [{"kinds": c.kinds, "savings_vs_roundtrip_ils": c.savings_vs_roundtrip_ils,
                   "offer": c.offer.to_json()} for c in result.cards],
        "comparison": [{k: str(v) for k, v in vars(p).items()} for p in result.comparison],
        "offers": [o.to_json() for o in sorted(result.offers, key=lambda o: o.total_ils or 1e12)],
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    mailer, to = emailer.from_env()
    if mailer and to:
        try:
            best = result.cards[0].offer if result.cards else None
            subject = f"✈️ {report.title(result)}" + (f" · מ-{report.ils(best.total_ils)}" if best else "")
            mid = mailer.send(to, subject, report.to_html(result, fx), text)
            print(f"\nemail sent (id {mid})")
        except Exception as e:
            print(f"\n::warning::email failed: {e}")
    else:
        print("\nemail skipped: RESEND_API_KEY / OWNER_EMAIL not configured")

    if not any(s.ok for s in result.sources):
        print("::error::no data source returned data")
        return 1
    for s in result.sources:
        if s.enabled and not s.ok:
            print(f"::warning::source {s.name} failed: {s.error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
