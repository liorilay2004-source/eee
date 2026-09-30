import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const sqlFiles = () => readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("every migration is named NNNN_name.sql", () => {
    const files = sqlFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("4-digit prefixes are unique and contiguous from 0001", () => {
    const prefixes = sqlFiles().map((f) => f.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const expected = prefixes.map((_, i) => String(i + 1).padStart(4, "0"));
    expect(prefixes).toEqual(expected);
  });
});
