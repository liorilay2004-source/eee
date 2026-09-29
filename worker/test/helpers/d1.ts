import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * In-memory D1-compatible shim on node:sqlite, for tests only (src/ must stay Workers-runtime clean).
 * Mirrors the D1 surface the Repo uses: prepare().bind().first()/all()/run()/raw(), batch() (atomic), exec().
 * Every worker/migrations/*.sql file is applied in name order at creation.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

type SqlValue = string | number | bigint | null | Uint8Array;

function toSqlValue(v: unknown, index: number): SqlValue {
  // D1 rejects undefined loudly; silently binding NULL would hide missing-field bugs in tests.
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (param ${index + 1})`);
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported (param ${index + 1})`);
}

interface RunOutcome {
  rows: Record<string, unknown>[];
  changes: number;
  lastRowId: number;
  rowsRead: number;
}

class ShimStatement {
  private params: SqlValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): ShimStatement {
    // D1 returns a new statement from bind(); reusing one prepared statement with different values must not alias.
    const next = new ShimStatement(this.db, this.query);
    next.params = values.map(toSqlValue);
    return next;
  }

  /** @internal executes synchronously so batch() can wrap several statements in one transaction. */
  execute(): RunOutcome {
    const stmt: StatementSync = this.db.prepare(this.query);
    let rows: Record<string, unknown>[] = [];
    let changes = 0;
    let lastRowId = 0;
    // Anything with result columns (SELECT, INSERT ... RETURNING) is read through all(), like D1.
    if (stmt.columns().length > 0) {
      rows = stmt.all(...this.params).map((r) => ({ ...r }));
      const meta = this.db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
      changes = /^\s*(insert|update|delete|replace)/i.test(this.query) ? meta.c : 0;
      lastRowId = meta.r;
    } else {
      const res = stmt.run(...this.params);
      changes = Number(res.changes);
      lastRowId = Number(res.lastInsertRowid);
    }
    return { rows, changes, lastRowId, rowsRead: rows.length };
  }

  private result<T>(o: RunOutcome): D1Result<T> {
    return {
      success: true,
      results: o.rows as T[],
      meta: {
        served_by: "test-shim",
        duration: 0,
        changes: o.changes,
        last_row_id: o.lastRowId,
        changed_db: o.changes > 0,
        size_after: 0,
        rows_read: o.rowsRead,
        rows_written: o.changes,
      },
    } as D1Result<T>;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.execute().rows[0];
    if (!row) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`D1_ERROR: No such column: ${colName}`);
    return row[colName] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.result<T>(this.execute());
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.result<T>(this.execute());
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.prepare(this.query);
    const names = stmt.columns().map((c) => c.name);
    const rows = stmt.all(...this.params).map((r) => names.map((n) => (r as Record<string, unknown>)[n]));
    return (options?.columnNames ? [names, ...rows] : rows) as T[];
  }
}

class ShimD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): ShimStatement {
    return new ShimStatement(this.db, query);
  }

  /** Like D1: all statements run in one transaction and roll back together on any error. */
  async batch<T = Record<string, unknown>>(statements: ShimStatement[]): Promise<D1Result<T>[]> {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) => s.execute());
      this.db.exec("COMMIT");
      return out.map((o) => ({
        success: true,
        results: o.rows as T[],
        meta: { served_by: "test-shim", duration: 0, changes: o.changes, last_row_id: o.lastRowId, changed_db: o.changes > 0, size_after: 0, rows_read: o.rowsRead, rows_written: o.changes },
      })) as D1Result<T>[];
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);
    return { count: query.split(";").filter((s) => s.trim() !== "").length, duration: 0 };
  }

  withSession(): unknown {
    return this;
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not supported by the test shim");
  }
}

/**
 * Fresh in-memory database with every migration applied in name order (0002_seed_airports.sql and later are
 * picked up when present, nothing breaks when they are absent). `migrationsDir` exists for testing the shim itself.
 */
export function createTestD1(migrationsDir: string = MIGRATIONS_DIR): D1Database {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  return new ShimD1(db) as unknown as D1Database;
}
