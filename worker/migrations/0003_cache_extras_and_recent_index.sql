-- Additive. The search cache keeps the raw one-way fares and the scan notes beside the offers, so split
-- tickets are rebuilt for each request's own filters (hours, stops, bag) and a truncation note survives a hit.
-- NULL on rows written before this migration: those hits use the stored offers as they are.
ALTER TABLE search_cache ADD COLUMN extra_json TEXT;

-- Serves loadRecentOffers: the recent rows of one route. Without it the query walks the route's whole
-- price history on every request, cache hits included (D1 bills rows read).
CREATE INDEX IF NOT EXISTS idx_prices_recent ON prices(origin, destination, checked_at);
