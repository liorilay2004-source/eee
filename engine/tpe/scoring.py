"""Recommendation logic (SPEC §8). All comparisons in ILS on total price incl. selected extras."""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import SCORING
from .models import Leg, Offer, SearchRequest

CHEAPEST = "cheapest"
BEST_VALUE = "best_value"
MY_TIMES = "my_times"


def _is_night(leg: Leg, cfg: dict) -> bool:
    h = leg.depart_hour()
    return h is not None and cfg["night_start_hour"] <= h < cfg["night_end_hour"]


def fastest_by_direction(offers: list[Offer]) -> tuple[int | None, int | None]:
    outs = [o.outbound.duration_min for o in offers if o.outbound.duration_min]
    ins = [o.inbound.duration_min for o in offers if o.inbound.duration_min]
    return (min(outs) if outs else None, min(ins) if ins else None)


def _leg_penalty(leg: Leg, fastest: int | None, cfg: dict, fallback: Leg | None = None) -> float:
    """Penalty for one leg. If the leg's stops/duration are unknown (e.g. Google round-trip
    return leg), the other leg's values are used as a symmetric estimate; night penalty is
    only applied on a known departure time."""
    p = 0.0
    if _is_night(leg, cfg):
        p += cfg["night_departure_penalty_ils"]
    stops = leg.stops if leg.stops is not None else (fallback.stops if fallback else None)
    if stops:
        p += stops * cfg["stop_penalty_ils"]
    dur = leg.duration_min if leg.duration_min is not None else (fallback.duration_min if fallback else None)
    if dur and fastest:
        p += max(0.0, (dur - fastest) / 60.0) * cfg["duration_penalty_ils_per_hour"]
    return p


def value_score(o: Offer, fastest: tuple[int | None, int | None], cfg: dict = SCORING) -> float:
    assert o.total_ils is not None
    return (
        o.total_ils
        + _leg_penalty(o.outbound, fastest[0], cfg)
        + _leg_penalty(o.inbound, fastest[1], cfg, fallback=o.outbound)
    )


def in_window(leg: Leg, window: tuple[int, int] | None) -> bool:
    if window is None:
        return True
    h = leg.depart_hour()
    if h is None:
        return False  # can't verify -> don't claim it matches
    start, end = window
    return start <= h < end if start <= end else (h >= start or h < end)


def matches_times(o: Offer, req: SearchRequest) -> bool:
    if not (in_window(o.outbound, req.out_hours) and in_window(o.inbound, req.ret_hours)):
        return False
    if req.max_stops is not None:
        for leg in (o.outbound, o.inbound):
            if leg.stops is None or leg.stops > req.max_stops:
                return False
    return True


@dataclass
class Card:
    offer: Offer
    kinds: list[str] = field(default_factory=list)
    savings_vs_roundtrip_ils: float | None = None


def recommend(offers: list[Offer], req: SearchRequest, cfg: dict = SCORING) -> list[Card]:
    priced = [o for o in offers if o.total_ils is not None]
    if not priced:
        return []

    picks: list[tuple[str, Offer]] = []
    cheapest = min(priced, key=lambda o: o.total_ils)
    picks.append((CHEAPEST, cheapest))

    fastest = fastest_by_direction(priced)
    best = min(priced, key=lambda o: (value_score(o, fastest, cfg), o.total_ils))
    picks.append((BEST_VALUE, best))

    if req.has_time_prefs:  # hidden otherwise (would duplicate Cheapest)
        matching = [o for o in priced if matches_times(o, req)]
        if matching:
            picks.append((MY_TIMES, min(matching, key=lambda o: o.total_ils)))

    cards: list[Card] = []
    for kind, o in picks:
        existing = next((c for c in cards if c.offer.key() == o.key()), None)
        if existing:
            existing.kinds.append(kind)
        else:
            cards.append(Card(offer=o, kinds=[kind]))

    # Split ticket cheaper than any round trip -> show savings (SPEC §16).
    rts = [o.total_ils for o in priced if o.ticket_structure == "roundtrip"]
    for c in cards:
        if c.offer.ticket_structure == "split" and rts and c.offer.total_ils < min(rts):
            c.savings_vs_roundtrip_ils = min(rts) - c.offer.total_ils
    return cards
