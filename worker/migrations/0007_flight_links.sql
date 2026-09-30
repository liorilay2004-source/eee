-- Additive: user-pasted flight links. Stores a sanitized booking/search URL, its source site, and when the user checked it.
-- The client hash is salted in the Worker, never the raw IP. Raw secrets in URLs are stripped before insertion.

CREATE TABLE IF NOT EXISTS flight_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_hash  TEXT NOT NULL,
  url          TEXT NOT NULL,
  host         TEXT NOT NULL,
  source_id    TEXT,
  source_name  TEXT NOT NULL,
  origin       TEXT,
  destination  TEXT,
  depart_date  TEXT,
  return_date  TEXT,
  request_json TEXT,
  checked_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flight_links_client_checked ON flight_links(client_hash, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_flight_links_source_checked ON flight_links(source_id, checked_at DESC);
