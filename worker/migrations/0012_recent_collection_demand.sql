CREATE INDEX IF NOT EXISTS idx_searches_collection_recent
 ON searches(created_at DESC);
