"""Travelpayouts / Aviasales Data API - the core engine (SPEC §6).

Uses `prices_for_dates` with whole months so one call returns many date pairs.
Prices are for ONE adult; the pipeline scales by passenger count.
The token is sent in a header, never in the URL, so it can't leak into logs.
"""

from __future__ import annotations

import os
from datetime import date, datetime
from urllib.parse import urlencode, urlparse

import requests

from ..config import AIRPORT_COUNTRY, MARKET_BY_COUNTRY
from ..models import Leg, Offer

API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
AVIASALES = "https://www.aviasales.com"
REQUEST_CURRENCY = "usd"


class TravelpayoutsError(RuntimeError):
    pass


def _months(start: date, end: date) -> list[str]:
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def market_for(origin: str) -> str | None:
    return MARKET_BY_COUNTRY.get(AIRPORT_COUNTRY.get(origin, ""))


def affiliate_link(path: str | None, marker: str | None) -> str | None:
    if not path:
        return None
    url = path if path.startswith("http") else AVIASALES + path
    if marker:
        url += ("&" if "?" in url else "?") + urlencode({"marker": marker})
    return url


def aviasales_search_link(origin: str, dest: str, dep: date, ret: date | None, pax: int, marker: str | None) -> str:
    """Aviasales search deep link, e.g. /search/TLV1211BCN18111 - used for offers from other sources."""
    path = f"/search/{origin}{dep:%d%m}{dest}"
    if ret:
        path += f"{ret:%d%m}"
    path += str(pax)
    return affiliate_link(path, marker)  # type: ignore[return-value]


def _aviasales_roundtrip_link_matches(link: str, origin: str, dest: str, dep: date, ret: date) -> bool | None:
    parsed = urlparse(link)
    host = parsed.hostname.lower() if parsed.hostname else ""
    if host != "aviasales.com" and not host.endswith(".aviasales.com"):
        return None
    prefix = f"/search/{origin.upper()}{dep:%d%m}{dest.upper()}{ret:%d%m}".upper()
    path = parsed.path.upper()
    suffix = path[len(prefix):] if path.startswith(prefix) else ""
    return path.startswith(prefix) and suffix.isdigit() and 1 <= len(suffix) <= 3


def _hhmm(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).strftime("%H:%M")
    except ValueError:
        return None


def _date(iso: str) -> date:
    return datetime.fromisoformat(iso).date()


class Travelpayouts:
    def __init__(self, token: str | None = None, marker: str | None = None, session: requests.Session | None = None):
        self.token = token if token is not None else os.environ.get("TRAVELPAYOUTS_TOKEN", "")
        self.marker = marker if marker is not None else os.environ.get("TRAVELPAYOUTS_MARKER", "")
        self.http = session or requests.Session()
        self.calls = 0

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _get(self, params: dict) -> list[dict]:
        if not self.configured:
            raise TravelpayoutsError("TRAVELPAYOUTS_TOKEN is not set")
        self.calls += 1
        r = self.http.get(API, params=params, headers={"X-Access-Token": self.token}, timeout=30)
        if r.status_code != 200:
            raise TravelpayoutsError(f"HTTP {r.status_code}: {r.text[:200]}")
        body = r.json()
        if not body.get("success", False):
            raise TravelpayoutsError(f"API error: {str(body)[:200]}")
        cur = (body.get("currency") or REQUEST_CURRENCY).upper()
        rows = body.get("data") or []
        for row in rows:
            row["_currency"] = cur
        return rows

    def _base(self, origin: str, dest: str) -> dict:
        p = {
            "origin": origin,
            "destination": dest,
            "currency": REQUEST_CURRENCY,
            "sorting": "price",
            "direct": "false",
            "unique": "false",
            "limit": 1000,
            "page": 1,
        }
        m = market_for(origin)
        if m:
            p["market"] = m
        return p

    # ---- round trips (SPEC §7 step 3) -------------------------------------------

    def round_trips(self, origin: str, dest: str, window_start: date, window_end: date) -> list[Offer]:
        offers: list[Offer] = []
        dep_months = _months(window_start, window_end)
        for dm in dep_months:
            for rm in [m for m in dep_months if m >= dm]:
                params = self._base(origin, dest) | {"departure_at": dm, "return_at": rm, "one_way": "false"}
                for row in self._get(params):
                    o = self.row_to_roundtrip(row, origin, dest)
                    if o:
                        offers.append(o)
        return offers

    def row_to_roundtrip(self, row: dict, origin: str, dest: str) -> Offer | None:
        if not row.get("return_at") or not row.get("price"):
            return None
        airline = row.get("airline")
        departure = _date(row["departure_at"])
        returning = _date(row["return_at"])
        from_airport = row.get("origin_airport") or origin
        to_airport = row.get("destination_airport") or dest
        link = affiliate_link(row.get("link"), self.marker)
        if link and _aviasales_roundtrip_link_matches(link, from_airport, to_airport, departure, returning) is False:
            link = None
        return Offer(
            origin=from_airport,
            destination=to_airport,
            depart_date=departure,
            return_date=returning,
            price_amount=float(row["price"]),
            price_currency=row["_currency"],
            source="travelpayouts",
            ticket_structure="roundtrip",
            outbound=Leg(
                depart_time=_hhmm(row.get("departure_at")),
                stops=row.get("transfers"),
                duration_min=row.get("duration_to"),
                airlines=[airline] if airline else [],
            ),
            inbound=Leg(
                depart_time=_hhmm(row.get("return_at")),
                stops=row.get("return_transfers"),
                duration_min=row.get("duration_back"),
                airlines=[airline] if airline else [],
            ),
            deeplink=link or aviasales_search_link(from_airport, to_airport, departure, returning, 1, self.marker),
        )

    # ---- one-ways for split-ticket check -----------------------------------------

    def one_ways(self, origin: str, dest: str, window_start: date, window_end: date) -> list[tuple[date, float, str, Leg, str | None]]:
        """Returns (date, price, currency, leg, deeplink) for each one-way fare found."""
        out = []
        for dm in _months(window_start, window_end):
            params = self._base(origin, dest) | {"departure_at": dm, "one_way": "true"}
            for row in self._get(params):
                if not row.get("price"):
                    continue
                airline = row.get("airline")
                leg = Leg(
                    depart_time=_hhmm(row.get("departure_at")),
                    stops=row.get("transfers"),
                    duration_min=row.get("duration_to") or row.get("duration"),
                    airlines=[airline] if airline else [],
                )
                out.append((_date(row["departure_at"]), float(row["price"]), row["_currency"], leg,
                            affiliate_link(row.get("link"), self.marker)))
        return out
