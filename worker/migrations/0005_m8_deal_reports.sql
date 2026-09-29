-- Additive. One precomputed deal report per watched route (src/dealreports.ts), written by the hourly snapshot
-- cron right after it scans that route and read by GET /api/deals. At most one row per route (upsert on route), so
-- the table stays as small as the watchlist and needs no retention job. report_json is the whole route report.
CREATE TABLE IF NOT EXISTS deal_reports (
  route       TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);
