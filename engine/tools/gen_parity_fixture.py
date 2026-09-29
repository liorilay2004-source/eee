#!/usr/bin/env python3
"""Generate worker/test/fixtures/parity.json: scenarios run through the Python reference engine.

The Worker's scoring/extras code (worker/src/scoring.ts, extras.ts) must reproduce these results, so
this file is the executable definition of "identical behaviour". Run from the repo root:

    python3 engine/tools/gen_parity_fixture.py [output_path]

Output is fully deterministic (own splitmix64 PRNG, fixed timestamps): re-running yields identical bytes
unless the engine, config/scoring.json or config/bag_fees.json changed. Regenerate after such a change.
"""

from __future__ import annotations

import copy
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]
ROOT = ENGINE_DIR.parent
sys.path.insert(0, str(ENGINE_DIR))

from tpe.config import BAG_FEES, SCORING  # noqa: E402
from tpe.fx import FxRates  # noqa: E402
from tpe.models import Leg, Offer, SearchRequest  # noqa: E402
from tpe.pipeline import apply_extras_and_fx  # noqa: E402
from tpe.scoring import fastest_by_direction, matches_times, recommend, recommendations_meta, value_score  # noqa: E402

DEFAULT_OUT = ROOT / "worker" / "test" / "fixtures" / "parity.json"
SEED = 20260929
SCENARIOS_PER_FLAVOUR = 26  # x 11 flavours = 286 scenarios
CHECKED_AT = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)

FX_RATES = {"USD": 3.0, "EUR": 3.5, "GBP": 4.0}
FX = FxRates(FX_RATES, "parity-test")

MASK64 = (1 << 64) - 1


class Rng:
    """splitmix64: tiny and identical on every Python version (random.Random's helpers are not)."""

    def __init__(self, seed: int):
        self.s = seed & MASK64

    def next_u64(self) -> int:
        self.s = (self.s + 0x9E3779B97F4A7C15) & MASK64
        z = self.s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def random(self) -> float:
        return (self.next_u64() >> 11) / float(1 << 53)

    def int(self, lo: int, hi: int) -> int:
        return lo + self.next_u64() % (hi - lo + 1)

    def chance(self, p: float) -> bool:
        return self.random() < p

    def choice(self, seq):
        return seq[self.int(0, len(seq) - 1)]

    def weighted(self, pairs):
        total = sum(w for _, w in pairs)
        r = self.random() * total
        acc = 0.0
        for v, w in pairs:
            acc += w
            if r < acc:
                return v
        return pairs[-1][0]


# --- scenario knobs ------------------------------------------------------------------------------------

AIRLINES = [("W6", 3), ("FR", 3), ("VY", 2), ("LY", 4), ("LH", 3), ("ZZ", 1), ("U2", 1), ("IZ", 1), ("6H", 1)]
LOWCOST = {"W6", "FR", "VY", "U2", "IZ", "6H"}
CURRENCIES = [("USD", 4), ("EUR", 4), ("ILS", 3), ("GBP", 1)]
# Includes wrap-around windows (start > end), a full-day window and one that never matches.
WINDOWS = [(6, 12), (7, 11), (12, 18), (15, 23), (18, 24), (0, 6), (22, 4), (20, 6), (23, 2), (21, 3), (0, 24), (9, 9)]
DESTINATIONS = ["BCN", "ATH", "FCO", "LCA", "MAD"]

BASE = dict(n=(4, 12), bag=0.4, win=0.2, split=0.3, night=0.15, null_time=0.08, null_stops=0.10, null_dur=0.12,
            dup=0.12, coarse=False, unknown_rt_return=0.12, included=0.25, lowcost=0.4, max_stops=0.4)
FLAVOURS = {
    "mixed": {},
    "bag_requested": dict(bag=1.0, lowcost=0.65, included=0.3),
    "bag_not_requested": dict(bag=0.0, included=0.45),
    "time_windows": dict(win=0.95, night=0.25, null_time=0.12, max_stops=0.5),
    "split_vs_rt": dict(split=0.55, dup=0.15),
    "ties": dict(coarse=True, dup=0.3),
    "sparse": dict(n=(0, 3), null_time=0.35, null_stops=0.35, null_dur=0.35, unknown_rt_return=0.3),
    "night_stops": dict(night=0.4, null_dur=0.03, null_stops=0.03, bag=0.3),
    # Every offer gets a near-duplicate, so card merging (Offer.key) is exercised field by field.
    "twins": dict(n=(2, 3), dup=1.0, null_time=0.02, null_stops=0.03, null_dur=0.2, win=0.3),
    # Best Value scores tie exactly; the lower total must win (SPEC §8 tie-break), whatever the input order.
    "score_ties": dict(score_ties=True, ils_only=True, bag=0.0, null_dur=1.0, win=0.3, n=(3, 6)),
    # Bag requested, many full-service carriers without a table fee (bag-cost pool rule, WEB_APP_SPEC §5.3): unknown-fee
    # offers must not win 💰/⚖️/🎯 over known-fee ones, and ⚖️ disappears when no offer has a known bag cost.
    # Appended last so every earlier flavour draws exactly the same numbers as before.
    "bag_unknown_mix": dict(bag=1.0, lowcost=0.35, included=0.05, win=0.35, n=(1, 8)),
}


def gen_airlines(rng: Rng, p: dict) -> list[str]:
    r = rng.random()
    if r < 0.04:
        return []
    want_lowcost = rng.chance(p["lowcost"])
    first = rng.weighted([(a, w * (4 if (a in LOWCOST) == want_lowcost else 1)) for a, w in AIRLINES])
    if r < 0.12:
        return [first, rng.weighted(AIRLINES)]  # multi-carrier itinerary; only the first pays the fee
    return [first]


def gen_leg(rng: Rng, p: dict, airlines: list[str]) -> Leg:
    depart = None
    if not rng.chance(p["null_time"]):
        h = rng.int(0, 5) if rng.chance(p["night"]) else rng.int(6, 23)
        depart = f"{h:02d}:{rng.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]):02d}"
    stops = None if rng.chance(p["null_stops"]) else rng.weighted([(0, 55), (1, 32), (2, 10), (3, 3)])
    duration = None
    if not rng.chance(p["null_dur"]):
        duration = 260 + (stops or 0) * rng.int(100, 260) + rng.int(0, 70)
        if rng.chance(0.01):
            duration = 0  # degenerate value: Python treats 0 as unknown
    arrive = None
    if depart and duration and rng.chance(0.8):
        m = (int(depart[:2]) * 60 + int(depart[3:]) + duration) % 1440
        arrive = f"{m // 60:02d}:{m % 60:02d}"
    return Leg(depart_time=depart, arrive_time=arrive, stops=stops, duration_min=duration, airlines=airlines)


def gen_request(rng: Rng, p: dict) -> SearchRequest:
    pax = rng.weighted([(1, 50), (2, 30), (3, 20)])
    adults, children, infants = rng.choice({
        1: [(1, 0, 0)],
        2: [(2, 0, 0), (1, 1, 0), (1, 0, 1)],
        3: [(3, 0, 0), (2, 1, 0), (2, 0, 1), (1, 1, 1), (1, 2, 0)],
    }[pax])
    start = date(2026, 11, 10) + timedelta(days=rng.int(0, 20))
    stay_min = rng.int(2, 7)
    stay_max = stay_min + rng.int(0, 4)
    return SearchRequest(
        origin="TLV", destination=rng.choice(DESTINATIONS),
        window_start=start, window_end=start + timedelta(days=rng.int(12, 30)),
        stay_min=stay_min, stay_max=stay_max, adults=adults, children=children, infants=infants,
        checked_bag=rng.chance(p["bag"]),
        out_hours=rng.choice(WINDOWS) if rng.chance(p["win"]) else None,
        ret_hours=rng.choice(WINDOWS) if rng.chance(p["win"]) else None,
        max_stops=rng.choice([0, 1, 1, 2]) if rng.chance(p["max_stops"]) else None,
    )


def gen_offer(rng: Rng, p: dict, req: SearchRequest) -> Offer:
    split = rng.chance(p["split"])
    nights = rng.int(req.stay_min, req.stay_max)
    dep = req.window_start + timedelta(days=rng.int(0, max(0, (req.window_end - req.window_start).days - nights)))
    ret = dep + timedelta(days=nights)

    out_airlines = gen_airlines(rng, p)
    if split:
        in_airlines = gen_airlines(rng, p)
    else:
        in_airlines = out_airlines if rng.chance(0.85) else gen_airlines(rng, p)
    outbound = gen_leg(rng, p, out_airlines)
    inbound = gen_leg(rng, p, in_airlines)
    if not split and rng.chance(p["unknown_rt_return"]):
        # Google-style round trip: the return leg's stops/duration (and maybe time) are not reported.
        inbound = Leg(depart_time=inbound.depart_time if rng.chance(0.5) else None, airlines=in_airlines)

    cur = "ILS" if p.get("ils_only") else rng.weighted(CURRENCIES)
    pax = req.pax
    if p["coarse"]:
        per_pax = rng.choice({"USD": [200, 240, 300], "EUR": [200, 240, 300], "GBP": [150, 180, 225],
                              "ILS": [600, 700, 720, 840, 900, 1050]}[cur])
        amount = float(per_pax * pax)
    else:
        factor = rng.random() * 0.45 + 0.6 if split else rng.random() * 0.45 + 0.95
        ils = rng.int(250, 1800) * pax * factor
        amount = round(ils / (1.0 if cur == "ILS" else FX_RATES[cur]), 2)

    included = rng.chance(p["included"] * (0.15 if (out_airlines and out_airlines[0] in LOWCOST) else 1.6))
    includes: dict = {"checked_bag": True} if included else ({"checked_bag": False} if rng.chance(0.1) else {})

    # Stale pipeline output: applying extras must recompute from scratch (idempotence), keeping foreign tags.
    tags = rng.choice([[], [], [], ["bonus_checked_bag"], ["bag_fee_unknown", "promo"], ["promo"], ["promo", "bonus_checked_bag"]])
    stale = rng.chance(0.15)
    return Offer(
        origin=req.origin, destination=req.destination, depart_date=dep, return_date=ret,
        price_amount=amount, price_currency=cur,
        source="google_flights" if rng.chance(0.3) else "travelpayouts",
        ticket_structure="split" if split else "roundtrip",
        outbound=outbound, inbound=inbound, includes=includes, checked_at=CHECKED_AT,
        extras_amount_ils=123.45 if stale else 0.0, total_ils=1.0 if stale else None, tags=list(tags),
    )


def equalise_scores(offers: list[Offer], req: SearchRequest) -> None:
    """Reprice (ILS, whole shekels) so every offer gets the same Best Value score but a different total.

    Needs durations to be unknown or equal so penalties are whole numbers, which makes the ties exact."""
    probe = copy.deepcopy(offers)
    for o in probe:
        o.price_amount, o.price_currency = 1000.0, "ILS"
    apply_extras_and_fx(probe, req, FX)
    fastest = fastest_by_direction(probe)
    pens = [value_score(o, fastest) - o.total_ils for o in probe]
    worst = max(pens)
    for o, pen in zip(offers, pens):
        o.price_amount, o.price_currency = 1000.0 + (worst - pen), "ILS"


def make_twin(rng: Rng, p: dict, o: Offer) -> Offer:
    """A near-duplicate of `o` for exercising Offer.key() (which decides whether two picks merge into one card).

    Same key: exact copy, different airlines, sub-cent price noise. Different key: one key field changed.
    Most twins also get an extra outbound stop, so cheapest and best value can pick different members of a
    pair, which is the only way a wrong key shows up in the cards."""
    twin = copy.deepcopy(o)
    kind = "exact" if p.get("ils_only") else rng.weighted(
        [("exact", 20), ("airlines", 10), ("subcent", 10), ("source", 8), ("structure", 8), ("depart", 8),
         ("return", 8), ("otime", 8), ("itime", 8), ("currency", 5), ("cent", 7)])

    def shift_time(leg: Leg) -> None:
        leg.depart_time = f"{(int(leg.depart_time[:2]) + 1) % 24:02d}{leg.depart_time[2:]}" if leg.depart_time else "13:37"

    if kind == "airlines":  # same key, but bag fees (and so totals) may differ
        twin.outbound.airlines = [rng.weighted(AIRLINES)]
    elif kind == "subcent":  # rounds to the same cent in the key, yet is (barely) cheaper in ILS
        twin.price_amount = round(o.price_amount - 0.004, 3)
    elif kind == "cent":
        twin.price_amount = round(o.price_amount - 0.01, 2)
    elif kind == "source":
        twin.source = "google_flights" if o.source == "travelpayouts" else "travelpayouts"
    elif kind == "structure":
        twin.ticket_structure = "split" if o.ticket_structure == "roundtrip" else "roundtrip"
    elif kind == "depart":
        twin.depart_date = o.depart_date + timedelta(days=1)
    elif kind == "return":
        twin.return_date = o.return_date + timedelta(days=1)
    elif kind == "otime":
        shift_time(twin.outbound)
    elif kind == "itime":
        shift_time(twin.inbound)
    elif kind == "currency":
        twin.price_currency = rng.choice([c for c in ("USD", "EUR", "ILS", "GBP") if c != o.price_currency])
    if kind != "exact" and rng.chance(0.7):
        twin.outbound.stops = (o.outbound.stops or 0) + 1
    return twin


def gen_offers(rng: Rng, p: dict, req: SearchRequest) -> list[Offer]:
    offers = [gen_offer(rng, p, req) for _ in range(rng.int(*p["n"]))]
    if p.get("score_ties"):
        equalise_scores(offers, req)
    for o in list(offers):
        if rng.chance(p["dup"]):
            offers.insert(rng.int(0, len(offers)), make_twin(rng, p, o))
    return offers


# --- serialisation to the Worker's camelCase types -----------------------------------------------------

def leg_ts(leg: Leg) -> dict:
    return {"departTime": leg.depart_time, "arriveTime": leg.arrive_time, "stops": leg.stops,
            "durationMin": leg.duration_min, "airlines": list(leg.airlines)}


def offer_ts(o: Offer) -> dict:
    includes = {} if "checked_bag" not in o.includes else {"checkedBag": bool(o.includes["checked_bag"])}
    return {
        "origin": o.origin, "destination": o.destination,
        "departDate": o.depart_date.isoformat(), "returnDate": o.return_date.isoformat(),
        "priceAmount": o.price_amount, "priceCurrency": o.price_currency,
        "source": o.source, "ticketStructure": o.ticket_structure,
        "outbound": leg_ts(o.outbound), "inbound": leg_ts(o.inbound),
        "includes": includes, "deeplink": None, "verifyLink": None,
        "checkedAt": o.checked_at.isoformat(),
        "extrasAmountIls": o.extras_amount_ils, "totalIls": o.total_ils, "tags": list(o.tags),
    }


def req_ts(r: SearchRequest) -> dict:
    return {
        "origin": r.origin, "destination": r.destination,
        "windowStart": r.window_start.isoformat(), "windowEnd": r.window_end.isoformat(),
        "stayMin": r.stay_min, "stayMax": r.stay_max,
        "adults": r.adults, "children": r.children, "infants": r.infants,
        "cabin": r.cabin, "checkedBag": r.checked_bag,
        "outHours": list(r.out_hours) if r.out_hours else None,
        "retHours": list(r.ret_hours) if r.ret_hours else None,
        "maxStops": r.max_stops, "nearbyAirports": r.nearby_airports,
    }


def run_scenario(name: str, req: SearchRequest, offers: list[Offer]) -> dict:
    inputs = {"request": req_ts(req), "offers": [offer_ts(o) for o in offers]}

    apply_extras_and_fx(offers, req, FX)
    snapshot = [(o.total_ils, o.extras_amount_ils, list(o.tags)) for o in offers]
    apply_extras_and_fx(offers, req, FX)  # the Worker port promises idempotence: check the reference has it too
    assert snapshot == [(o.total_ils, o.extras_amount_ils, list(o.tags)) for o in offers], name

    priced = [o for o in offers if o.total_ils is not None]
    fastest = fastest_by_direction(priced)
    cards = recommend(offers, req)
    meta = recommendations_meta(offers, req, cards)
    return {
        "name": name,
        **inputs,
        "expected": {
            "offers": [
                {"totalIls": o.total_ils, "extrasAmountIls": o.extras_amount_ils, "tags": list(o.tags),
                 "score": value_score(o, fastest) if o.total_ils is not None else None,
                 "matchesTimes": matches_times(o, req)}
                for o in offers
            ],
            "fastest": list(fastest),
            "cards": [
                {"offerIndex": next(i for i, o in enumerate(offers) if o is c.offer), "kinds": list(c.kinds),
                 "savingsVsRoundtripIls": c.savings_vs_roundtrip_ils}
                for c in cards
            ],
            "recommendations": meta,
        },
    }


def coverage(scenarios: list[dict]) -> dict[str, int]:
    c = {k: 0 for k in ("scenarios", "empty", "single", "roundtrip_offers", "split_offers", "savings", "my_times",
                        "merged_cards", "triple_cards", "bonus_tag", "bag_unknown_tag", "bag_fee_added",
                        "wrap_window", "unmatched_window_scenario", "max_stops", "null_stops", "null_duration",
                        "night_departure", "unknown_carrier", "GBP", "USD", "EUR", "ILS", "pax_2", "pax_3",
                        "unknown_return_leg", "stale_input", "bag_pool_excluded", "bag_cost_unknown",
                        "bag_value_merged", "bag_value_shown")}
    for s in scenarios:
        r, offers, exp = s["request"], s["offers"], s["expected"]
        c["scenarios"] += 1
        c["empty"] += not offers
        c["single"] += len(offers) == 1
        c["pax_2"] += r["adults"] + r["children"] + r["infants"] == 2
        c["pax_3"] += r["adults"] + r["children"] + r["infants"] == 3
        c["max_stops"] += r["maxStops"] is not None
        c["wrap_window"] += any(w and w[0] > w[1] for w in (r["outHours"], r["retHours"]))
        c["savings"] += any(k["savingsVsRoundtripIls"] is not None for k in exp["cards"])
        c["my_times"] += any("my_times" in k["kinds"] for k in exp["cards"])
        c["merged_cards"] += any(len(k["kinds"]) > 1 for k in exp["cards"])
        c["triple_cards"] += any(len(k["kinds"]) == 3 for k in exp["cards"])
        rec = exp["recommendations"]
        c["bag_pool_excluded"] += rec["cheapest"]["excludedForUnknownBagFee"] > 0
        c["bag_cost_unknown"] += rec["bestValue"]["status"] == "bag_cost_unknown"
        c["bag_value_merged"] += r["checkedBag"] and rec["bestValue"]["status"] == "merged"
        c["bag_value_shown"] += r["checkedBag"] and rec["bestValue"]["status"] == "shown"
        if (r["outHours"] or r["retHours"]) and offers and not any(o["matchesTimes"] for o in exp["offers"]):
            c["unmatched_window_scenario"] += 1
        for o, e in zip(offers, exp["offers"]):
            c["roundtrip_offers"] += o["ticketStructure"] == "roundtrip"
            c["split_offers"] += o["ticketStructure"] == "split"
            c["bonus_tag"] += "bonus_checked_bag" in e["tags"]
            c["bag_unknown_tag"] += "bag_fee_unknown" in e["tags"]
            c["bag_fee_added"] += e["extrasAmountIls"] > 0
            c["stale_input"] += o["totalIls"] is not None
            c[o["priceCurrency"]] += 1
            for leg in (o["outbound"], o["inbound"]):
                c["null_stops"] += leg["stops"] is None
                c["null_duration"] += leg["durationMin"] is None
                c["night_departure"] += bool(leg["departTime"]) and int(leg["departTime"][:2]) < 6
                c["unknown_carrier"] += bool(leg["airlines"]) and leg["airlines"][0] in ("LY", "LH", "ZZ")
            c["unknown_return_leg"] += o["inbound"]["stops"] is None and o["inbound"]["durationMin"] is None
    return c


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    rng = Rng(SEED)
    scenarios = []
    for flavour, override in FLAVOURS.items():
        p = {**BASE, **override}
        for i in range(SCENARIOS_PER_FLAVOUR):
            req = gen_request(rng, p)
            scenarios.append(run_scenario(f"{flavour}-{i:02d}", req, gen_offers(rng, p, req)))

    cov = coverage(scenarios)
    # The fixture is only worth having if it actually exercises the interesting paths.
    floor = {"scenarios": 200, "empty": 3, "single": 3, "savings": 15, "my_times": 40, "merged_cards": 40,
             "triple_cards": 5, "bonus_tag": 40, "bag_unknown_tag": 40, "bag_fee_added": 60, "wrap_window": 15,
             "unmatched_window_scenario": 3, "max_stops": 30, "null_stops": 50, "night_departure": 50,
             "unknown_return_leg": 20, "GBP": 5, "stale_input": 20, "bag_pool_excluded": 15, "bag_cost_unknown": 5,
             "bag_value_merged": 10, "bag_value_shown": 10}
    missing = {k: (cov[k], v) for k, v in floor.items() if cov[k] < v}
    assert not missing, f"fixture coverage too thin (got, need): {missing}"

    doc_head = {
        "_comment": "GENERATED by engine/tools/gen_parity_fixture.py from the Python reference engine. Do not edit; "
                    "regenerate after changing engine/tpe, config/scoring.json or config/bag_fees.json.",
        "config": {
            "scoring": {k: SCORING[k] for k in ("night_departure_penalty_ils", "night_start_hour", "night_end_hour",
                                                "stop_penalty_ils", "duration_penalty_ils_per_hour")},
            "bagFees": BAG_FEES,
        },
        "fx": {"date": "2026-11-01", "source": "parity-test", "ratesToIls": {"ILS": 1.0, **FX_RATES}},
    }
    lines = [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in scenarios]
    body = json.dumps(doc_head, ensure_ascii=False, indent=1)
    # One scenario per line keeps the file diffable; the head is pretty-printed JSON with the array appended.
    text = body[:-1].rstrip() + ',\n "scenarios": [\n' + ",\n".join(lines) + "\n ]\n}\n"
    json.loads(text)  # must be valid JSON

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    print(f"wrote {out_path} ({len(scenarios)} scenarios, {len(text) // 1024} KiB)")
    print("coverage:", json.dumps(cov, sort_keys=True))


if __name__ == "__main__":
    main()
