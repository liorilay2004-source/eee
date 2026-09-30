-- Additive: airline detected from a pasted flight link using the bundled airline reference dataset.

ALTER TABLE flight_links ADD COLUMN airline_iata TEXT;
ALTER TABLE flight_links ADD COLUMN airline_icao TEXT;
ALTER TABLE flight_links ADD COLUMN airline_name TEXT;

CREATE INDEX IF NOT EXISTS idx_flight_links_airline_checked ON flight_links(airline_iata, checked_at DESC);
