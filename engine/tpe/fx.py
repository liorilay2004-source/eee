"""FX to ILS (SPEC §4.2): Bank of Israel official rates, fallback open.er-api.com.

Original amounts are never overwritten; conversion happens only for display/comparison.
"""

from __future__ import annotations

import requests

BOI_URL = "https://boi.org.il/PublicApi/GetExchangeRates"
FALLBACK_URL = "https://open.er-api.com/v6/latest/ILS"


class FxRates:
    def __init__(self, rates_to_ils: dict[str, float], source: str):
        self.rates = {"ILS": 1.0, **{k.upper(): v for k, v in rates_to_ils.items()}}
        self.source = source

    def to_ils(self, amount: float, currency: str) -> float:
        cur = currency.upper()
        if cur not in self.rates:
            raise KeyError(f"No FX rate for {cur}")
        return amount * self.rates[cur]

    @classmethod
    def fetch(cls, http: requests.Session | None = None) -> "FxRates":
        http = http or requests.Session()
        try:
            r = http.get(BOI_URL, timeout=20)
            r.raise_for_status()
            rates = {
                x["key"]: float(x["currentExchangeRate"]) / float(x.get("unit") or 1)
                for x in r.json()["exchangeRates"]
            }
            if "USD" in rates:
                return cls(rates, "bank_of_israel")
        except Exception:
            pass
        r = http.get(FALLBACK_URL, timeout=20)
        r.raise_for_status()
        per_ils = r.json()["rates"]  # units of X per 1 ILS
        return cls({k: 1.0 / v for k, v in per_ils.items() if v}, "open.er-api.com")
