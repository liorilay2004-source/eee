/** GET /api/health: the original {status, db} contract plus the additive build / migration fields. */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index";
import { checkHealth, LATEST_BUNDLED_MIGRATION, migrationsPending } from "../src/health";
import type { Env } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Wraps a D1 so that statements matching `failOn` throw (like D1 on a missing table or a dead binding). */
function failing(db: D1Database, failOn: RegExp, counter?: { n: number }): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        if (counter) counter.n++;
        if (failOn.test(sql)) throw new Error("D1_ERROR: no such table");
        return target.prepare(sql);
      };
    },
  });
}

async function withMigrations(names: string[]): Promise<D1Database> {
  const db = createTestD1();
  await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const n of names) await db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(n).run();
  return db;
}

const call = (db: D1Database) =>
  worker.fetch(new Request("https://api.example.test/api/health"), { DB: db } as unknown as Env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

describe("GET /api/health", () => {
  it("reports the newest applied migration and nothing pending when D1 is up to date", async () => {
    const db = await withMigrations(["0001_init.sql", "0005_m8_deal_reports.sql", LATEST_BUNDLED_MIGRATION]);
    const res = await call(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { build: unknown };
    expect(body).toMatchObject({ status: "ok", db: "ok", migration: LATEST_BUNDLED_MIGRATION, migrationsPending: false });
    expect(body.build).toEqual({ sha: "unknown", time: null }); // tests use the stand-in, not a generated file
  });

  it("flags pending migrations when D1 is behind the bundled code", async () => {
    const { body } = await checkHealth(await withMigrations(["0001_init.sql", "0004_source_quota.sql"]));
    expect(body).toMatchObject({ status: "ok", db: "ok", migration: "0004_source_quota.sql", migrationsPending: true });
  });

  it("a failing migration query gives null fields and never fails health", async () => {
    const counter = { n: 0 };
    const db = failing(createTestD1(), /d1_migrations/, counter);
    const res = await call(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "ok", migration: null, migrationsPending: null });
    expect(counter.n).toBe(2); // liveness + one migration read, nothing more
  });

  it("an empty d1_migrations table gives null, not an error", async () => {
    const { status, body } = await checkHealth(await withMigrations([]));
    expect(status).toBe(200);
    expect(body).toMatchObject({ db: "ok", migration: null, migrationsPending: null });
  });

  it("a dead database is still 503 degraded, and skips the migration read", async () => {
    const counter = { n: 0 };
    const res = await call(failing(createTestD1(), /./, counter));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", db: "error", migration: null, migrationsPending: null });
    expect(counter.n).toBe(1);
  });
});

describe("migration bookkeeping", () => {
  it("LATEST_BUNDLED_MIGRATION is the newest file in worker/migrations/", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(LATEST_BUNDLED_MIGRATION).toBe(files[files.length - 1]);
  });

  it("migrationsPending compares migration numbers", () => {
    expect(migrationsPending("0006_x.sql", "0006_x.sql")).toBe(false);
    expect(migrationsPending("0005_x.sql", "0006_y.sql")).toBe(true);
    expect(migrationsPending("0007_newer.sql", "0006_y.sql")).toBe(false); // D1 ahead of an older deploy
    expect(migrationsPending(null)).toBeNull();
    expect(migrationsPending("weird", "0006_y.sql")).toBeNull();
  });
});
