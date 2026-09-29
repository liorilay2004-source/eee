"""Hebrew (RTL) rendering of results: plain text, Markdown (Actions summary) and HTML email."""

from __future__ import annotations

import html
import math
from datetime import datetime, timezone

from .config import CITY_HE, CURRENCY_SYMBOL, PROJECT
from .fx import FxRates
from .models import Leg, Offer
from .pipeline import TAG_BAG_UNKNOWN, TAG_BONUS_BAG, SearchResult
from .scoring import BEST_VALUE, CHEAPEST, MY_TIMES, Card

KIND_LABEL = {CHEAPEST: "💰 הכי זול", BEST_VALUE: "⚖️ הכי משתלם", MY_TIMES: "🎯 מתאים לשעות שלי"}
SOURCE_LABEL = {"travelpayouts": "Travelpayouts", "google_flights": "Google Flights"}
STRUCTURE_LABEL = {"roundtrip": "כרטיס הלוך-חזור", "split": "שני כרטיסים נפרדים"}
DISCLAIMER = "המחיר הסופי מוצג באתר ההזמנה. ייתכנו עמלות המרת מטבע בכרטיס האשראי."


def city(code: str) -> str:
    return CITY_HE.get(code, code)


def ils(amount: float) -> str:
    return f"₪{math.ceil(amount):,}"


def money(o: Offer, fx: FxRates) -> str:
    """`≈ ₪606 ($164)` - ILS first, original currency in parentheses (SPEC §4.2)."""
    total = o.total_ils if o.total_ils is not None else fx.to_ils(o.price_amount, o.price_currency)
    if o.price_currency == "ILS" and not o.extras_amount_ils:
        return ils(total)
    sym = CURRENCY_SYMBOL.get(o.price_currency, o.price_currency + " ")
    s = f"≈ {ils(total)} ({sym}{math.ceil(o.price_amount):,}"
    if o.extras_amount_ils:
        s += f" + מזוודות {ils(o.extras_amount_ils)}"
    return s + ")"


def stops_he(n: int | None) -> str:
    if n is None:
        return "עצירות: לא ידוע"
    return {0: "ישירה", 1: "עצירה אחת"}.get(n, f"{n} עצירות")


def duration_he(m: int | None) -> str:
    return f"{m // 60}ש׳ {m % 60:02d}ד׳" if m else ""


def leg_he(label: str, leg: Leg, d) -> str:
    parts = [f"{label} {d:%d/%m}"]
    if leg.depart_time:
        parts.append(f"המראה {leg.depart_time}")
    else:
        parts.append("שעה: תופיע באתר ההזמנה")
    if leg.stops is not None:
        parts.append(stops_he(leg.stops))
    if leg.duration_min:
        parts.append(duration_he(leg.duration_min))
    if leg.airlines:
        parts.append(", ".join(leg.airlines))
    return " · ".join(parts)


def age_he(o: Offer, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    h = int((now - o.checked_at).total_seconds() // 3600)
    return "נבדק עכשיו" if h < 1 else f"נבדק לפני {h} שעות"


def card_lines(c: Card, fx: FxRates) -> list[str]:
    o = c.offer
    lines = [
        " | ".join(KIND_LABEL[k] for k in c.kinds),
        f"{money(o, fx)} · {o.nights} לילות · {STRUCTURE_LABEL[o.ticket_structure]} · מקור: {SOURCE_LABEL.get(o.source, o.source)}",
        leg_he("הלוך", o.outbound, o.depart_date),
        leg_he("חזור", o.inbound, o.return_date),
    ]
    tags = []
    if TAG_BONUS_BAG in o.tags:
        tags.append("🎁 כולל מזוודה")
    if TAG_BAG_UNKNOWN in o.tags:
        tags.append("⚠️ מחיר המזוודה לא ידוע - לבדוק באתר")
    if c.savings_vs_roundtrip_ils:
        tags.append(f"חסכת {ils(c.savings_vs_roundtrip_ils)} לעומת הלוך-חזור")
    if tags:
        lines.append(" · ".join(tags))
    lines.append(age_he(o))
    return lines


def _cell(v: float | None) -> str:
    return ils(v) if v is not None else "—"


def title(r: SearchResult) -> str:
    q = r.request
    return (f"{city(q.origin)} ⇄ {city(q.destination)} · {q.window_start:%d/%m}–{q.window_end:%d/%m} · "
            f"{q.stay_min}–{q.stay_max} לילות")


def to_text(r: SearchResult, fx: FxRates) -> str:
    out = [f"[{PROJECT['display_name_he']}] {title(r)}", ""]
    if not r.cards:
        out.append("לא נמצאו מחירים לחיפוש הזה.")
    for c in r.cards:
        out += card_lines(c, fx)
        if c.offer.deeplink:
            out.append(f"להזמנה: {c.offer.deeplink}")
        if c.offer.verify_link:
            out.append(f"לבדיקה ב-Google Flights: {c.offer.verify_link}")
        out.append("")
    out.append("השוואת מקורות לתאריכים המובילים (₪, כולל תוספות):")
    out.append("תאריכים | TP הלוך-חזור | TP מפוצל | Google הלוך-חזור | Google מפוצל")
    for p in r.comparison:
        out.append(f"{p.depart:%d/%m}–{p.ret:%d/%m} | {_cell(p.tp_roundtrip_ils)} | {_cell(p.tp_split_ils)} | "
                   f"{_cell(p.gf_roundtrip_ils)} | {_cell(p.gf_split_ils)}")
    out.append("")
    out.append("מצב מקורות:")
    for s in r.sources:
        state = "✅" if s.ok else ("⛔ כבוי" if not s.enabled else "❌")
        out.append(f"{state} {s.name}: {s.calls} קריאות, {s.offers} הצעות" + (f" · {s.error}" if s.error else ""))
    out.append(f"שערי מטבע: {fx.source} (USD={fx.rates.get('USD', 0):.3f}) · מועמדים: {r.candidates_from}")
    out.append("")
    out.append(DISCLAIMER)
    return "\n".join(out)


def to_markdown(r: SearchResult, fx: FxRates) -> str:
    md = [f'<div dir="rtl">\n\n## {title(r)}\n']
    for c in r.cards:
        lines = card_lines(c, fx)
        md.append(f"### {lines[0]}")
        md += [f"- {line}" for line in lines[1:]]
        if c.offer.deeplink:
            md.append(f"- [להזמנה]({c.offer.deeplink})")
        if c.offer.verify_link:
            md.append(f"- [לבדיקה ב-Google Flights]({c.offer.verify_link})")
        md.append("")
    if not r.cards:
        md.append("לא נמצאו מחירים לחיפוש הזה.\n")
    md.append("### השוואת מקורות\n")
    md.append("| תאריכים | TP הלוך-חזור | TP מפוצל | Google הלוך-חזור | Google מפוצל |")
    md.append("|---|---|---|---|---|")
    for p in r.comparison:
        md.append(f"| {p.depart:%d/%m}–{p.ret:%d/%m} | {_cell(p.tp_roundtrip_ils)} | {_cell(p.tp_split_ils)} | "
                  f"{_cell(p.gf_roundtrip_ils)} | {_cell(p.gf_split_ils)} |")
    md.append("\n### מצב מקורות\n")
    for s in r.sources:
        state = "✅" if s.ok else ("⛔" if not s.enabled else "❌")
        md.append(f"- {state} `{s.name}`: {s.calls} קריאות, {s.offers} הצעות" + (f" — {s.error}" if s.error else ""))
    md.append(f"- שערי מטבע: `{fx.source}` · מועמדים: `{r.candidates_from}`")
    md.append(f"\n_{DISCLAIMER}_\n\n</div>")
    return "\n".join(md)


def to_html(r: SearchResult, fx: FxRates) -> str:
    e = html.escape
    parts = [
        '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;text-align:right">',
        f"<h2>{e(title(r))}</h2>",
    ]
    if not r.cards:
        parts.append("<p>לא נמצאו מחירים לחיפוש הזה.</p>")
    for c in r.cards:
        lines = card_lines(c, fx)
        parts.append('<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">')
        parts.append(f"<h3 style='margin:0 0 6px'>{e(lines[0])}</h3>")
        parts += [f"<div>{e(x)}</div>" for x in lines[1:]]
        if c.offer.deeplink:
            parts.append(f'<p><a href="{e(c.offer.deeplink)}" style="background:#0a66c2;color:#fff;'
                         'padding:8px 14px;border-radius:6px;text-decoration:none">להזמנה</a></p>')
        if c.offer.verify_link:
            parts.append(f'<div><a href="{e(c.offer.verify_link)}">לבדיקה ב-Google Flights</a></div>')
        parts.append("</div>")
    parts.append("<pre style='direction:rtl;white-space:pre-wrap;font-size:12px;color:#555'>")
    txt = to_text(r, fx)
    parts.append(e(txt[txt.index("השוואת מקורות"):]))
    parts.append("</pre></div>")
    return "\n".join(parts)
