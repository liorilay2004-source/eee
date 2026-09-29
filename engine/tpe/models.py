"""Core data types shared by sources, pipeline and scoring."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timezone


@dataclass
class Leg:
    """One direction of a trip. Unknown fields stay None (never guessed)."""

    depart_time: str | None = None  # "HH:MM" local
    arrive_time: str | None = None
    stops: int | None = None
    duration_min: int | None = None
    airlines: list[str] = field(default_factory=list)

    def depart_hour(self) -> int | None:
        if not self.depart_time:
            return None
        return int(self.depart_time.split(":")[0])


@dataclass
class Offer:
    origin: str
    destination: str
    depart_date: date
    return_date: date
    price_amount: float  # total for all passengers, original currency
    price_currency: str
    source: str  # travelpayouts | google_flights
    ticket_structure: str  # roundtrip | split
    outbound: Leg
    inbound: Leg
    includes: dict = field(default_factory=dict)  # e.g. {"checked_bag": True}
    deeplink: str | None = None
    verify_link: str | None = None
    checked_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # Filled in by the pipeline (step 7).
    extras_amount_ils: float = 0.0
    total_ils: float | None = None
    tags: list[str] = field(default_factory=list)

    @property
    def nights(self) -> int:
        return (self.return_date - self.depart_date).days

    @property
    def airlines(self) -> list[str]:
        seen: list[str] = []
        for a in self.outbound.airlines + self.inbound.airlines:
            if a not in seen:
                seen.append(a)
        return seen

    def key(self) -> tuple:
        """Identity used to merge duplicate recommendations into one card."""
        return (
            self.depart_date, self.return_date, self.source, self.ticket_structure,
            round(self.price_amount, 2), self.price_currency,
            self.outbound.depart_time, self.inbound.depart_time,
        )

    def to_json(self) -> dict:
        d = asdict(self)
        d["depart_date"] = self.depart_date.isoformat()
        d["return_date"] = self.return_date.isoformat()
        d["checked_at"] = self.checked_at.isoformat()
        return d


@dataclass
class SearchRequest:
    origin: str
    destination: str
    window_start: date
    window_end: date
    stay_min: int
    stay_max: int
    adults: int = 1
    children: int = 0
    infants: int = 0
    cabin: str = "economy"
    checked_bag: bool = False
    out_hours: tuple[int, int] | None = None  # [start, end) departure hour
    ret_hours: tuple[int, int] | None = None
    max_stops: int | None = None
    nearby_airports: bool = False

    @property
    def pax(self) -> int:
        return self.adults + self.children + self.infants

    @property
    def has_time_prefs(self) -> bool:
        return self.out_hours is not None or self.ret_hours is not None

    def valid_pairs(self) -> list[tuple[date, date]]:
        """All (depart, return) pairs inside the window matching stay length (SPEC §7 layer 1)."""
        from datetime import timedelta

        pairs = []
        d = self.window_start
        while d <= self.window_end:
            for n in range(self.stay_min, self.stay_max + 1):
                r = d + timedelta(days=n)
                if r <= self.window_end:
                    pairs.append((d, r))
            d += timedelta(days=1)
        return pairs

    def pair_ok(self, dep: date, ret: date) -> bool:
        n = (ret - dep).days
        return (
            self.window_start <= dep
            and ret <= self.window_end
            and self.stay_min <= n <= self.stay_max
        )
