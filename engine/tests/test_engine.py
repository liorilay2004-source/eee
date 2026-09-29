"""Offline tests mapped to SPEC §16 acceptance criteria. No network access."""

import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tpe import report  # noqa: E402
from tpe.fx import FxRates  # noqa: E402
from tpe.models import Leg, Offer, SearchRequest  # noqa: E402
from tpe.pipeline import TAG_BAG_UNKNOWN, TAG_BONUS_BAG, apply_extras_and_fx, build_splits, run_search  # noqa: E402
from tpe.scoring import BEST_VALUE, CHEAPEST, MY_TIMES, recommend, recommendations_meta  # noqa: E402
from tpe.sources.travelpayouts import Travelpayouts, aviasales_search_link  # noqa: E402

FX = FxRates({"USD": 3.0, "EUR": 3.5}, "test")
FIXTURES = Path(__file__).parent / "fixtures"


def req(**kw):
    base = dict(origin="TLV", destination="BCN", window_start=date(2026, 11, 10),
                window_end=date(2026, 11, 25), stay_min=5, stay_max=7)
    return SearchRequest(**(base | kw))


def offer(price, cur="USD", out=None, inb=None, structure="roundtrip", source="travelpayouts",
          dep=date(2026, 11, 12), ret=date(2026, 11, 18), includes=None):
    return Offer("TLV", "BCN", dep, ret, price, cur, source, structure,
                 out or Leg("10:00", stops=0, duration_min=300, airlines=["LY"]),
                 inb or Leg("18:00", stops=0, duration_min=300, airlines=["LY"]),
                 includes=includes or {})


# --- §4.1 extras -------------------------------------------------------------

def test_unrequested_included_bag_is_bonus_not_penalty():
    r = req()
    a = offer(100, includes={"checked_bag": True})
    b = offer(110)
    apply_extras_and_fx([a, b], r, FX)
    assert TAG_BONUS_BAG in a.tags
    assert a.total_ils == 300.0  # ranked on base price
    assert recommend([a, b], r)[0].offer is a


def test_selected_bag_adds_low_cost_fee():
    r = req(checked_bag=True)
    lowcost = offer(100, out=Leg("06:00", 0, None, 300, ["W6"]), inb=Leg("20:00", 0, None, 300, ["W6"]))
    full = offer(150, includes={"checked_bag": True})
    apply_extras_and_fx([lowcost, full], r, FX)
    # 2 legs x EUR 45 x 3.5 = 315 ILS
    assert lowcost.extras_amount_ils == pytest.approx(315.0)
    assert lowcost.total_ils == pytest.approx(615.0)
    assert full.total_ils == pytest.approx(450.0)
    cheapest = [c for c in recommend([lowcost, full], r) if CHEAPEST in c.kinds][0]
    assert cheapest.offer is full


def test_selected_bag_unknown_airline_is_tagged():
    r = req(checked_bag=True)
    o = offer(100, out=Leg(airlines=["ZZ"]), inb=Leg(airlines=["ZZ"]))
    apply_extras_and_fx([o], r, FX)
    assert TAG_BAG_UNKNOWN in o.tags and o.extras_amount_ils == 0


# --- §8 recommendations ------------------------------------------------------

def test_my_times_hidden_without_preferences():
    r = req()
    offers = [offer(100), offer(120, out=Leg("08:00", 0, None, 300, ["LY"]))]
    apply_extras_and_fx(offers, r, FX)
    kinds = [k for c in recommend(offers, r) for k in c.kinds]
    assert MY_TIMES not in kinds


def test_my_times_picks_cheapest_in_window():
    r = req(out_hours=(7, 12), ret_hours=(15, 23))
    night = offer(80, out=Leg("02:00", 0, None, 300, ["W6"]))
    good = offer(120, out=Leg("09:00", 0, None, 300, ["LY"]))
    apply_extras_and_fx([night, good], r, FX)
    cards = recommend([night, good], r)
    mt = [c for c in cards if MY_TIMES in c.kinds][0]
    assert mt.offer is good


def test_best_value_penalises_night_and_stops():
    r = req()
    cheap_bad = offer(100, out=Leg("03:00", 2, None, 900, ["X"]), inb=Leg("04:00", 2, None, 900, ["X"]))
    decent = offer(200)
    apply_extras_and_fx([cheap_bad, decent], r, FX)
    cards = recommend([cheap_bad, decent], r)
    assert [c for c in cards if CHEAPEST in c.kinds][0].offer is cheap_bad
    assert [c for c in cards if BEST_VALUE in c.kinds][0].offer is decent


def test_same_offer_shown_once_with_multiple_tags():
    r = req()
    o = offer(100)
    apply_extras_and_fx([o], r, FX)
    cards = recommend([o], r)
    assert len(cards) == 1 and cards[0].kinds == [CHEAPEST, BEST_VALUE]


def test_split_cheaper_shows_savings():
    r = req()
    rt = offer(200)
    outs = [(date(2026, 11, 12), 60.0, "USD", Leg("07:00", 0, None, 300, ["W6"]), None)]
    backs = [(date(2026, 11, 18), 70.0, "USD", Leg("19:00", 0, None, 300, ["FR"]), None)]
    splits = build_splits("TLV", "BCN", r, outs, backs, "travelpayouts", FX)
    assert len(splits) == 1 and splits[0].price_amount == 130.0
    apply_extras_and_fx([rt] + splits, r, FX)
    cheapest = [c for c in recommend([rt] + splits, r) if CHEAPEST in c.kinds][0]
    assert cheapest.offer.ticket_structure == "split"
    assert cheapest.savings_vs_roundtrip_ils == pytest.approx(210.0)
    assert "חסכת ₪210 לעומת הלוך-חזור" in "\n".join(report.card_lines(cheapest, FX))


# --- §4.2 currency -----------------------------------------------------------

def test_usd_displayed_as_ils_with_original_and_stored_in_usd():
    o = offer(164)
    apply_extras_and_fx([o], req(), FX)
    assert o.price_currency == "USD" and o.price_amount == 164
    assert report.money(o, FX) == "≈ ₪492 ($164)"


# --- Sources -----------------------------------------------------------------

class FakeResp:
    def __init__(self, body, status=200):
        self._b, self.status_code, self.text = body, status, json.dumps(body)

    def json(self):
        return self._b


class FakeSession:
    def __init__(self, handler):
        self.handler, self.seen = handler, []

    def get(self, url, params=None, headers=None, timeout=None):
        self.seen.append((url, dict(params or {}), dict(headers or {})))
        return FakeResp(self.handler(params))


def tp_handler(params):
    body = json.loads((FIXTURES / "tp_roundtrip.json").read_text())
    if params.get("one_way") == "true":
        body = json.loads((FIXTURES / "tp_oneway.json").read_text())
        body["data"] = [d for d in body["data"] if d["origin"] == params["origin"]]
    return body


def test_travelpayouts_parsing_and_token_in_header_only():
    s = FakeSession(tp_handler)
    tp = Travelpayouts(token="SECRET", marker="12345", session=s)
    offers = tp.round_trips("TLV", "BCN", date(2026, 11, 10), date(2026, 11, 25))
    assert offers and offers[0].price_currency == "USD"
    assert offers[0].outbound.depart_time == "06:15" and offers[0].inbound.stops == 1
    assert "marker=12345" in offers[0].deeplink
    for url, params, headers in s.seen:
        assert "SECRET" not in url and "SECRET" not in json.dumps(params)
        assert headers["X-Access-Token"] == "SECRET"
        assert params["market"] == "il"


def test_pipeline_works_with_fast_flights_disabled():
    r = req()
    tp = Travelpayouts(token="t", marker="m", session=FakeSession(tp_handler))
    res = run_search(r, tp, None, FX)
    assert res.cards, "product must work on Travelpayouts alone"
    assert all(o.source == "travelpayouts" for o in res.offers)
    # out-of-window pair (return 28/11) filtered out
    assert all(r.pair_ok(o.depart_date, o.return_date) for o in res.offers)
    assert {"travelpayouts": True, "google_flights": False} == {s.name: s.ok for s in res.sources}


def test_aviasales_search_link_format():
    link = aviasales_search_link("TLV", "BCN", date(2026, 11, 12), date(2026, 11, 18), 1, "999")
    assert link == "https://www.aviasales.com/search/TLV1211BCN18111?marker=999"


def test_valid_pairs_respect_window_and_stay():
    r = req(window_start=date(2026, 11, 10), window_end=date(2026, 11, 16), stay_min=5, stay_max=6)
    assert r.valid_pairs() == [
        (date(2026, 11, 10), date(2026, 11, 15)), (date(2026, 11, 10), date(2026, 11, 16)),
        (date(2026, 11, 11), date(2026, 11, 16)),
    ]


# --- WEB_APP_SPEC §5.3 bag-cost pool rule (AC-R7) -----------------------------

def _w6(price):
    return offer(price, out=Leg("10:00", stops=0, duration_min=300, airlines=["W6"]),
                 inb=Leg("18:00", stops=0, duration_min=300, airlines=["W6"]))


def test_unknown_bag_fee_does_not_win_cheapest_or_best_value():
    r = req(checked_bag=True)
    unknown, known = offer(100), _w6(200)  # LY has no table fee
    apply_extras_and_fx([unknown, known], r, FX)
    assert TAG_BAG_UNKNOWN in unknown.tags
    cards = recommend([unknown, known], r)
    assert [c.kinds for c in cards] == [[CHEAPEST, BEST_VALUE]] and cards[0].offer is known
    assert recommendations_meta([unknown, known], r, cards) == {
        "cheapest": {"status": "shown", "excludedForUnknownBagFee": 1}, "bestValue": {"status": "merged"}}


def test_all_unknown_bag_fees_show_lower_bound_and_hide_best_value():
    r = req(checked_bag=True)
    a, b = offer(300), offer(100)
    apply_extras_and_fx([a, b], r, FX)
    cards = recommend([a, b], r)
    assert [c.kinds for c in cards] == [[CHEAPEST]] and cards[0].offer is b
    assert recommendations_meta([a, b], r, cards)["bestValue"] == {"status": "bag_cost_unknown"}
    assert recommendations_meta([a, b], r, cards)["cheapest"]["excludedForUnknownBagFee"] == 0


def test_my_times_prefers_known_bag_cost():
    r = req(checked_bag=True, out_hours=(8, 12))
    unknown, known = offer(100), _w6(200)
    apply_extras_and_fx([unknown, known], r, FX)
    mine = [c for c in recommend([unknown, known], r) if MY_TIMES in c.kinds][0]
    assert mine.offer is known
