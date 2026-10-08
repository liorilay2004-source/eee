/**
 * GET /api/health: D1 liveness plus what is deployed. `status` and `db` answer "is it up" exactly as before; the rest
 * is informational and never turns a healthy answer into a failure:
 *   build             the commit and time of this deploy (scripts/gen-build-info.mjs, "unknown"/null without git)
 *   migration         the newest migration applied to D1 (wrangler's d1_migrations table), null when unreadable
 *   migrationsPending true when this code ships a migration D1 has not applied yet, null when unknown
 * At most two small D1 reads: the liveness probe and, only when it passed, the migration lookup.
 */
import { BUILD_SHA, BUILD_TIME } from "eee-build-info";

/**
 * Newest file in worker/migrations/ (the code expects its tables). test/health.test.ts fails when a new migration is
 * added without updating this.
 */
export const LATEST_BUNDLED_MIGRATION = "0011_public_trip_snapshots.sql";

export interface HealthBody {
  status: "ok" | "degraded";
  db: "ok" | "error";
  build: { sha: string; time: string | null };
  migration: string | null;
  migrationsPending: boolean | null;
}

const migrationNumber = (name: string): number | null => {
  const m = /^(\d{4})_/.exec(name);
  return m ? Number(m[1]) : null;
};

/** Pending = the bundled newest migration is numbered above the newest applied one. */
export function migrationsPending(applied: string | null, bundled: string = LATEST_BUNDLED_MIGRATION): boolean | null {
  if (applied === null) return null;
  const a = migrationNumber(applied);
  const b = migrationNumber(bundled);
  if (a === null || b === null) return null;
  return b > a;
}

export async function checkHealth(db: D1Database): Promise<{ status: number; body: HealthBody }> {
  const build = { sha: BUILD_SHA, time: BUILD_TIME };
  try {
    await db.prepare("SELECT 1 AS ok").first();
  } catch {
    return { status: 503, body: { status: "degraded", db: "error", build, migration: null, migrationsPending: null } };
  }
  let migration: string | null = null;
  try {
    const row = await db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: unknown }>();
    migration = typeof row?.name === "string" ? row.name : null;
  } catch {
    migration = null; // no d1_migrations table (a database set up by hand) must not fail health
  }
  return { status: 200, body: { status: "ok", db: "ok", build, migration, migrationsPending: migrationsPending(migration) } };
}
