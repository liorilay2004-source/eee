"""Recommendation logic (SPEC §8). All comparisons in ILS on total price incl. selected extras."""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import SCORING
from .models import Leg, Offer, SearchRequest

CHEAPEST = "cheapest"
BEST_VALUE = "best_value"
MY_TIMES = "my_times"
MOST_CONVENIENT = "most_convenient"
TAG_BAG_UNKNOWN = "bag_fee_unknown"


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


def bag_cost_known(o: Offer, req: SearchRequest) -> bool:
    """False only when a checked bag was requested and the offer's bag fee is not fully known: its total is then
    a lower bound (fare + known leg fees) that must not rank as a real price."""
    return not req.checked_bag or TAG_BAG_UNKNOWN not in o.tags


def bag_cost_pool(offers: list[Offer], req: SearchRequest) -> tuple[list[Offer], bool]:
    """Bag-cost pool rule (WEB_APP_SPEC §5.3, AC-R7). Returns (pool, fallback); fallback = no offer has a known bag
    cost, so all of them are returned and the cheapest lower bound is shown."""
    if not req.checked_bag:
        return offers, False
    known = [o for o in offers if bag_cost_known(o, req)]
    return (known, False) if known else (offers, bool(offers))


def _value_details_known(o: Offer) -> bool:
    """Best value needs complete stops, duration, and local departure time on both legs."""
    return all(leg.stops is not None and leg.duration_min is not None and leg.duration_min > 0
               and leg.depart_hour() is not None for leg in (o.outbound, o.inbound))


def _convenience_rank(o: Offer) -> tuple[int, int] | None:
    """Only a complete round trip can win: fewer stops, then shorter total time."""
    legs = (o.outbound, o.inbound)
    if o.ticket_structure != "roundtrip" or not all(
        leg.stops is not None and leg.duration_min is not None and leg.duration_min > 0 for leg in legs
    ):
        return None
    return (sum(leg.stops for leg in legs), sum(leg.duration_min for leg in legs))


def recommend(offers: list[Offer], req: SearchRequest, cfg: dict = SCORING) -> list[Card]:
    priced = [o for o in offers if o.total_ils is not None]
    if not priced:
        return []

    picks: list[tuple[str, Offer]] = []
    cheapest = min(bag_cost_pool(priced, req)[0], key=lambda o: o.total_ils)
    picks.append((CHEAPEST, cheapest))

    # Incomplete/price-only rows must not change the duration reference or rank as zero stops/time.
    detail_pool = [o for o in priced if _value_details_known(o)]
    fastest = fastest_by_direction(detail_pool)
    value_pool = [o for o in detail_pool if bag_cost_known(o, req)]
    if value_pool:
        best = min(value_pool, key=lambda o: (value_score(o, fastest, cfg), o.total_ils))
        picks.append((BEST_VALUE, best))

    # Comfort uses only itinerary facts. Unknown bag fees do not exclude a trip, and a partial bag
    # total must never decide which one is called more convenient.
    convenience_pool = [(o, _convenience_rank(o)) for o in priced]
    convenience_pool = [(o, rank) for o, rank in convenience_pool if rank is not None]
    if convenience_pool:
        best = min(convenience_pool, key=lambda item: item[1])
        picks.append((MOST_CONVENIENT, best[0]))

    if req.has_time_prefs:  # hidden otherwise (would duplicate Cheapest)
        matching = [o for o in priced if matches_times(o, req)]
        if matching:
            picks.append((MY_TIMES, min(bag_cost_pool(matching, req)[0], key=lambda o: o.total_ils)))

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
        # A split with an unknown bag fee only has a lower-bound total: no savings claim.
        if not bag_cost_known(c.offer, req):
            continue
        if c.offer.ticket_structure == "split" and rts and c.offer.total_ils < min(rts):
            c.savings_vs_roundtrip_ils = min(rts) - c.offer.total_ils
    return cards


def recommendations_meta(offers: list[Offer], req: SearchRequest, cards: list[Card]) -> dict:
    """Mirror of the Worker's recommendationsMeta (bag-cost part of meta.recommendations)."""
    priced = [o for o in offers if o.total_ils is not None]
    if not priced:
        return {"cheapest": {"status": "no_offers", "excludedForUnknownBagFee": 0}, "bestValue": {"status": "no_offers"}}
    cheapest_card = next((c for c in cards if CHEAPEST in c.kinds), None)
    shown = cheapest_card.offer.total_ils if cheapest_card else None
    _, fallback = bag_cost_pool(priced, req)
    excluded = 0
    if req.checked_bag and not fallback and shown is not None:
        excluded = sum(1 for o in priced if not bag_cost_known(o, req) and o.total_ils < shown)
    best_card = next((c for c in cards if BEST_VALUE in c.kinds), None)
    status = ("flight_details_unknown" if any(bag_cost_known(o, req) for o in priced) else "bag_cost_unknown") \
        if best_card is None else ("merged" if CHEAPEST in best_card.kinds else "shown")
    return {"cheapest": {"status": "shown", "excludedForUnknownBagFee": excluded}, "bestValue": {"status": status}}
