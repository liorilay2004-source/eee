-- Additive. Hard request counters for the optional live fare sources (see src/quotes.ts).
-- One row per vendor and period: period is a UTC month such as 2026-09 for a monthly allowance,
-- or the fixed word lifetime for a one-off allowance (or when its nature is unknown).
-- used counts every request ever RESERVED, including ones that failed or timed out, so it can only overcount.
-- Rows are never deleted: pruneHistory does not touch this table, and the code never lowers used.
CREATE TABLE IF NOT EXISTS source_quota (
  source     TEXT NOT NULL,
  period     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, period)
);
