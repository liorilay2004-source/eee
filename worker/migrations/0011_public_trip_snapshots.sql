CREATE TABLE IF NOT EXISTS public_trip_snapshots (
 source TEXT NOT NULL,
 origin TEXT NOT NULL,
 destination TEXT NOT NULL,
 depart_date TEXT NOT NULL,
 return_date TEXT NOT NULL,
 fare_json TEXT NOT NULL,
 checked_at TEXT NOT NULL,
 PRIMARY KEY (source,origin,destination,depart_date,return_date)
);

CREATE INDEX IF NOT EXISTS idx_searches_collection_route
 ON searches(origin,destination,created_at);
