/**
 * Scheduled price snapshots. Deal detection (error fares, unusual drops) needs our own price history, because the
 * Travelpayouts cache only remembers a few days. Every hour one route of a fixed watchlist goes through the normal
 * search pipeline, which appends the fresh fares to the `prices` table (and warms the cache). One route per run keeps
 * a run inside the Workers Free subrequest limit, and 24 runs a day cost roughly 24 x 190 D1 row writes, a small part
 * of the daily write allowance.
 */
import { PipelineError, runSearch } from "./pipeline";
import type { SearchDeps } from "./pipeline";
import type { SearchRequest } from "./types";

/** [origin, destination]: city or airport IATA codes as the pipeline expects them. Eilat (ETM) is here to measure its coverage. */
export const SNAPSHOT_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["TLV", "BCN"], ["TLV", "ATH"], ["TLV", "LON"], ["TLV", "PAR"], ["TLV", "ROM"], ["TLV", "IST"],
  ["TLV", "BKK"], ["TLV", "NYC"], ["TLV", "AMS"], ["TLV", "BER"], ["TLV", "MIL"], ["TLV", "MAD"],
  ["TLV", "LIS"], ["TLV", "PRG"], ["TLV", "BUD"], ["TLV", "VIE"], ["TLV", "LCA"], ["TLV", "SOF"],
  ["TLV", "TBS"], ["TLV", "DXB"], ["TLV", "ZRH"], ["TLV", "MUC"], ["ETM", "ATH"], ["ETM", "BUD"],
];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The route of the hour: deterministic, so every route is visited once per len(routes) hours. */
export function pickSnapshotRoute(now: Date, routes: ReadonlyArray<readonly [string, string]> = SNAPSHOT_ROUTES): readonly [string, string] {
  const slot = Math.floor(now.getTime() / HOUR_MS);
  return routes[((slot % routes.length) + routes.length) % routes.length] as readonly [string, string];
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A wide, ordinary search: 2 to 12 weeks ahead, 4 to 8 nights, one adult, economy, no time preferences. */
export function buildSnapshotRequest(origin: string, destination: string, now: Date): SearchRequest {
  const start = now.getTime() + 14 * DAY_MS;
  return {
    origin,
    destination,
    windowStart: iso(start),
    windowEnd: iso(start + 60 * DAY_MS),
    stayMin: 4,
    stayMax: 8,
    adults: 1,
    children: 0,
    infants: 0,
    cabin: "economy",
    checkedBag: false,
    outHours: null,
    retHours: null,
    maxStops: null,
    nearbyAirports: false,
  };
}

export interface SnapshotResult {
  route: string;
  ok: boolean;
  cards: number;
}

/** Runs the hour's snapshot. Never throws: a failing route must not stop the next hour's run. */
export async function runSnapshot(deps: SearchDeps, routes: ReadonlyArray<readonly [string, string]> = SNAPSHOT_ROUTES): Promise<SnapshotResult> {
  const [origin, destination] = pickSnapshotRoute(deps.now, routes);
  const route = `${origin}-${destination}`;
  if (!deps.tp.configured) return { route, ok: false, cards: 0 };
  try {
    const res = await runSearch({ ...deps, waitUntil: undefined, audit: false }, buildSnapshotRequest(origin, destination, deps.now));
    return { route, ok: true, cards: res.cards.length };
  } catch (err) {
    console.error(`snapshot ${route} failed:`, err instanceof PipelineError ? err.code : err instanceof Error ? err.name : typeof err);
    return { route, ok: false, cards: 0 };
  }
}
