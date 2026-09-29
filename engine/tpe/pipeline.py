"""Search pipeline (SPEC §7), background flavour used by Phase 0 and later the monitor."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from .config import BAG_FEES, NEARBY_AIRPORTS, SCORING
from .fx import FxRates
from .models import Leg, Offer, SearchRequest
from .scoring import TAG_BAG_UNKNOWN, Card, in_window, recommend
from .sources.google_flights import GoogleFlights
from .sources.travelpayouts import Travelpayouts, aviasales_search_link

TAG_BONUS_BAG = "bonus_checked_bag"


@dataclass
class SourceStatus:
    name: str
    enabled: bool
    ok: bool = False
    calls: int = 0
    offers: int = 0
    error: str | None = None


@dataclass
class PairComparison:
    depart: date
    ret: date
    tp_roundtrip_ils: float | None = None
    tp_split_ils: float | None = None
    gf_roundtrip_ils: float | None = None
    gf_split_ils: float | None = None


@dataclass
class SearchResult:
    request: SearchRequest
    offers: list[Offer]
    cards: list[Card]
    sources: list[SourceStatus]
    comparison: list[PairComparison] = field(default_factory=list)
    fx_source: str = ""
    candidates_from: str = ""


def _airports(code: str, nearby: bool) -> list[str]:
    return [code] + (NEARBY_AIRPORTS.get(code, []) if nearby else [])


def build_splits(
    origin: str, dest: str, req: SearchRequest,
    outs: list[tuple[date, float, str, Leg, str | None]],
    backs: list[tuple[date, float, str, Leg, str | None]],
    source: str, fx: FxRates, scale: int = 1,
) -> list[Offer]:
    """Cheapest one-way out + cheapest one-way back per valid date pair (currencies normalised via ILS).

    When the user set preferred hours, the cheapest legs inside those windows are combined too,
    so the 🎯 card can find a split ticket that isn't the overall cheapest one.
    """

    def cheapest_by_day(rows, window):
        best: dict[date, tuple] = {}
        for row in rows:
            d, price, cur, leg = row[0], row[1], row[2], row[3]
            if window is not None and not in_window(leg, window):
                continue
            if d not in best or fx.to_ils(price, cur) < fx.to_ils(best[d][1], best[d][2]):
                best[d] = row
        return best

    variants = [(cheapest_by_day(outs, None), cheapest_by_day(backs, None))]
    if req.has_time_prefs:
        variants.append((cheapest_by_day(outs, req.out_hours), cheapest_by_day(backs, req.ret_hours)))

    offers, seen = [], set()
    for o_best, b_best in variants:
        for dep, ret in req.valid_pairs():
            if dep not in o_best or ret not in b_best:
                continue
            _, po, co, lo, link_o = o_best[dep]
            _, pb, cb, lb, _ = b_best[ret]
            sig = (dep, ret, po, co, lo.depart_time, pb, cb, lb.depart_time)
            if sig in seen:
                continue
            seen.add(sig)
            if co == cb:
                amount, cur = (po + pb) * scale, co
            else:  # mixed currencies: store in ILS rather than invent a rate between them
                amount, cur = (fx.to_ils(po, co) + fx.to_ils(pb, cb)) * scale, "ILS"
            offers.append(Offer(
                origin=origin, destination=dest, depart_date=dep, return_date=ret,
                price_amount=amount, price_currency=cur, source=source, ticket_structure="split",
                outbound=lo, inbound=lb, deeplink=link_o,
            ))
    return offers


def apply_extras_and_fx(offers: list[Offer], req: SearchRequest, fx: FxRates) -> None:
    """SPEC §4.1 + §7 step 7."""
    for o in offers:
        o.tags = [t for t in o.tags if t not in (TAG_BONUS_BAG, TAG_BAG_UNKNOWN)]
        extras = 0.0
        included = bool(o.includes.get("checked_bag"))
        if req.checked_bag and not included:
            for leg in (o.outbound, o.inbound):
                carrier = leg.airlines[0] if leg.airlines else None
                fee = BAG_FEES.get(carrier or "", {}).get("checked_bag")
                if fee:
                    extras += fx.to_ils(fee["amount"], fee["currency"]) * req.pax
                elif TAG_BAG_UNKNOWN not in o.tags:
                    o.tags.append(TAG_BAG_UNKNOWN)
        elif included and not req.checked_bag:
            o.tags.append(TAG_BONUS_BAG)  # never penalised
        o.extras_amount_ils = round(extras, 2)
        o.total_ils = round(fx.to_ils(o.price_amount, o.price_currency) + extras, 2)


def _sample_pairs(pairs: list[tuple[date, date]], n: int) -> list[tuple[date, date]]:
    if len(pairs) <= n:
        return pairs
    step = (len(pairs) - 1) / (n - 1)
    return [pairs[round(i * step)] for i in range(n)]


def run_search(
    req: SearchRequest,
    tp: Travelpayouts,
    gf: GoogleFlights | None,
    fx: FxRates,
    top_n: int = SCORING["top_n_candidates"],
) -> SearchResult:
    offers: list[Offer] = []
    tp_status = SourceStatus("travelpayouts", enabled=tp.configured)
    gf_status = SourceStatus("google_flights", enabled=gf is not None)

    # Steps 1+3: wide scan on Travelpayouts (all airports if nearby enabled).
    if tp.configured:
        try:
            for o in _airports(req.origin, req.nearby_airports):
                for d in _airports(req.destination, req.nearby_airports):
                    for off in tp.round_trips(o, d, req.window_start, req.window_end):
                        if req.pair_ok(off.depart_date, off.return_date):
                            off.price_amount *= req.pax  # TP prices are per adult (approximation)
                            offers.append(off)
                    outs = tp.one_ways(o, d, req.window_start, req.window_end)
                    backs = tp.one_ways(d, o, req.window_start, req.window_end)
                    offers += build_splits(o, d, req, outs, backs, "travelpayouts", fx, scale=req.pax)
            tp_status.ok = True
        except Exception as e:
            tp_status.error = f"{type(e).__name__}: {str(e)[:200]}"
        tp_status.calls = tp.calls
        tp_status.offers = len(offers)
    else:
        tp_status.error = "TRAVELPAYOUTS_TOKEN not set"

    # Step 4: narrow to Top N date pairs.
    apply_extras_and_fx(offers, req, fx)
    by_pair: dict[tuple[date, date], float] = {}
    for o in offers:
        k = (o.depart_date, o.return_date)
        by_pair[k] = min(by_pair.get(k, float("inf")), o.total_ils or float("inf"))
    if by_pair:
        candidates = sorted(by_pair, key=by_pair.get)[:top_n]
        candidates_from = "travelpayouts"
    else:
        candidates = _sample_pairs(req.valid_pairs(), top_n)
        candidates_from = "sampled_window"

    # Step 5: deep search on Google Flights (primary airports only, rate controlled).
    if gf is not None:
        before = len(offers)
        for dep, ret in candidates:
            if gf.blocked:
                break
            for off in gf.round_trip(req, req.origin, req.destination, dep, ret):
                off.deeplink = aviasales_search_link(req.origin, req.destination, dep, ret, req.pax, tp.marker)
                offers.append(off)
            outs = [(dep, p, c, leg, url) for p, c, leg, url in gf.one_way(req, req.origin, req.destination, dep)]
            backs = [(ret, p, c, leg, url) for p, c, leg, url in gf.one_way(req, req.destination, req.origin, ret)]
            for s in build_splits(req.origin, req.destination, req, outs, backs, "google_flights", fx):
                if (s.depart_date, s.return_date) == (dep, ret):
                    s.includes = {"checked_bag": True} if req.checked_bag else {}
                    s.verify_link = outs[0][4] if outs else None
                    s.deeplink = aviasales_search_link(req.origin, req.destination, dep, ret, req.pax, tp.marker)
                    offers.append(s)
        gf_status.calls = gf.calls
        gf_status.offers = len(offers) - before
        gf_status.ok = gf.calls > 0 and gf.failures < gf.calls
        if gf.errors:
            gf_status.error = gf.errors[-1] + (" (stopped: 3 consecutive failures)" if gf.blocked else "")
    else:
        gf_status.error = "disabled (ENABLE_FAST_FLIGHTS=false)"

    # Steps 6-8: merge happens implicitly (all offers compete), extras + FX, rank.
    apply_extras_and_fx(offers, req, fx)
    cards = recommend(offers, req)

    comparison = []
    for dep, ret in candidates:
        pc = PairComparison(dep, ret)
        for o in offers:
            if (o.depart_date, o.return_date) != (dep, ret):
                continue
            attr = ("tp" if o.source == "travelpayouts" else "gf") + "_" + o.ticket_structure + "_ils"
            cur = getattr(pc, attr)
            if cur is None or o.total_ils < cur:
                setattr(pc, attr, o.total_ils)
        comparison.append(pc)

    return SearchResult(req, offers, cards, [tp_status, gf_status], comparison, fx.source, candidates_from)
