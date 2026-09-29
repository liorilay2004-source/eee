"""Runtime configuration. All tunables come from /config/*.json or env vars."""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"


def _load(name: str) -> dict:
    with open(CONFIG_DIR / name, encoding="utf-8") as f:
        return json.load(f)


PROJECT = _load("project.json")
PROJECT_NAME: str = PROJECT["name"]

SCORING = _load("scoring.json")
BAG_FEES = _load("bag_fees.json")["fees"]


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def enable_fast_flights() -> bool:
    return env_flag("ENABLE_FAST_FLIGHTS", True)


# Travelpayouts `market` by origin country (SPEC §7 step 3). Unknown -> omitted.
MARKET_BY_COUNTRY = {"IL": "il", "US": "us", "GB": "uk", "DE": "de", "FR": "fr", "ES": "es", "IT": "it"}

# Minimal airport->country table for Phase 0; replaced by the D1 airports table in Phase 1.
AIRPORT_COUNTRY = {
    "TLV": "IL", "ETM": "IL", "SDV": "IL", "HFA": "IL",
    "BCN": "ES", "GRO": "ES", "REU": "ES", "MAD": "ES",
    "FCO": "IT", "MXP": "IT", "ATH": "GR", "LCA": "CY", "PFO": "CY",
    "LHR": "GB", "LTN": "GB", "CDG": "FR", "ORY": "FR", "BER": "DE",
    "JFK": "US", "EWR": "US",
}

# Nearby airports (SPEC §7 layer 4). Opt-in only.
NEARBY_AIRPORTS = {
    "BCN": ["GRO", "REU"],
    "TLV": [],
    "LHR": ["LGW", "STN", "LTN"],
    "CDG": ["ORY", "BVA"],
    "FCO": ["CIA"],
    "MXP": ["LIN", "BGY"],
}

# Hebrew city names; Phase 1 moves this into the D1 airports table (~500 cities).
CITY_HE = {
    "TLV": "תל אביב", "ETM": "אילת", "BCN": "ברצלונה", "GRO": "ג'ירונה", "REU": "ראוס",
    "MAD": "מדריד", "FCO": "רומא", "MXP": "מילאנו", "ATH": "אתונה", "LCA": "לרנקה",
    "PFO": "פאפוס", "LHR": "לונדון", "LTN": "לונדון", "CDG": "פריז", "ORY": "פריז",
    "BER": "ברלין", "JFK": "ניו יורק", "EWR": "ניו יורק",
}

CURRENCY_SYMBOL = {"ILS": "₪", "USD": "$", "EUR": "€", "GBP": "£"}
