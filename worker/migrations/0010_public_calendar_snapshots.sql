-- Monthly public calendar data for background collectors, without passenger or account data.
CREATE TABLE IF NOT EXISTS public_calendar_snapshots (
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  month TEXT NOT NULL,
  fares_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(source, origin, destination, month)
);
