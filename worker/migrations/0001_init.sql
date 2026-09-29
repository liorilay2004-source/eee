-- Schema of SPEC section 12 plus two additive tables (search_cache, rate_limits).
-- D1 applies migration files statement by statement: plain SQL only, and no
-- semicolons inside comments or string literals.
-- Dates are ISO YYYY-MM-DD text, timestamps are canonical UTC ISO-8601 text
-- (so string order equals time order). Booleans are 0/1 integers.
-- Money is always stored as the ORIGINAL amount + ORIGINAL currency (SPEC 4.2).

CREATE TABLE IF NOT EXISTS airports (
  iata         TEXT PRIMARY KEY,
  city_iata    TEXT,
  name_en      TEXT,
  city_en      TEXT,
  city_he      TEXT,
  country_code TEXT,
  lat          REAL,
  lon          REAL,
  popularity   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_airports_city_iata ON airports(city_iata);

CREATE TABLE IF NOT EXISTS fx_rates (
  date        TEXT NOT NULL,
  currency    TEXT NOT NULL,
  rate_to_ils REAL NOT NULL,
  source      TEXT NOT NULL,
  PRIMARY KEY (date, currency)
);

CREATE TABLE IF NOT EXISTS bag_fees (
  airline_iata   TEXT NOT NULL,
  bag_type       TEXT NOT NULL,
  price_amount   REAL NOT NULL,
  price_currency TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  note           TEXT,
  PRIMARY KEY (airline_iata, bag_type)
);

-- search_key is not in the SPEC column list: watches reference searches through it.
CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  search_key   TEXT NOT NULL,
  origin       TEXT NOT NULL,
  destination  TEXT,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  stay_min     INTEGER NOT NULL,
  stay_max     INTEGER NOT NULL,
  pax_json     TEXT NOT NULL,
  cabin        TEXT NOT NULL,
  extras_json  TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  user_id      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_searches_key ON searches(search_key);

-- verify_link is not in the SPEC column list: kept so Offer.verifyLink round-trips.
CREATE TABLE IF NOT EXISTS prices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  origin           TEXT NOT NULL,
  destination      TEXT NOT NULL,
  depart_date      TEXT NOT NULL,
  return_date      TEXT NOT NULL,
  price_amount     REAL NOT NULL,
  price_currency   TEXT NOT NULL,
  source           TEXT NOT NULL,
  ticket_structure TEXT NOT NULL,
  airlines_json    TEXT NOT NULL,
  legs_json        TEXT NOT NULL,
  includes_json    TEXT NOT NULL,
  deeplink         TEXT,
  verify_link      TEXT,
  checked_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prices_route
  ON prices(origin, destination, depart_date, return_date, checked_at);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL UNIQUE,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_key          TEXT NOT NULL,
  threshold_ils       REAL,
  drop_pct            REAL NOT NULL DEFAULT 10,
  active              INTEGER NOT NULL DEFAULT 1,
  expires_at          TEXT NOT NULL,
  last_price_amount   REAL,
  last_price_currency TEXT,
  last_alert_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(active, expires_at);

CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id       INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  price_amount   REAL NOT NULL,
  price_currency TEXT NOT NULL,
  sent_email     INTEGER NOT NULL DEFAULT 0,
  seen_in_app    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_watch ON alerts(watch_id, created_at);

CREATE TABLE IF NOT EXISTS source_health (
  source               TEXT PRIMARY KEY,
  last_ok_at           TEXT,
  last_error_at        TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Additive: live-search result cache, one row per search_key (SPEC 7 step 2).
CREATE TABLE IF NOT EXISTS search_cache (
  search_key  TEXT PRIMARY KEY,
  offers_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache(created_at);

-- Additive: fixed-window per-key request counters (SPEC 14). window_start is unix seconds.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
