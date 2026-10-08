/** Repository hygiene the SPEC asks for: no secrets in git (§14, §16) and a Workers-clean src/ tree. */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
    const assignments = text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
    for (const line of assignments) expect(line, line).toMatch(/^[A-Z_]+=$/);
    const names = assignments.map((l) => l.split("=")[0]);
    expect(names).toEqual(expect.arrayContaining(["TRAVELPAYOUTS_TOKEN", "TRAVELPAYOUTS_MARKER", "RATE_LIMIT_SALT"]));
  });

  it("lists the four OPTIONAL live-source secrets in .dev.vars.example (empty) and in the wrangler.toml secrets comment", () => {
    const optional = ["IGNAV_API_KEY", "WEGO_API_TOKEN", "SEARCHAPI_KEY", "SERPAPI_KEY"];
    const example = readFileSync(join(worker, ".dev.vars.example"), "utf8");
    const toml = readFileSync(join(worker, "wrangler.toml"), "utf8");
    for (const name of optional) {
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
      expect(toml, name).toContain(name);
    }
    expect(example).toMatch(/NEVER add a payment card/);
    expect(toml).toMatch(/NEVER with a payment card/);
  });

  it("declares the four optional live-source secrets as optional in the Env type", () => {
    const types = readFileSync(join(worker, "src", "types.ts"), "utf8");
    for (const name of ["IGNAV_API_KEY", "WEGO_API_TOKEN", "SEARCHAPI_KEY", "SERPAPI_KEY"]) expect(types, name).toMatch(new RegExp(`\\b${name}\\?: string`));
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

  it("the vendor path never logs: no console in quotes.ts or any adapter (a SerpApi key sits in its request URL)", () => {
    const vendorFiles = [join(worker, "src", "quotes.ts"), ...sourceFiles(join(worker, "src", "sources"))];
    expect(vendorFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of vendorFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bconsole\b/);
  });

  it("only quotes.ts and wego.ts can reach fetch: the other adapters describe a request and read an answer, nothing more", () => {
    const callsFetch = (file: string) => /\bfetch\s*\(/.test(readFileSync(file, "utf8"));
    const adapters = sourceFiles(join(worker, "src", "sources"));
    expect(adapters.map((f) => basename(f)).sort()).toEqual(["aegean-published.ts", "aerlingus-published.ts", "aeromexico-cached.ts", "airbaltic-published.ts", "aircanada-published.ts", "aireuropa-published.ts", "airnz-published.ts", "airserbia-direct.ts", "american-published.ts", "copa-cached.ts", "direct-combination.ts", "duffel.ts", "ethiopian-published.ts", "gol-published.ts", "hasdata.ts", "ignav.ts", "klm-cached.ts", "philippine-published.ts", "published-fares.ts", "published-source.ts", "ryanair-direct.ts", "searchapi.ts", "serpapi.ts", "skyexpress-published.ts", "tap-published.ts", "virgin-published.ts", "wego.ts"]);
    for (const file of adapters) expect(callsFetch(file), file).toBe(file.endsWith("wego.ts"));
    expect(callsFetch(join(worker, "src", "quotes.ts"))).toBe(true);
  });
});

describe("match_audit stays PII-free and costs nothing (audit.ts)", () => {
  it("audit.ts reads no request, header, link or binding, copies nothing with a spread and makes no request", () => {
    const text = readFileSync(join(worker, "src", "audit.ts"), "utf8");
    expect(text).not.toMatch(/\breq\b/);
    expect(text).not.toContain("headers");
    expect(text).not.toMatch(/cf-connecting-ip/i);
    expect(text).not.toMatch(/user-agent/i);
    expect(text).not.toContain("deeplink");
    expect(text).not.toContain("marker");
    expect(text).not.toContain("...");
    expect(text).not.toContain("fetch(");
    expect(text).not.toContain("env.");
  });

  it("Workers Logs stays off in wrangler.toml; the owner-only switch is documented, off by default", () => {
    const toml = readFileSync(join(worker, "wrangler.toml"), "utf8");
    // Comment lines never count: only a live [observability] table with enabled = true would turn the logs on.
    const live = toml.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(live).not.toMatch(/^\s*\[observability(\.[a-z_]+)?\]\s*$[\s\S]*?^\s*enabled\s*=\s*true/m);
    const docs = readFileSync(join(repoRoot, "docs", "CLOUDFLARE_SETUP.md"), "utf8");
    expect(docs).toContain("Workers Logs (optional)");
    expect(docs).toContain("head_sampling_rate");
    expect(docs).toMatch(/off by default/i);
    expect(docs).not.toMatch(/Workers Logs[^\n]*VERIFIED/);
  });
});
