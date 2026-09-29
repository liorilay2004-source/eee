"""Google Flights via the unofficial `fast-flights` library - enrichment only (SPEC §6).

Behind ENABLE_FAST_FLIGHTS. Rate control per SPEC §14: sequential calls,
2-5s jitter between calls, stop the run after 3 consecutive failures.
"""

from __future__ import annotations

import random
import time
from datetime import date, datetime

from ..models import Leg, Offer, SearchRequest

MAX_CONSECUTIVE_FAILURES = 3
REQUEST_CURRENCY = "USD"


class GoogleFlightsBlocked(RuntimeError):
    pass


def _leg_from(flight) -> Leg:
    segs = flight.flights
    total = 0
    for i, s in enumerate(segs):
        total += s.duration or 0
        if i > 0:
            prev = segs[i - 1]
            a = datetime(*prev.arrival.date, *prev.arrival.time)
            d = datetime(*s.departure.date, *s.departure.time)
            total += max(0, int((d - a).total_seconds() // 60))
    first, last = segs[0], segs[-1]
    code = flight.type if flight.type and flight.type != "multi" else None
    return Leg(
        depart_time="%02d:%02d" % first.departure.time,
        arrive_time="%02d:%02d" % last.arrival.time,
        stops=len(segs) - 1,
        duration_min=total or None,
        airlines=[code] if code else list(flight.airlines),
    )


class GoogleFlights:
    def __init__(self, sleep=time.sleep, jitter=(2.0, 5.0)):
        self._sleep = sleep
        self._jitter = jitter
        self.calls = 0
        self.failures = 0
        self.consecutive_failures = 0
        self.errors: list[str] = []
        self._first = True

    @property
    def blocked(self) -> bool:
        return self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES

    def _query(self, req: SearchRequest, legs: list[tuple[str, str, date]], trip: str):
        from fast_flights import FlightQuery, Passengers, create_query

        return create_query(
            flights=[FlightQuery(date=d.isoformat(), from_airport=a, to_airport=b) for a, b, d in legs],
            trip=trip,
            seat=req.cabin,
            passengers=Passengers(adults=req.adults, children=req.children, infants_on_lap=req.infants),
            currency=REQUEST_CURRENCY,
            language="en",
            max_stops=req.max_stops,
            checked_bags=req.pax if req.checked_bag else 0,
        )

    def _fetch(self, q):
        from fast_flights import FlightsNotFound, get_flights

        if self.blocked:
            raise GoogleFlightsBlocked("; ".join(self.errors[-3:]))
        if not self._first:
            self._sleep(random.uniform(*self._jitter))
        self._first = False
        self.calls += 1
        try:
            res = get_flights(q)
        except FlightsNotFound:
            self.consecutive_failures = 0
            return []
        except Exception as e:  # network error, HTML change, block page...
            self.failures += 1
            self.consecutive_failures += 1
            self.errors.append(f"{type(e).__name__}: {str(e)[:150]}")
            return []
        self.consecutive_failures = 0
        return [f for f in res if f.price and f.price > 0 and f.flights]

    def round_trip(self, req: SearchRequest, origin: str, dest: str, dep: date, ret: date) -> list[Offer]:
        q = self._query(req, [(origin, dest, dep), (dest, origin, ret)], "round-trip")
        out = []
        for f in self._fetch(q):
            out.append(Offer(
                origin=origin, destination=dest, depart_date=dep, return_date=ret,
                price_amount=float(f.price), price_currency=REQUEST_CURRENCY,
                source="google_flights", ticket_structure="roundtrip",
                outbound=_leg_from(f),
                inbound=Leg(),  # Google lists the return leg on a second page; unknown here
                includes={"checked_bag": True} if req.checked_bag else {},
                verify_link=q.url(),
            ))
        return out

    def one_way(self, req: SearchRequest, origin: str, dest: str, d: date) -> list[tuple[float, str, Leg, str]]:
        q = self._query(req, [(origin, dest, d)], "one-way")
        return [(float(f.price), REQUEST_CURRENCY, _leg_from(f), q.url()) for f in self._fetch(q)]
