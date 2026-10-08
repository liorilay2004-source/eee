-- Browser-shared airline observations are unverified and kept separate from ranked offers.
-- client_hash is a salted IP pseudonym used only for deduplication and write limits.
CREATE TABLE IF NOT EXISTS community_fares (
  client_hash  TEXT NOT NULL,
  host         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  depart_date  TEXT NOT NULL,
  return_date  TEXT NOT NULL,
  price_amount REAL NOT NULL,
  currency     TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  PRIMARY KEY(client_hash, host, origin, destination, depart_date, return_date)
);

CREATE INDEX IF NOT EXISTS idx_community_fares_route_dates
  ON community_fares(origin, destination, depart_date, return_date, observed_at DESC);
