/** Repository hygiene the SPEC asks for: no secrets in git (§14, §16) and a Workers-clean src/ tree. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "..");
const repoRoot = join(worker, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** The .gitignore lines that matter, comments and blanks dropped. */
const ignoreLines = () => readFileSync(join(repoRoot, ".gitignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

describe("secrets stay out of git", () => {
  it("ignores Wrangler's local secrets file (.dev.vars) and its variants, but not the example", () => {
    const lines = ignoreLines();
    expect(lines).toContain(".dev.vars");
    expect(lines).toContain(".dev.vars.*");
    expect(lines.indexOf("!.dev.vars.example")).toBeGreaterThan(lines.indexOf(".dev.vars.*")); // a negation only works after the rule it undoes
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
  });

  it("ignores the vitest output directory (it holds absolute local paths)", () => {
    expect(ignoreLines()).toContain(".vitest/");
  });

  it("ships .dev.vars.example with every value empty and every secret the Worker reads listed", () => {
    const text = readFileSync(join(worker, ".dev.vars.example"), "utf8");
    const assignments = text.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    for (const line of assignments) expect(line, line).toMatch(/^[A-Z_]+=$/);
    const names = assignments.map((l) => l.split("=")[0]);
    expect(names).toEqual(expect.arrayContaining(["TRAVELPAYOUTS_TOKEN", "TRAVELPAYOUTS_MARKER", "RATE_LIMIT_SALT"]));
  });

  it("wrangler.toml holds no secret values and schedules the retention job", () => {
    const toml = readFileSync(join(worker, "wrangler.toml"), "utf8");
    expect(toml).toMatch(/^\[triggers\]\s*\ncrons = \[".+"\]/m);
    expect(toml).not.toMatch(/TOKEN\s*=|SALT\s*=|SECRET\s*=|KEY\s*=/);
  });
});

describe("src/ runs in the Workers runtime", () => {
  it("imports nothing from node:, and uses no Node globals", () => {
    for (const file of sourceFiles(join(worker, "src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["']node:|require\(["']node:|\bprocess\.(env|argv|cwd)|\bBuffer\./);
    }
  });
});
