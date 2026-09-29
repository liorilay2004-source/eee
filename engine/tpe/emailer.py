"""Email behind a tiny interface (SPEC §6). Phase 0 provider: Resend (free tier)."""

from __future__ import annotations

import os
from typing import Protocol

import requests


class Emailer(Protocol):
    def send(self, to: str, subject: str, html: str, text: str) -> str: ...


class ResendEmailer:
    API = "https://api.resend.com/emails"

    def __init__(self, api_key: str, sender: str):
        self.api_key = api_key
        self.sender = sender

    def send(self, to: str, subject: str, html: str, text: str) -> str:
        r = requests.post(
            self.API,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"from": self.sender, "to": [to], "subject": subject, "html": html, "text": text},
            timeout=30,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Resend HTTP {r.status_code}: {r.text[:200]}")
        return r.json().get("id", "")


def from_env() -> tuple[Emailer | None, str | None]:
    key, to = os.environ.get("RESEND_API_KEY"), os.environ.get("OWNER_EMAIL")
    if not key or not to:
        return None, None
    return ResendEmailer(key, os.environ.get("EMAIL_FROM") or "onboarding@resend.dev"), to
